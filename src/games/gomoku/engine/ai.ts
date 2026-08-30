// 五子棋 AI：纯函数搜索，完全确定（无随机、无 DOM 依赖），规格见 docs/games/gomoku.md 第一节。
// 三档难度：
// - easy   启发式单步：己方成五必落 > 对方成五必堵 > 攻防评分最高点（基于邻域连子计数）。
// - medium α-β 深度 2：候选点 = 切比雪夫距离 ≤2 内有子的空点，按启发分排序取前 12。
// - hard   α-β 深度 4 + 迭代加深（2 → 4）：候选同上取前 10；根节点必杀/必防硬规则优先：
//          成五 > 堵对方成五 > 己方活四 > 堵对方活四 > 冲四/活三评估。
// 评估：连子模式计分（活四 ≫ 冲四/活三 ≫ 眠三 …），攻防合分（己方系数 1 略高于对方 0.9）。
// 限策：节点预算为主（确定性），约 2s 墙钟仅作极端情况兜底；超限返回当前已找到的最优步。
// Worker gomoku.ai.worker.ts 只做消息薄封装，全部搜索逻辑都在本文件。
import { CELLS, SIZE, type Player, type Status } from './gomoku';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 求解入参：GomokuState 结构兼容（board/current/status），Worker 侧可按同构对象重建 */
export interface AiPosition {
  board: Int8Array;
  current: Player;
  status: Status;
}

export interface AiResult {
  /** 落点 idx；终局（已分胜负 / 和棋）时为 -1 */
  move: number;
  /** 本次求解展开的搜索节点数（诊断用） */
  nodes: number;
}

const MEDIUM_DEPTH = 2;
const HARD_DEPTH = 4;
/** 每层候选点数量上限（规格书定值）：中等前 12，困难前 10 */
const MEDIUM_BRANCH = 12;
const HARD_BRANCH = 10;
/** 搜索节点预算（确定性主限策；正常远在墙钟之前结束） */
const NODE_BUDGET = 150_000;
/** 墙钟兜底（毫秒）：规格单步 ≤2s，预留消息传输余量 */
const DEADLINE_MS = 1900;
const INF = Number.POSITIVE_INFINITY;
/** 搜索中的必胜值（远高于任何评估分；减 ply 使 AI 偏好更快取胜） */
const SEARCH_WIN = 100_000_000;
/** 天元 (7,7)：空盘首步落点 */
const CENTER_IDX = ((SIZE - 1) >> 1) * SIZE + ((SIZE - 1) >> 1);

// ---------------------------------------------------------------- 连子模式分值

// 层级关系（规格书）：活四 ≫ 冲四/活三 ≫ 眠三 …，具体数值自定
const SCORE_FIVE = 10_000_000; // 五连（搜索内另用 SEARCH_WIN 精确表达必胜）
const SCORE_OPEN_FOUR = 1_000_000; // 活四（两个成五点，必胜）
const SCORE_RUSH_FOUR = 24_000; // 冲四（一个成五点，含跳四）
const SCORE_OPEN_THREE = 20_000; // 活三（含跳活三，下一手可成活四）
const SCORE_SLEEP_THREE = 3_000; // 眠三
const SCORE_OPEN_TWO = 1_500; // 活二
const SCORE_SLEEP_TWO = 250; // 眠二
const SCORE_ONE = 30; // 孤子（两端皆空）
/** 评估攻防合分系数：己方 1，对方 0.9（己方略高，规格书） */
const OPP_WEIGHT = 0.9;

// ---------------------------------------------------------------- 预计算几何表

/** 四个连珠方向 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** NEAR2[i]：切比雪夫距离 ≤2 的界内格子（不含自身），用于候选点判定 */
const NEAR2: Int32Array[] = (() => {
  const out: Int32Array[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const list: number[] = [];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) list.push(rr * SIZE + cc);
        }
      }
      out.push(Int32Array.from(list));
    }
  }
  return out;
})();

// ---------------------------------------------------------------- 连子形状分级

/**
 * 极大连子形状分级（len ≥ 1）。参数由 scoreRunAt 统一提取：
 * - endL/endR：连子两端是否为空格；
 * - gapL/gapR：端点为空时，跳过该空格之后连续己方子的个数（端点被堵时恒 0）；
 * - beyondL/beyondR：端点为空时，跳格之外那格的状态（0 空 / 1 己方 / 2 对方或边界；端点被堵时 -1）。
 *
 * 核心概念是"成五点"个数：len ≥ 4 时的空端（落子即 ≥5 连）与跳五点（端点空且 gap 足够长，
 * 在跳格落子可合并成 ≥5 连，自由规则长连也算胜）。成五点 ≥2 ⇒ 活四强度；=1 ⇒ 冲四强度。
 */
