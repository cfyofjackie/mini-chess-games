// 黑白棋 AI：纯函数搜索，完全确定（无随机、无 DOM 依赖），规格见 docs/games/reversi.md 第四节。
// 三档难度：
// - easy   贪心：选翻转子数最多的合法步（同分取扫描序最小 idx）。
// - medium α-β 深度 2：位置权重 + 行动力评估。
// - hard   α-β 深度 4：位置权重 + 行动力 + 潜力（潜在行动力）评估；
//          剩余空格 ≤ ENDGAME_EMPTY_THRESHOLD 时切换为以终局子差为目标的精确穷举。
// 限策：节点预算为主（确定性），1.5s 墙钟仅作极端情况兜底；超限时返回当前已找到的最优步。
// Worker reversi.ai.worker.ts 只做消息薄封装，全部搜索逻辑都在本文件。
import { CELLS, type Player, type Status } from './reversi';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 求解入参：ReversiState 结构兼容（board/current/status），Worker 侧可按同构对象重建 */
export interface AiPosition {
  board: Int8Array;
  current: Player;
  status: Status;
}

export interface AiResult {
  /** 合法步 idx；当前方无合法步或已终局时为 -1 */
  move: number;
  /** 本次求解展开的搜索节点数（诊断用） */
  nodes: number;
}

/** 困难档切换精确穷举的阈值：剩余空格 ≤ 10（规格书定值） */
export const ENDGAME_EMPTY_THRESHOLD = 10;

const MEDIUM_DEPTH = 2;
const HARD_DEPTH = 4;
/** 启发式搜索单次节点预算（确定性主限策；正常远在墙钟之前结束） */
const NODE_BUDGET = 500_000;
/** 终局精确穷举阶段的节点预算；超限则退回启发式 α-β 的当前最优 */
const EXACT_NODE_BUDGET = 500_000;
/** 墙钟兜底（毫秒）：仅作保险，正常由节点预算先触发 */
const DEADLINE_MS = 1500;
const INF = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------- 位置权重表

/**
 * 位置权重（规格书）：角 +100；X 位（角对角斜邻）-25；C 位（角正交邻）-10；
 * 边线（非 C/X）+10；内部按区域小分（近角次边 3 / 一般内部 2 / 正中 1）。
 * 数值只影响启发式评估；"有角必占、回避 X 位"由该表直接保证，并有测试断言。
 */
const WEIGHTS: Int8Array = (() => {
  const w = new Int8Array(CELLS);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const edgeR = r === 0 || r === 7;
      const edgeC = c === 0 || c === 7;
      let v: number;
      if (edgeR && edgeC) {
        v = 100; // 角
      } else if (edgeR || edgeC) {
        // X 位是角的斜邻，不在边线上；边线上与角正交相邻的即 C 位
        const cSq = (edgeR && (c === 1 || c === 6)) || (edgeC && (r === 1 || r === 6));
        v = cSq ? -10 : 10;
      } else if ((r === 1 || r === 6) && (c === 1 || c === 6)) {
        v = -25; // X 位
      } else if ((r === 2 || r === 5) && (c === 2 || c === 5)) {
        v = 3; // 近角次边
      } else if (r >= 2 && r <= 5 && c >= 2 && c <= 5) {
        v = (r === 3 || r === 4) && (c === 3 || c === 4) ? 1 : 2; // 正中 1，一般内部 2
      } else {
        v = 2; // 次边线（1/6 行列的非 X/C 位）
      }
      w[r * 8 + c] = v;
    }
  }
  return w;
})();

// ---------------------------------------------------------------- 预计算几何表

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** RAYS[pos*8+d]：从 pos 沿方向 d 依次经过的格子（不含 pos），到边界为止 */
const RAYS: Int8Array[] = (() => {
  const rays: Int8Array[] = [];
  for (let pos = 0; pos < CELLS; pos++) {
    const r0 = pos >> 3;
    const c0 = pos & 7;
    for (let d = 0; d < DIRS.length; d++) {
      const [dr, dc] = DIRS[d];
      const line: number[] = [];
      let r = r0 + dr;
      let c = c0 + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        line.push(r * 8 + c);
        r += dr;
        c += dc;
      }
      rays[pos * 8 + d] = Int8Array.from(line);
    }
  }
  return rays;
})();

