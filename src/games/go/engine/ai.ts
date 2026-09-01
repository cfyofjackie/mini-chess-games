// 围棋吃子教学 AI：纯启发式单步，完全确定（无随机、无搜索树、无 DOM）。
// 定位（docs/games/go.md 第三节）：新手期对手——抓吃优先、会打吃与延气、三四线扩张、
// 避免自填眼与自撞气、不深入对方厚势；会惩罚脱线松棋（它会抢三线要子并追杀无气群），
// 但不做深算，输了能看出原因。
// 优先级（权重层级差远大于扩张小分，保证严格有序）：
//   提对方 1 气群 > 救己方 1 气群 > 打吃（2→1 气）> 延己气 > 扩张（三四线优先）
import {
  CELLS,
  NEIGH4,
  SIZE,
  type GoState,
  type Player,
  groupAt,
  groupsOf,
  legalMoves,
  opponent,
  place,
} from './go';

export interface AiResult {
  /** 落点 idx；-1 表示虚着（pass） */
  move: number;
}

// ---------------------------------------------------------------- 权重（层级分）

const W_CAPTURE = 100_000; // 抓吃：每提一子
const W_SAVE = 40_000; // 救子：己方 1 气群每救回一子
const W_ATARI = 6_000; // 打吃：对方每子被打到 1 气
const W_EXTEND = 4_000; // 延气：己方 2 气群延展到 ≥3 气，每群
const W_ENDANGER = -12_000; // 弄险：把己方 ≥2 气的邻群打到 1 气，每子
const W_SELF_ATARI = -90_000; // 自撞一气（按超出提子数的己方子数放大，倒扑可由提子分补偿）
const W_EYE_FILL = -70_000; // 自填眼 / 自填实地（四邻皆己的空点）
const THICKNESS_UNIT = 1_500; // 厚势惩罚：无己方接应时贴上对方大群，按群大小计
const BAD_FLOOR = -30_000; // 低于此分视为恶手：宁可虚着也不送子
const PLAYABLE_MIN = 500; // 对方虚着后，低于此分视为无意义填空 → 跟着虚着终局

// ---------------------------------------------------------------- 几何预计算