function shapeScore(
  len: number,
  endL: boolean,
  beyondL: number,
  gapL: number,
  endR: boolean,
  beyondR: number,
  gapR: number,
): number {
  if (len >= 5) return SCORE_FIVE;
  const fivePts =
    (len >= 4 && endL ? 1 : 0) +
    (len >= 4 && endR ? 1 : 0) +
    (endL && gapL >= 1 && gapL + 1 + len >= 5 ? 1 : 0) +
    (endR && gapR >= 1 && gapR + 1 + len >= 5 ? 1 : 0);
  if (len === 4) {
    return fivePts >= 2 ? SCORE_OPEN_FOUR : fivePts === 1 ? SCORE_RUSH_FOUR : 0;
  }
  if (len === 3) {
    if (fivePts >= 2) return SCORE_OPEN_FOUR;
    if (fivePts === 1) return SCORE_RUSH_FOUR; // 跳四：如 p _ p p p，跳格成五
    if (endL && endR) {
      // 两端皆空：一侧延伸后两端仍空（更外侧为空）即活三，否则眠三
      return beyondL === 0 || beyondR === 0 ? SCORE_OPEN_THREE : SCORE_SLEEP_THREE;
    }
    return endL || endR ? SCORE_SLEEP_THREE : 0;
  }
  if (len === 2) {
    if (fivePts >= 1) return SCORE_RUSH_FOUR; // 跳五：如 p p _ p p，缺口成五
    if ((endL && gapL >= 1) || (endR && gapR >= 1)) return SCORE_OPEN_THREE; // 跳活三
    if (endL && endR) {
      return beyondL === 0 || beyondR === 0 ? SCORE_OPEN_TWO : SCORE_SLEEP_TWO;
    }
    return endL || endR ? SCORE_SLEEP_TWO : 0;
  }
  return endL && endR ? SCORE_ONE : 0;
}

/**
 * 连子形状分：board 上以 (sr,sc) 为起点、方向 (dr,dc)、长度 len 的极大连子（颜色 p）。
 * 前提：连子两端那格都不是 p（极大性），由调用方保证。
 */
function scoreRunAt(
  board: Int8Array,
  sr: number,
  sc: number,
  dr: number,
  dc: number,
  len: number,
  p: number,
): number {
  const er = sr + len * dr;
  const ec = sc + len * dc;
  const endL = isEmptyAt(board, sr - dr, sc - dc);
  const endR = isEmptyAt(board, er, ec);
  let gapL = 0;
  let beyondL = -1;
  if (endL) {
    gapL = contRun(board, sr - 2 * dr, sc - 2 * dc, -dr, -dc, p);
    beyondL = gapL >= 1 ? 1 : isEmptyAt(board, sr - 2 * dr, sc - 2 * dc) ? 0 : 2;
  }
  let gapR = 0;
  let beyondR = -1;
  if (endR) {
    gapR = contRun(board, er + dr, ec + dc, dr, dc, p);
    beyondR = gapR >= 1 ? 1 : isEmptyAt(board, er + dr, ec + dc) ? 0 : 2;
  }
  return shapeScore(len, endL, beyondL, gapL, endR, beyondR, gapR);
}

function isEmptyAt(board: Int8Array, r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === 0;
}

/** 从 (r,c) 沿 (dr,dc) 方向的连续 p 子个数（起点是否为 p 由调用场景决定） */
function contRun(board: Int8Array, r: number, c: number, dr: number, dc: number, p: number): number {
  let n = 0;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === p) {
    n++;
    r += dr;
    c += dc;
  }
  return n;
}

// ---------------------------------------------------------------- 单点评分（落子视角）

/**
 * 前提：board[m] === p（假想落子已写入）。m 所在连子沿 4 个方向的形状分之和 = 此点的进攻价值。
 */
function placementScore(board: Int8Array, m: number, p: number): number {
  const r0 = Math.floor(m / SIZE);
  const c0 = m % SIZE;
  let s = 0;
  for (const [dr, dc] of DIRS) {
    s += runScoreThroughDir(board, r0, c0, dr, dc, p);
  }
  return s;
}