/** NEIGHBORS[pos]：8 邻域内界内格子（用于"空位旁有子"预检，加速着法生成） */
const NEIGHBORS: Int8Array[] = (() => {
  const out: Int8Array[] = [];
  for (let pos = 0; pos < CELLS; pos++) {
    const r0 = pos >> 3;
    const c0 = pos & 7;
    const list: number[] = [];
    for (const [dr, dc] of DIRS) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= 0 && r < 8 && c >= 0 && c < 8) list.push(r * 8 + c);
    }
    out.push(Int8Array.from(list));
  }
  return out;
})();

/**
 * 翻转缓冲池：每层递归独占一个槽位，避免分配；槽 47 保留给非递归的
 * 着法生成/计数器（它们只用计数、不保留内容）。递归深度上限远小于 47
 * （精确穷举 ≤ 10 实着 + 若干 pass；启发式 ≤ 4 + pass），此处再钳制兜底。
 */
const FLIP_BUFS: number[][] = Array.from({ length: 48 }, () => new Array<number>(24));
const SCRATCH_BUF = 47;
const MAX_DEPTH_BUF = 46;

// ---------------------------------------------------------------- 棋盘原子操作

/** pos 落子时将被翻转的对方棋子写入 out，返回个数；非法落点返回 0 */
function flipsFor(board: Int8Array, pos: number, player: number, out: number[]): number {
  const opp = 3 - player;
  let n = 0;
  const base = pos << 3;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[base + d];
    const len = ray.length;
    let k = 0;
    while (k < len && board[ray[k]] === opp) k++;
    // 连续对方棋子之后必须恰好是己方棋子（越界/空位都不算）
    if (k > 0 && k < len && board[ray[k]] === player) {
      for (let i = 0; i < k; i++) out[n++] = ray[i];
    }
  }
  return n;
}

function hasOccupiedNeighbor(board: Int8Array, pos: number): boolean {
  const nbs = NEIGHBORS[pos];
  for (let i = 0; i < nbs.length; i++) {
    if (board[nbs[i]] !== 0) return true;
  }
  return false;
}

function hasAnyMove(board: Int8Array, player: number): boolean {
  for (let pos = 0; pos < CELLS; pos++) {
    if (board[pos] !== 0 || !hasOccupiedNeighbor(board, pos)) continue;
    if (flipsFor(board, pos, player, FLIP_BUFS[SCRATCH_BUF]) > 0) return true;
  }
  return false;
}

function countMoves(board: Int8Array, player: number): number {
  let cnt = 0;
  for (let pos = 0; pos < CELLS; pos++) {
    if (board[pos] !== 0 || !hasOccupiedNeighbor(board, pos)) continue;
    if (flipsFor(board, pos, player, FLIP_BUFS[SCRATCH_BUF]) > 0) cnt++;
  }
  return cnt;
}

/** 当前 player 的全部合法步：按位置权重降序、idx 升序排列（角优先利于剪枝，且完全确定） */
function genMovesOrdered(board: Int8Array, player: number): number[] {
  const moves: number[] = [];
  for (let pos = 0; pos < CELLS; pos++) {
    if (board[pos] !== 0 || !hasOccupiedNeighbor(board, pos)) continue;
    if (flipsFor(board, pos, player, FLIP_BUFS[SCRATCH_BUF]) > 0) moves.push(pos);
  }
  if (moves.length > 1) moves.sort((a, b) => WEIGHTS[b] - WEIGHTS[a] || a - b);
  return moves;
}

function countEmpties(board: Int8Array): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (board[i] === 0) n++;
  return n;
}

function discDiffFor(board: Int8Array, player: number): number {
  const opp = 3 - player;
  let diff = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = board[i];
    if (v === player) diff++;
    else if (v === opp) diff--;
  }
  return diff;
}

// ---------------------------------------------------------------- 评估函数

/**
 * 启发式评估（player 视角）：
 * 位置权重差 + 8 × 行动力差；hard 额外加 2 × 潜在行动力差
 * （潜在行动力 = 与己方棋子相邻的空格数，代表后续可下点的储备）。
 */
