// 中国跳棋 AI：纯函数搜索，完全确定（无随机、无 DOM 依赖），规格见 docs/games/chinese-checkers.md 第四节。
// 三档难度：
// - easy   贪心：在全部一次操作（走一步或整条跳链）中，选"己方到目标角距离总和"降幅最大者，纯推进无前瞻。
// - medium 前瞻 2 层（己方一步 + 对方一步回应），全分支展开。
// - hard   α-β 深度 3 + 迭代加深；每节点候选剪枝（快评取前 12 步）。
// 评估（中/困难共用，行动方视角）= 对方距离有效总和 × wOpp − 己方距离有效总和
//   + 入营沉淀奖励 × 差 − 堵门惩罚 × 差；有效总和 = 距离总和 + 0.5 × 最落后子距离（规格书 ×1.5 加权）。
//   wOpp：困难档 1（对手等权）；中等档 0.25 —— 跳棋是纯竞速，对手项等权会诱发
//   "以己方节奏换压制"的着法，互弈实测反而输给简单档，降权后梯度恢复（规格书未规定对手项权重）。
// 出营问题（规格书独立条目，三档统一生效）：已入目标营的子"移出目标营"的动作给极重惩罚
// （等效禁止）——候选生成阶段直接剔除，仅当该方除出营外无任何着法时才保留；不修改引擎规则。
// 限策：节点预算为主（确定性），1.9s 墙钟仅作极端情况兜底；超限返回当前已找到的最优步。
// 距离度量：己方目标角（对臂尖孔）的六角距离（cube 坐标曼哈顿距离的一半），行为可在测试中断言。
// 着法全部经引擎 movesFrom 生成 → AI 合法性恒等于引擎合法性；搜索内对棋盘原地 make/unmake。
import {
  HOLES,
  HOLES_GEO,
  type CCState,
  type Player,
  type Status,
  P1_CAMP,
  P2_CAMP,
  indexOf,
  movesFrom,
} from './chinese-checkers';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 求解入参：只需 board / current / status（CCState 结构兼容，快照栈等字段不参与搜索） */
export interface AiPosition {
  board: Int8Array;
  current: Player;
  status: Status;
}

export interface AiResult {
  /** 一次操作的起点孔下标；当前方无任何操作或已终局时为 -1 */
  from: number;
  /** 一次操作的终点孔下标（跳链一步直达链尾） */
  to: number;
  /** 本次求解展开的搜索节点数（诊断用） */
  nodes: number;
}

export const MEDIUM_DEPTH = 2;
export const HARD_DEPTH = 3;
/** 困难档每节点候选剪枝：快评取前 N 步（规格书定值 12） */
export const CANDIDATE_LIMIT = 12;
/** 节点预算（确定性主限策；正常远在墙钟之前结束） */
export const NODE_BUDGET = 200_000;
/** 墙钟兜底（毫秒）：规格书"单步 ≤2s"，留 100ms 余量给消息往返 */
export const DEADLINE_MS = 1900;
/** 胜利分（远超任何评估值） */
const WIN_SCORE = 1_000_000;
/** 困难档对手距离项权重（规格字面：与己方等权） */
const HARD_OPP_WEIGHT = 1;
/**
 * 中等档对手距离项权重（< 1 = 己方推进价值高于压制对手）。
 * 跳棋是纯竞速：若对手推进与己方推进等权，前瞻搜索会倾向"花 2 步自身进度换对手 1 步"
 * 的压制性着法，中盘浪费节奏反而输给纯贪心（互弈实测 2胜4负）；降权后稳定强于简单档。
 * 规格书仅定义"推进距离总和 + 最落后子 ×1.5"，对手项的相对权重为实现自由度。
 */
const MEDIUM_OPP_WEIGHT = 0.25;
/** 中/困难评估：最落后子的距离额外加权 ×1.5（即在总和上再加 0.5 × 其距离） */
const LAG_WEIGHT = 0.5;
/** 评估：每颗已入目标营子的沉淀奖励 / 每颗仍滞留己方出发营子的堵门惩罚 */
export const CAMP_SETTLE_BONUS = 3;
export const JAM_PENALTY = 3;
/** 出营动作的极重惩罚（快评排序沉底用；搜索层直接剔除，等效禁止） */
const LEAVE_PENALTY = 1e6;
/** 快评：新入目标营的微小加分（仅影响候选排序） */
const ENTER_BONUS = 2;