/** 前提：board[m] === p。包含 (r0,c0) 的极大连子沿 (dr,dc) 方向的形状分 */
function runScoreThroughDir(
  board: Int8Array,
  r0: number,
  c0: number,
  dr: number,
  dc: number,
  p: number,
): number {
  // 回溯到连子起点
  let sr = r0;
  let sc = c0;
  for (;;) {
    const pr = sr - dr;
    const pc = sc - dc;
    if (pr < 0 || pr >= SIZE || pc < 0 || pc >= SIZE || board[pr * SIZE + pc] !== p) break;
    sr = pr;
    sc = pc;
  }
  let len = 0;
  let rr = sr;
  let cc = sc;
  while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr * SIZE + cc] === p) {
    len++;
    rr += dr;
    cc += dc;
  }
  return scoreRunAt(board, sr, sc, dr, dc, len, p);
}

/** 假想 p 落在空点 m 的攻分（临时落子后复原，确定性纯计算） */
function pointScore(board: Int8Array, m: number, p: number): number {
  board[m] = p;
  const s = placementScore(board, m, p);
  board[m] = 0;
  return s;
}

/** 前提：board[m] === p。此子是否已构成五连（自由规则：≥5 即胜） */
function isFiveAt(board: Int8Array, m: number, p: number): boolean {
  const r0 = Math.floor(m / SIZE);
  const c0 = m % SIZE;
  for (const [dr, dc] of DIRS) {
    const len =
      1 +
      contRun(board, r0 + dr, c0 + dc, dr, dc, p) +
      contRun(board, r0 - dr, c0 - dc, -dr, -dc, p);
    if (len >= 5) return true;
  }
  return false;
}

/** 前提：board[m] === p。此子是否构成活四（含两个成五点的四） */
function hasOpenFourAt(board: Int8Array, m: number, p: number): boolean {
  const r0 = Math.floor(m / SIZE);
  const c0 = m % SIZE;
  for (const [dr, dc] of DIRS) {
    if (runScoreThroughDir(board, r0, c0, dr, dc, p) === SCORE_OPEN_FOUR) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 全盘评估

/**
 * 全盘连子模式计分：扫描 4 个方向的所有完整线，对每条极大连子做形状分级后累加。
 * 一次遍历同时累计黑白两方，返回 [黑分, 白分]。
 */
function patternScores(board: Int8Array): [number, number] {
  let s1 = 0;
  let s2 = 0;
  for (const [dr, dc] of DIRS) {
    // 枚举该方向每条线的线首（反方向出界的位置）
    for (let r0 = 0; r0 < SIZE; r0++) {
      for (let c0 = 0; c0 < SIZE; c0++) {
        const ar = r0 - dr;
        const ac = c0 - dc;
        if (ar >= 0 && ar < SIZE && ac >= 0 && ac < SIZE) continue; // 非线首
        let r = r0;
        let c = c0;
        while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
          const v = board[r * SIZE + c];
          if (v === 0) {
            r += dr;
            c += dc;
            continue;
          }
          const qr = r - dr;
          const qc = c - dc;
          if (qr >= 0 && qr < SIZE && qc >= 0 && qc < SIZE && board[qr * SIZE + qc] === v) {
            r += dr; // 连子中段（起点已计过）
            c += dc;
            continue;
          }
          let len = 0;
          let rr = r;
          let cc = c;
          while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr * SIZE + cc] === v) {
            len++;
            rr += dr;
            cc += dc;
          }
          const sc = scoreRunAt(board, r, c, dr, dc, len, v);
          if (v === 1) s1 += sc;
          else s2 += sc;
          r = rr;
          c = cc;
        }
      }
    }
  }
  return [s1, s2];
}

/** 叶子评估（行棋方视角）：己方模式分 − 对方模式分 × 0.9（攻防合分，己方系数略高） */
function evaluate(board: Int8Array, player: number): number {
  const [s1, s2] = patternScores(board);
  return player === 1 ? s1 - OPP_WEIGHT * s2 : s2 - OPP_WEIGHT * s1;
}

// ---------------------------------------------------------------- 候选点

function hasStoneNear2(board: Int8Array, i: number): boolean {
  const nbs = NEAR2[i];
  for (let k = 0; k < nbs.length; k++) {
    if (board[nbs[k]] !== 0) return true;
  }
  return false;
}