function evaluate(board: Int8Array, player: number, potential: boolean): number {
  const opp = 3 - player;
  let pos = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = board[i];
    if (v === player) pos += WEIGHTS[i];
    else if (v === opp) pos -= WEIGHTS[i];
  }
  let score = pos + 8 * (countMoves(board, player) - countMoves(board, opp));
  if (potential) {
    let myPot = 0;
    let oppPot = 0;
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== 0) continue;
      const nbs = NEIGHBORS[i];
      let sawMy = false;
      let sawOpp = false;
      for (let k = 0; k < nbs.length; k++) {
        const v = board[nbs[k]];
        if (v === player) sawMy = true;
        else if (v === opp) sawOpp = true;
      }
      if (sawMy) myPot++;
      if (sawOpp) oppPot++;
    }
    score += 2 * (myPot - oppPot);
  }
  return score;
}

// ---------------------------------------------------------------- 搜索

interface Ctx {
  nodes: number;
  nodeBudget: number;
  deadline: number;
  aborted: boolean;
}

function mkCtx(nodeBudget: number): Ctx {
  return { nodes: 0, nodeBudget, deadline: Date.now() + DEADLINE_MS, aborted: false };
}

/**
 * 负极大值 + α-β 剪枝。board 原地 make/unmake；pass 不消耗深度（对方有步才递归，
 * 双方均无步为终局节点）。exact=true 时叶子/终局值 = 终局子差（精确穷举模式）。
 */
function negamax(
  ctx: Ctx,
  board: Int8Array,
  player: number,
  depth: number,
  alpha: number,
  beta: number,
  bufIdx: number,
  exact: boolean,
  potential: boolean,
): number {
  if (ctx.nodes >= ctx.nodeBudget) {
    ctx.aborted = true;
    return 0;
  }
  ctx.nodes++;
  if ((ctx.nodes & 511) === 0 && Date.now() > ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }

  const moves = genMovesOrdered(board, player);
  if (moves.length === 0) {
    if (!hasAnyMove(board, 3 - player)) {
      // 双方均无合法步：终局
      return exact ? discDiffFor(board, player) : evaluate(board, player, potential);
    }
    // 自动 pass：轮次换人、深度不消耗（空格数决定收敛，必然终止）
    return -negamax(ctx, board, 3 - player, depth, -beta, -alpha, bufIdx + 1, exact, potential);
  }
  if (depth <= 0) {
    return exact ? discDiffFor(board, player) : evaluate(board, player, potential);
  }

  let best = -INF;
  const opp = 3 - player;
  const buf = FLIP_BUFS[bufIdx < MAX_DEPTH_BUF ? bufIdx : MAX_DEPTH_BUF];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const n = flipsFor(board, m, player, buf);
    board[m] = player;
    for (let k = 0; k < n; k++) board[buf[k]] = player;
    const v = -negamax(ctx, board, opp, depth - 1, -beta, -alpha, bufIdx + 1, exact, potential);
    for (let k = 0; k < n; k++) board[buf[k]] = opp;
    board[m] = 0;
    if (ctx.aborted) return 0; // 中止：上层用已得到的最优
    if (v > best) {
      best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
  }
  return best;
}

interface RootResult {
  move: number;
  value: number;
}

/** 根节点逐子展开：超预算时返回已找到的最优（"超时返回当前最优"） */
function alphabetaRoot(
  ctx: Ctx,
  board: Int8Array,
  player: number,
  depth: number,
  potential: boolean,
): number {
  const moves = genMovesOrdered(board, player);
  if (moves.length === 0) return -1;
  let bestMove = moves[0];
  let alpha = -INF;
  const opp = 3 - player;
  const buf = FLIP_BUFS[0];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const n = flipsFor(board, m, player, buf);
    board[m] = player;
    for (let k = 0; k < n; k++) board[buf[k]] = player;
    const v = -negamax(ctx, board, opp, depth - 1, -INF, -alpha, 1, false, potential);
    for (let k = 0; k < n; k++) board[buf[k]] = opp;
    board[m] = 0;
    if (ctx.aborted) break;
    if (v > alpha) {
      alpha = v;
      bestMove = m;
    }
  }
  return bestMove;
}