const INF = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------- 预计算几何表

/** 各方目标角 = 对臂尖孔：1 方目标为上臂尖 (4,-8)，2 方目标为下臂尖 (-4,8) */
const TIP: readonly [number, number] = [indexOf(4, -8), indexOf(-4, 8)];

/**
 * DIST[p-1][i]：孔 i 到 p 方目标角的六角距离（cube 曼哈顿 / 2）。
 * 已入目标营的孔距离 ≤ 3，营外孔距离 ≥ 4 → "移出目标营"必然增大距离总和。
 */
const DIST: readonly Int16Array[] = [1, 2].map((p) => {
  const tip = HOLES_GEO[TIP[p - 1]];
  const arr = new Int16Array(HOLES);
  for (let i = 0; i < HOLES; i++) {
    const h = HOLES_GEO[i];
    const dx = h.x - tip.x;
    const dz = h.z - tip.z;
    const dy = -dx - dz;
    arr[i] = (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) / 2;
  }
  return arr;
});

/** 各方的目标营区 / 出发营区成员表（下标 = 孔下标，1 = 属于） */
const TARGET_CAMPS: readonly [readonly number[], readonly number[]] = [P2_CAMP, P1_CAMP];
const HOME_CAMPS: readonly [readonly number[], readonly number[]] = [P1_CAMP, P2_CAMP];

function memberFlags(camp: readonly number[]): Uint8Array {
  const flags = new Uint8Array(HOLES);
  for (const i of camp) flags[i] = 1;
  return flags;
}

const IN_TARGET: readonly Uint8Array[] = TARGET_CAMPS.map(memberFlags);
const IN_HOME: readonly Uint8Array[] = HOME_CAMPS.map(memberFlags);

// ---------------------------------------------------------------- 着法生成

/** genMoves 的 packed 编码：from * HOLES + to（from 为主序，天然升序、可作确定性问题平破除） */
const packMove = (from: number, to: number) => from * HOLES + to;
const unpackFrom = (m: number) => (m / HOLES) | 0;
const unpackTo = (m: number) => m % HOLES;

/** 构造引擎 movesFrom 所需的最小状态视图（共享同一棋盘数组，读取实时变化） */
function boardView(board: Int8Array, player: Player): CCState {
  return {
    board,
    history: [],
    current: player,
    status: 'playing',
    winner: 0,
    lastFrom: -1,
    lastTo: -1,
  };
}

/** player 的全部一次操作（走一步 ∪ 整条跳链），packed 升序；着法由引擎 movesFrom 生成 */
function genMoves(board: Int8Array, player: Player): number[] {
  const view = boardView(board, player);
  const out: number[] = [];
  for (let i = 0; i < HOLES; i++) {
    if (board[i] !== player) continue;
    for (const t of movesFrom(view, i)) out.push(packMove(i, t));
  }
  return out;
}

/** 是否为"移出目标营"的动作（出营问题：极重惩罚，等效禁止） */
function isCampExit(player: Player, m: number): boolean {
  const t = IN_TARGET[player - 1];
  return t[unpackFrom(m)] === 1 && t[unpackTo(m)] === 0;
}

/** 快评（仅用于候选排序）：距离降幅 + 新入营微加分 − 出营极重惩罚 */
function quickScore(player: Player, m: number): number {
  const from = unpackFrom(m);
  const to = unpackTo(m);
  const d = DIST[player - 1][from] - DIST[player - 1][to];
  const t = IN_TARGET[player - 1];
  if (t[from] === 1 && t[to] === 0) return d - LEAVE_PENALTY;
  return t[from] === 0 && t[to] === 1 ? d + ENTER_BONUS : d;
}

/**
 * 候选池：先剔除"出营"动作（等效禁止；仅当除出营外无着法时保留全部），
 * 再按快评降序、packed 升序稳定排序。返回全新数组，调用方可安全截断。
 */
function movePool(board: Int8Array, player: Player): number[] {
  const moves = genMoves(board, player);
  const keep = moves.filter((m) => !isCampExit(player, m));
  const scored = (keep.length > 0 ? keep : moves).map((m) => ({ m, s: quickScore(player, m) }));
  scored.sort((a, b) => b.s - a.s || a.m - b.m);
  return scored.map((x) => x.m);
}