/** 候选点：切比雪夫距离 ≤2 内有棋子的空点（规格书定义） */
function genCandidates(board: Int8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === 0 && hasStoneNear2(board, i)) out.push(i);
  }
  return out;
}

/**
 * 候选点按攻防启发分（己方落此点攻分 + 对方落此点攻分）降序排序，
 * 同分取 idx 小者（完全确定），截取前 limit 个。成五/堵五点分值最高，天然排在最前。
 */
function orderedCandidates(board: Int8Array, player: number, limit: number): number[] {
  const opp = 3 - player;
  const scored: Array<{ m: number; s: number }> = [];
  for (const m of genCandidates(board)) {
    scored.push({ m, s: pointScore(board, m, player) + pointScore(board, m, opp) });
  }
  scored.sort((a, b) => b.s - a.s || a.m - b.m);
  const out: number[] = [];
  for (let i = 0; i < scored.length && i < limit; i++) out.push(scored[i].m);
  return out;
}

// ---------------------------------------------------------------- 搜索

interface Ctx {
  nodes: number;
  nodeBudget: number;
  deadline: number;
  aborted: boolean;
}

function mkCtx(): Ctx {
  return { nodes: 0, nodeBudget: NODE_BUDGET, deadline: Date.now() + DEADLINE_MS, aborted: false };
}

/** 负极大值 + α-β 剪枝。board 原地落子/复原；叶子用连子模式评估；成五即返回必胜值。 */
function negamax(
  ctx: Ctx,
  board: Int8Array,
  player: number,
  depth: number,
  alpha: number,
  beta: number,
  branch: number,
  ply: number,
): number {
  if (ctx.nodes >= ctx.nodeBudget) {
    ctx.aborted = true;
    return 0;
  }
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }
  if (depth <= 0) return evaluate(board, player);

  const moves = orderedCandidates(board, player, branch);
  if (moves.length === 0) return 0; // 无候选点（盘满）＝和棋
  const opp = 3 - player;
  let best = -INF;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    board[m] = player;
    let v: number;
    if (isFiveAt(board, m, player)) v = SEARCH_WIN - ply; // 越快取胜分越高
    else v = -negamax(ctx, board, opp, depth - 1, -beta, -alpha, branch, ply + 1);
    board[m] = 0;
    if (ctx.aborted) return 0; // 中止：上层只用已得到的最优
    if (v > best) {
      best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
  }
  return best;
}

/** 根节点逐子展开；预算中止时返回已找到的最优（"超时返回当前最优"） */
function rootSearch(
  ctx: Ctx,
  board: Int8Array,
  player: number,
  depth: number,
  moves: number[],
  branch: number,
): { move: number; value: number } {
  if (moves.length === 0) return { move: -1, value: 0 };
  const opp = 3 - player;
  let bestMove = moves[0];
  let bestVal = -INF;
  let alpha = -INF;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    board[m] = player;
    let v: number;
    if (isFiveAt(board, m, player)) v = SEARCH_WIN;
    else v = -negamax(ctx, board, opp, depth - 1, -INF, -alpha, branch, 1);
    board[m] = 0;
    if (ctx.aborted) break;
    if (v > bestVal) {
      bestVal = v;
      bestMove = m;
      if (v > alpha) alpha = v;
    }
  }
  return { move: bestMove, value: bestVal };
}

// ---------------------------------------------------------------- 硬规则与对外 API

/**
 * 困难档根节点硬规则（规格优先级）：成五 > 堵对方成五 > 己方活四 > 堵对方活四。
 * 同级命中取攻防合分最高者（同分 idx 小者，确定）；无命中返回 -1 交给 α-β 搜索。
 */