/**
 * 终局精确穷举（negamax on 终局子差）。返回值始终是"已完整评估过的子树中的最优"：
 * 预算中止时 bestMove 仍是当前最优（可能非全局最优），由 chooseMove 决定是否退回启发式。
 */
function solveExact(ctx: Ctx, board: Int8Array, player: number): RootResult | null {
  const moves = genMovesOrdered(board, player);
  if (moves.length === 0) return null;
  const empties = countEmpties(board);
  let bestMove = -1;
  let bestVal = -INF;
  let alpha = -INF;
  const opp = 3 - player;
  const buf = FLIP_BUFS[0];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const n = flipsFor(board, m, player, buf);
    board[m] = player;
    for (let k = 0; k < n; k++) board[buf[k]] = player;
    const v = -negamax(ctx, board, opp, empties - 1, -INF, -alpha, 1, true, false);
    for (let k = 0; k < n; k++) board[buf[k]] = opp;
    board[m] = 0;
    if (ctx.aborted) break;
    if (v > bestVal) {
      bestVal = v;
      bestMove = m;
      if (v > alpha) alpha = v;
    }
  }
  return bestMove < 0 ? null : { move: bestMove, value: bestVal };
}

// ---------------------------------------------------------------- 对外 API

/** 三档难度统一入口。确定性：同一局面 + 同一难度 ⇒ 同一结果（含 nodes 计数） */
export function chooseMove(pos: AiPosition, difficulty: Difficulty): AiResult {
  if (pos.status !== 'playing') return { move: -1, nodes: 0 };
  const board = pos.board.slice();
  const player = pos.current;

  if (difficulty === 'easy') {
    // 贪心：翻转子数最多；同分取扫描序最小 idx（严格 > 保证确定）
    const moves = genMovesOrdered(board, player);
    let best = -1;
    let bestFlips = -1;
    for (let i = 0; i < moves.length; i++) {
      const n = flipsFor(board, moves[i], player, FLIP_BUFS[SCRATCH_BUF]);
      if (n > bestFlips) {
        bestFlips = n;
        best = moves[i];
      }
    }
    return { move: best, nodes: moves.length };
  }

  if (difficulty === 'hard') {
    const empties = countEmpties(board);
    if (empties <= ENDGAME_EMPTY_THRESHOLD) {
      const ctx = mkCtx(EXACT_NODE_BUDGET);
      const exact = solveExact(ctx, board, player);
      if (exact && !ctx.aborted) return { move: exact.move, nodes: ctx.nodes };
      // 精确穷举超预算：退回启发式 α-β 的当前最优
      ctx.aborted = false;
      ctx.nodeBudget = NODE_BUDGET;
      const move = alphabetaRoot(ctx, board, player, HARD_DEPTH, true);
      return { move, nodes: ctx.nodes };
    }
    const ctx = mkCtx(NODE_BUDGET);
    const move = alphabetaRoot(ctx, board, player, HARD_DEPTH, true);
    return { move, nodes: ctx.nodes };
  }

  const ctx = mkCtx(NODE_BUDGET);
  const move = alphabetaRoot(ctx, board, player, MEDIUM_DEPTH, false);
  return { move, nodes: ctx.nodes };
}

export interface EndgameResult {
  /** 最优步 idx */
  move: number;
  /** 该步对应的终局子差（current 视角，正 = 胜） */
  value: number;
  nodes: number;
  /** true = 预算内完整穷举；false = 超预算的部分结果 */
  exact: boolean;
}

/**
 * 终局精确穷举独立入口（测试/诊断用）：剩 ≤ ENDGAME_EMPTY_THRESHOLD 空格时
 * 返回以终局子差为目标的最优步。无合法步或完全未得出结果时返回 null。
 */
export function solveEndgame(pos: AiPosition): EndgameResult | null {
  if (pos.status !== 'playing') return null;
  const ctx = mkCtx(EXACT_NODE_BUDGET);
  const result = solveExact(ctx, pos.board.slice(), pos.current);
  if (!result) return null;
  return { ...result, nodes: ctx.nodes, exact: !ctx.aborted };
}