/** player 是否已 10 子全部进入目标营（搜索内的快速胜利判定） */
function campComplete(board: Int8Array, player: Player): boolean {
  const camp = TARGET_CAMPS[player - 1];
  for (let k = 0; k < camp.length; k++) {
    if (board[camp[k]] !== player) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 评估函数

/**
 * 评估（player 视角，越大越好）：
 * 基础 = wOpp × 对方距离有效总和 − 己方距离有效总和，
 * 其中有效总和 = 距离总和 + 0.5 × 最落后子距离（×1.5 加权）；
 * 另含入营沉淀奖励 × 差 + 堵门惩罚 × 差（中/困难共用）。
 * 每个节点都以"该节点行动方"的视角调用 → 负极大值符号约定成立。
 */
function evaluate(board: Int8Array, player: Player, wOpp: number): number {
  const opp = (3 - player) as Player;
  const dMy = DIST[player - 1];
  const dOp = DIST[opp - 1];
  const tMy = IN_TARGET[player - 1];
  const tOp = IN_TARGET[opp - 1];
  const hMy = IN_HOME[player - 1];
  const hOp = IN_HOME[opp - 1];
  let mySum = 0;
  let myLag = 0;
  let opSum = 0;
  let opLag = 0;
  let myCamp = 0;
  let opCamp = 0;
  let myHome = 0;
  let opHome = 0;
  for (let i = 0; i < HOLES; i++) {
    const v = board[i];
    if (v === player) {
      const d = dMy[i];
      mySum += d;
      if (d > myLag) myLag = d;
      if (tMy[i]) myCamp++;
      else if (hMy[i]) myHome++;
    } else if (v === opp) {
      const d = dOp[i];
      opSum += d;
      if (d > opLag) opLag = d;
      if (tOp[i]) opCamp++;
      else if (hOp[i]) opHome++;
    }
  }
  let score = wOpp * (opSum + LAG_WEIGHT * opLag) - (mySum + LAG_WEIGHT * myLag);
  score += CAMP_SETTLE_BONUS * (myCamp - opCamp) - JAM_PENALTY * (myHome - opHome);
  return score;
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

/**
 * 负极大值 + α-β 剪枝。board 原地 make/unmake；胜利节点直接返回胜利分
 * （深度折减使更快入营优先）。limit > 0 时每节点按快评截断候选（困难档）。
 */
function negamax(
  ctx: Ctx,
  board: Int8Array,
  player: Player,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  limit: number,
  wOpp: number,
): number {
  if (++ctx.nodes >= ctx.nodeBudget) {
    ctx.aborted = true;
    return 0;
  }
  if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }
  if (depth <= 0) return evaluate(board, player, wOpp);

  const pool = movePool(board, player);
  if (pool.length === 0) return evaluate(board, player, wOpp); // 僵局（引擎 v1 无 pass 规则）
  if (limit > 0 && pool.length > limit) pool.length = limit;

  const opp = (3 - player) as Player;
  let best = -INF;
  for (let i = 0; i < pool.length; i++) {
    const m = pool[i];
    const from = unpackFrom(m);
    const to = unpackTo(m);
    board[from] = 0;
    board[to] = player;
    const v = campComplete(board, player)
      ? WIN_SCORE - ply
      : -negamax(ctx, board, opp, depth - 1, -beta, -alpha, ply + 1, limit, wOpp);
    board[to] = 0;
    board[from] = player;
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
  /** packed 最优着法 */
  move: number;
  /** 该着法的搜索值（当前方视角） */
  value: number;
}

/** 根节点逐着展开：超预算时返回已找到的最优（"超时返回当前最优"） */
function searchRoot(
  ctx: Ctx,
  board: Int8Array,
  player: Player,
  depth: number,
  limit: number,
  wOpp: number,
  hint: number,
): RootResult {
  const pool = movePool(board, player);
  if (pool.length === 0) return { move: -1, value: 0 };
  if (limit > 0 && pool.length > limit) pool.length = limit;
  // 迭代加深：上一轮最优着法置首（改善剪枝；pool 确定性重建，hint 必在池中）
  if (hint >= 0) {
    const at = pool.indexOf(hint);
    if (at > 0) {
      pool.splice(at, 1);
      pool.unshift(hint);
    }
  }

  const opp = (3 - player) as Player;
  let bestMove = pool[0];
  let bestVal = -INF;
  let alpha = -INF;
  for (let i = 0; i < pool.length; i++) {
    const m = pool[i];
    const from = unpackFrom(m);
    const to = unpackTo(m);
    board[from] = 0;
    board[to] = player;
    const v = campComplete(board, player)
      ? WIN_SCORE
      : -negamax(ctx, board, opp, depth - 1, -INF, -alpha, 1, limit, wOpp);
    board[to] = 0;
    board[from] = player;
    if (ctx.aborted) break;
    if (v > bestVal) {
      bestVal = v;
      bestMove = m;
      if (v > alpha) alpha = v;
    }
  }
  return { move: bestMove, value: bestVal };
}

// ---------------------------------------------------------------- 对外 API

/** 有一步完成入营的着法必选（三档共用；packed 升序取第一个，保证确定） */
function findWinningMove(board: Int8Array, player: Player, moves: number[]): number {
  for (const m of moves) {
    const from = unpackFrom(m);
    const to = unpackTo(m);
    board[from] = 0;
    board[to] = player;
    const won = campComplete(board, player);
    board[to] = 0;
    board[from] = player;
    if (won) return m;
  }
  return -1;
}

/**
 * 三档难度统一入口。确定性：同一局面 + 同一难度 ⇒ 同一结果（含 nodes 计数）。
 * 根节点先做立即取胜预检，再按难度分流。
 */
export function chooseMove(pos: AiPosition, difficulty: Difficulty): AiResult {
  const none: AiResult = { from: -1, to: -1, nodes: 0 };
  if (pos.status !== 'playing') return none;
  const board = pos.board.slice();
  const player = pos.current;

  const moves = genMoves(board, player);
  if (moves.length === 0) return none;

  const win = findWinningMove(board, player, moves);
  if (win >= 0) return { from: unpackFrom(win), to: unpackTo(win), nodes: moves.length };

  if (difficulty === 'easy') {
    // 贪心：距离总和降幅最大；平分取 packed 最小（packed 升序扫描 + 严格 > 保证确定）
    const keep = moves.filter((m) => !isCampExit(player, m));
    const pool = keep.length > 0 ? keep : moves;
    let best = -1;
    let bestGain = -Infinity;
    for (const m of pool) {
      const gain = DIST[player - 1][unpackFrom(m)] - DIST[player - 1][unpackTo(m)];
      if (gain > bestGain) {
        bestGain = gain;
        best = m;
      }
    }
    return best < 0 ? none : { from: unpackFrom(best), to: unpackTo(best), nodes: moves.length };
  }

  const ctx = mkCtx();
  if (difficulty === 'medium') {
    // 前瞻 2 层：己方一步 + 对方一步回应，全分支展开（不剪候选）
    const r = searchRoot(ctx, board, player, MEDIUM_DEPTH, 0, MEDIUM_OPP_WEIGHT, -1);
    return r.move < 0 ? none : { from: unpackFrom(r.move), to: unpackTo(r.move), nodes: ctx.nodes };
  }

  // hard：α-β 深度 3 + 迭代加深，每节点快评取前 12 候选
  let committed = -1;
  for (let depth = 1; depth <= HARD_DEPTH; depth++) {
    const r = searchRoot(ctx, board, player, depth, CANDIDATE_LIMIT, HARD_OPP_WEIGHT, committed);
    if (r.move < 0) break;
    if (!ctx.aborted) committed = r.move;
    if (ctx.aborted) break;
    if (ctx.nodes >= ctx.nodeBudget * 0.6) break; // 预算过半不再加深（确定性判断）
  }
  if (committed >= 0) return { from: unpackFrom(committed), to: unpackTo(committed), nodes: ctx.nodes };
  // 兜底（实际不可达）：快评最优
  const pool = movePool(board, player);
  const m = pool[0];
  return m === undefined ? none : { from: unpackFrom(m), to: unpackTo(m), nodes: ctx.nodes };
}

/** 当前方是否至少存在一次操作（UI 调度防御用；与 genMoves 同一合法性来源） */
export function hasAnyMove(board: Int8Array, player: Player): boolean {
  const view = boardView(board, player);
  for (let i = 0; i < HOLES; i++) {
    if (board[i] !== player) continue;
    if (movesFrom(view, i).length > 0) return true;
  }
  return false;
}