function hardRules(board: Int8Array, player: number, cands: number[]): number {
  const opp = 3 - player;
  let winMove = -1;
  let winScore = -1;
  let blockMove = -1;
  let blockScore = -1;
  let ownOpen4 = -1;
  let ownOpen4Score = -1;
  let blockOpen4 = -1;
  let blockOpen4Score = -1;
  for (const m of cands) {
    // 己方视角：此点是否成五 / 成活四，以及攻分
    board[m] = player;
    const myFive = isFiveAt(board, m, player);
    const myOpen4 = !myFive && hasOpenFourAt(board, m, player);
    const myScore = placementScore(board, m, player);
    board[m] = 0;
    // 对方视角：此点是否让对方成五 / 成活四，以及对方的攻分（防堵价值）
    board[m] = opp;
    const opFive = isFiveAt(board, m, opp);
    const opOpen4 = !opFive && hasOpenFourAt(board, m, opp);
    const opScore = placementScore(board, m, opp);
    board[m] = 0;

    const tie = myScore + opScore; // 攻防合分作同级取舍
    if (myFive) {
      if (tie > winScore) {
        winScore = tie;
        winMove = m;
      }
    } else if (opFive) {
      if (tie > blockScore) {
        blockScore = tie;
        blockMove = m;
      }
    } else if (myOpen4) {
      if (tie > ownOpen4Score) {
        ownOpen4Score = tie;
        ownOpen4 = m;
      }
    } else if (opOpen4) {
      if (tie > blockOpen4Score) {
        blockOpen4Score = tie;
        blockOpen4 = m;
      }
    }
  }
  if (winMove >= 0) return winMove;
  if (blockMove >= 0) return blockMove;
  if (ownOpen4 >= 0) return ownOpen4;
  return blockOpen4;
}

/** 无候选点时的兜底：空盘落天元；其余取扫描序第一个空点（保证返回合法空点） */
function fallbackMove(board: Int8Array): number {
  if (board[CENTER_IDX] === 0) return CENTER_IDX;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === 0) return i;
  }
  return -1;
}

/** 三档难度统一入口。确定性：同一局面 + 同一难度 ⇒ 同一结果（含 nodes 计数） */
export function chooseMove(pos: AiPosition, difficulty: Difficulty): AiResult {
  if (pos.status !== 'playing') return { move: -1, nodes: 0 };
  const board = pos.board.slice();
  const player = pos.current;

  if (difficulty === 'easy') {
    const cands = genCandidates(board);
    if (cands.length === 0) return { move: fallbackMove(board), nodes: 0 };
    const opp = 3 - player;
    const ordered = orderedCandidates(board, player, cands.length);
    // 1. 己方能成五必落；2. 对方能成五必堵（启发分最高的五点天然居前，按序取第一个，确定）
    for (const m of ordered) {
      board[m] = player;
      const five = isFiveAt(board, m, player);
      board[m] = 0;
      if (five) return { move: m, nodes: cands.length };
    }
    for (const m of ordered) {
      board[m] = opp;
      const five = isFiveAt(board, m, opp);
      board[m] = 0;
      if (five) return { move: m, nodes: cands.length };
    }
    // 3. 攻防评分最高点
    return { move: ordered[0], nodes: cands.length };
  }

  const ctx = mkCtx();

  if (difficulty === 'medium') {
    const moves = orderedCandidates(board, player, MEDIUM_BRANCH);
    if (moves.length === 0) return { move: fallbackMove(board), nodes: ctx.nodes };
    // 深度 2 搜索天然覆盖必杀/必堵：己方成五 ⇒ +WIN；不堵对方成五 ⇒ −WIN
    const { move } = rootSearch(ctx, board, player, MEDIUM_DEPTH, moves, MEDIUM_BRANCH);
    return { move, nodes: ctx.nodes };
  }

  // hard：必杀/必防硬规则优先，其余交给迭代加深 α-β（深度 2 → 4）
  const cands = genCandidates(board);
  if (cands.length === 0) return { move: fallbackMove(board), nodes: ctx.nodes };
  const ruleMove = hardRules(board, player, cands);
  if (ruleMove >= 0) return { move: ruleMove, nodes: ctx.nodes };

  const shallow = rootSearch(
    ctx,
    board,
    player,
    2,
    orderedCandidates(board, player, HARD_BRANCH),
    HARD_BRANCH,
  );
  if (ctx.aborted || shallow.move < 0 || shallow.value >= SEARCH_WIN) {
    return { move: shallow.move < 0 ? fallbackMove(board) : shallow.move, nodes: ctx.nodes };
  }
  // 上一轮最优步置前，提升深度 4 的剪枝效率（顺序确定 ⇒ 结果确定）
  const moves = orderedCandidates(board, player, HARD_BRANCH);
  const reordered = [shallow.move, ...moves.filter((m) => m !== shallow.move)];
  const deep = rootSearch(ctx, board, player, HARD_DEPTH, reordered, HARD_BRANCH);
  return { move: deep.move, nodes: ctx.nodes };
}
