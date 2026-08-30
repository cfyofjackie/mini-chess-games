// 选择提示与王邻格解释（规格书第九节）：纯函数、零 DOM 依赖，只读引擎既有能力
// （pseudoTargets / legalTargets / isInCheck 等），不改走法生成与 AI 搜索。
// - explainSelection(state, from)：点选己方棋子却没有合法落点时的原因——
//   有伪合法步但全部非法（走开会送将）→ 'pinned'；连伪合法步都没有（被己方棋子堵死）→ 'blocked'。
// - kingNeighborReasons(state, kingSq)：选中王时 8 邻格中"不可用"格的原因——
//   己方占位 → 'own'；空格但走过去送将 → 'attacked'；敌子受保护（吃完被反吃送将）→ 'defended'；
//   合法落点（含吃子）不标注。
// - toastText(toast)：提示浮条文案（牵制 / 无路可走 / 轮次），文案为规格书定值。
import {
  B_KING,
  SIZE,
  W_KING,
  isInCheck,
  legalTargets,
  pseudoTargets,
  sideOf,
  type ChessState,
  type Player,
} from '../engine/chess';

/** 零合法步的原因：'pinned' 有伪合法步但全部非法（走开会送将）；'blocked' 被完全堵死 */
export type SelectionReason = 'pinned' | 'blocked';

/**
 * 点选己方棋子 from 却无合法落点时的原因；有合法落点（或 from 为空格 / 非行棋方棋子 /
 * 对局已结束）返回 null。判定依据：伪合法步数与合法步数的关系（规格书定值）。
 */
export function explainSelection(state: ChessState, from: number): SelectionReason | null {
  if (state.status !== 'playing') return null;
  const piece = state.board[from];
  if (piece === 0 || sideOf(piece) !== state.current) return null;
  if (legalTargets(state, from).length > 0) return null;
  const pseudo = pseudoTargets(state.board, from, state.enPassant, state.castling);
  return pseudo.length > 0 ? 'pinned' : 'blocked';
}

/** 王邻格不可用的原因：'own' 己方占位 / 'attacked' 空格但走过去送将 / 'defended' 敌子受保护 */
export type NeighborReason = 'own' | 'attacked' | 'defended';

export interface KingNeighbor {
  idx: number;
  reason: NeighborReason;
}

/** 王周围 8 个方向（行列增量），与引擎 ALL8 同序 */
const NEIGHBOR_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/**
 * 选中王 kingSq 时，8 邻格中不可用格的原因列表（盘外方向跳过；合法落点不标注）。
 * kingSq 须为行棋方的王（UI 只会选中己方棋子；其余情形返回空数组）。
 * 判定方式：逐邻格模拟"王走到该格"（王的一步无吃过路兵 / 易位副作用，直接搬子即可），
 * 走后己王被将军即不可用——原始攻击检测看不到"王让开后攻击线穿透"的情形
 * （如车 a1、王 c1 时 d1 原始不受攻，但走过去恰在车线上送将），必须按走子后局面判定。
 */
export function kingNeighborReasons(state: ChessState, kingSq: number): KingNeighbor[] {
  if (state.status !== 'playing') return [];
  const king = state.board[kingSq];
  if (king !== W_KING && king !== B_KING) return [];
  const side = sideOf(king);
  if (side !== state.current) return []; // 只有行棋方的王会被选中；防御非行棋方王
  const r0 = Math.floor(kingSq / SIZE);
  const c0 = kingSq % SIZE;
  const out: KingNeighbor[] = [];
  for (const [dr, dc] of NEIGHBOR_DIRS) {
    const r = r0 + dr;
    const c = c0 + dc;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
    const idx = r * SIZE + c;
    const t = state.board[idx];
    if (t !== 0 && sideOf(t) === side) {
      out.push({ idx, reason: 'own' }); // 己方棋子占位
      continue;
    }
    // 空格 / 敌子：模拟王占该格（含吃子），走后送将 → 不可用
    const next = state.board.slice();
    next[idx] = king;
    next[kingSq] = 0;
    if (!isInCheck(next, side)) continue; // 合法落点（含安全吃子）→ 不标注
    out.push({ idx, reason: t === 0 ? 'attacked' : 'defended' });
  }
  return out;
}

/** 提示浮条内容：零合法步原因（牵制 / 堵死）或轮次提示 */
export type SelectionToast =
  | { kind: 'hint'; reason: SelectionReason }
  | { kind: 'turn'; side: Player };

/** 提示浮条文案（规格书第九节定值） */
export function toastText(toast: SelectionToast): string {
  if (toast.kind === 'turn') return toast.side === 1 ? '现在是白方回合' : '现在是黑方回合';
  return toast.reason === 'pinned' ? '这枚棋子被牵制：走开会送将' : '这枚棋子当前无路可走';
}