/** NEAR2[i]：切比雪夫距离 ≤2 的界内格子（不含自身），判定落点是否脱线孤子 */
const NEAR2: readonly Int32Array[] = (() => {
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

/** 三四线优先的扩张小分（按到边线的路数；9 路三线为主战场） */
function lineScore(idx: number): number {
  const r = Math.floor(idx / SIZE);
  const c = idx % SIZE;
  const d = Math.min(r, c, SIZE - 1 - r, SIZE - 1 - c);
  if (d === 0) return 0; // 一路线：几乎不占
  if (d === 1) return 20; // 二路线
  if (d === 2) return 120; // 三路线：最优
  if (d === 3) return 90; // 四路线：次优
  return Math.max(20, 55 - (d - 3) * 10); // 更靠中腹平稳衰减（大盘适配）
}

function hasStoneNear2(board: Int8Array, idx: number): boolean {
  const ns = NEAR2[idx];
  for (let k = 0; k < ns.length; k++) {
    if (board[ns[k]] !== 0) return true;
  }
  return false;
}

/** 保守眼形判定：空点四邻（界内）全为己色即视为眼/腹地，落之自损 */
function isOwnEyeShape(board: Int8Array, idx: number, me: Player): boolean {
  const ns = NEIGH4[idx];
  return ns.length > 0 && ns.every((n) => board[n] === me);
}

// ---------------------------------------------------------------- 单着启发分

/**
 * 假想 state.current 落在 idx 的启发分。非法着返回 -Infinity
 * （chooseMove 只喂 legalMoves 的输出，正常不会触达）。
 */
function moveScore(state: GoState, idx: number): number {
  const me = state.current;
  const opp = opponent(me);
  const board = state.board;
  const after = place(state, idx);
  if (after === state) return Number.NEGATIVE_INFINITY;

  // 抓吃：被提掉的对方子数
  let captured = 0;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === opp && after.board[i] === 0) captured++;
  }

  // 己方新群（用于自撞气判定）
  const myGroup = groupAt(after.board, idx);
  const libsAfter = myGroup.liberties.length;

  // 救子：落子前己方 1 气群，落子后气 ≥2 即视为救回（含提掉攻杀子 / 长气两种途径）
  let saved = 0;
  for (const g of groupsOf(board, me)) {
    if (g.liberties.length !== 1) continue;
    const rep = g.stones[0];
    if (groupAt(after.board, rep).liberties.length >= 2) saved += g.stones.length;
  }

  // 邻接棋群变化：打吃 / 延气 / 弄险（按代表子去重，避免同群重复计数）
  const ownSeen = new Set<number>();
  const oppSeen = new Set<number>();
  const enemyReps = new Set<number>();
  let atariStones = 0;
  let extended = 0;
  let endangered = 0;
  let adjOwn = 0;
  let adjOpp = 0;
  for (const n of NEIGH4[idx]) {
    const v = board[n];
    if (v === me) {
      adjOwn++;
      const g = groupAt(board, n);
      const rep = g.stones[0];
      if (ownSeen.has(rep)) continue;
      ownSeen.add(rep);
      const libsNow = groupAt(after.board, rep).liberties.length;
      if (g.liberties.length === 2 && libsNow >= 3) extended++;
      if (g.liberties.length >= 2 && libsNow === 1) endangered += g.stones.length;
    } else if (v === opp) {
      adjOpp++;
      const g = groupAt(board, n);
      const rep = g.stones[0];
      if (oppSeen.has(rep)) continue;
      oppSeen.add(rep);
      enemyReps.add(rep);
      if (g.liberties.length >= 2 && groupAt(after.board, rep).liberties.length === 1) {
        atariStones += g.stones.length;
      }
    }
  }

  // 厚势：周围无己方接应却贴上对方大群 = 深入敌阵
  let thickness = 0;
  if (adjOwn === 0 && enemyReps.size > 0) {
    let enemyStones = 0;
    for (const rep of enemyReps) enemyStones += groupAt(board, rep).stones.length;
    thickness = THICKNESS_UNIT * Math.min(enemyStones, 6);
  }

  // 扩张：三四线优先 + 开阔度优先（周围 2 格内空点越多，越是抢占地盘的好点）
  // + 在战场附近发展 + 适度贴子；重罚填自家墙 / 扎进对方棋堆
  const ply = state.history.length;
  const near = NEAR2[idx];
  let empties = 0;
  for (let k = 0; k < near.length; k++) {
    if (board[near[k]] === 0) empties++;
  }
  let expansion = lineScore(idx) + 40 * Math.min(empties, 20);
  if (hasStoneNear2(board, idx)) expansion += 80;
  else expansion -= ply < 8 ? 100 : 400; // 脱线松棋：开局轻罚、中盘重罚
  expansion += 90 * Math.min(adjOwn + adjOpp, 2); // 适度贴子（保持接触战，教学上好理解）
  if (adjOwn >= 3) expansion -= 900; // 三面以上贴己 = 填实自家
  if (adjOpp >= 3) expansion -= 300; // 三面以上贴敌 = 深入对方厚势

  let s = W_CAPTURE * captured + W_SAVE * saved + W_ATARI * atariStones + W_EXTEND * extended;
  s += W_ENDANGER * endangered;
  if (libsAfter === 1) {
    // 自撞一气：按扣除提子补偿后仍暴露在险中的己方子数放大（倒扑等交换可由提子分盖过）
    const atRisk = Math.max(1, myGroup.stones.length - captured);
    s += W_SELF_ATARI * atRisk;
  }
  if (captured === 0 && isOwnEyeShape(board, idx, me)) s += W_EYE_FILL;
  s -= thickness;
  s += expansion;
  return s;
}

// ---------------------------------------------------------------- 对外 API

/**
 * 选着（确定性：同一局面 ⇒ 同一结果；同分取 idx 小者）。
 * 虚着时机：无任何合法点；或剩余着法全是恶手（自撞气/自填眼）；
 * 或对方刚虚着且已无有价值的着法（不无意义填空，顺势双虚着终局）。
 */
export function chooseMove(state: GoState): AiResult {
  if (state.status !== 'playing') return { move: -1 };
  const cands = legalMoves(state);
  if (cands.length === 0) return { move: -1 };
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const m of cands) {
    const s = moveScore(state, m);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  if (best < 0 || bestScore <= BAD_FLOOR) return { move: -1 };
  if (state.passes === 1 && bestScore < PLAYABLE_MIN) return { move: -1 };
  return { move: best };
}
