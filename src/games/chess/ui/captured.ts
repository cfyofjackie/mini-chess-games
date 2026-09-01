// 吃子托盘数据源（规格书第十二节）：从 history 快照序列提取全部被吃子，并按托盘规则聚合。
// - history[i] 为第 i+1 手走子之前的完整快照，故第 i+1 手的 from/to 取自其后一个快照
//   （最后一手取当前状态）的 lastFrom/lastTo；单手被吃子判定复用 ui/moveText.ts 的
//   capturedOfMove（与上一手 chip / 幽灵动画同一实现），吃过路兵天然正确；
// - 悔棋 = 弹出快照栈、复盘 = 切换自带完整 history 的局面，均为纯数据派生，随 state 实时一致。
// 纯函数、零 DOM 依赖。
import {
  B_BISHOP,
  B_KING,
  B_KNIGHT,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  W_BISHOP,
  W_KING,
  W_KNIGHT,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  sideOf,
  type ChessState,
} from '../engine/chess';
import { capturedOfMove } from './moveText';

/** 棋子价值（规格书第十二节定值：后900/车500/象330/马320/兵100；王不会被吃，仅补全键位） */
export const PIECE_VALUES: Record<number, number> = {
  [W_PAWN]: 100,
  [W_KNIGHT]: 320,
  [W_BISHOP]: 330,
  [W_ROOK]: 500,
  [W_QUEEN]: 900,
  [W_KING]: 0,
  [B_PAWN]: 100,
  [B_KNIGHT]: 320,
  [B_BISHOP]: 330,
  [B_ROOK]: 500,
  [B_QUEEN]: 900,
  [B_KING]: 0,
};

/** 托盘分组：一种被吃棋子 + 个数（同型多子叠放显示 ×N） */
export interface TrayGroup {
  piece: number;
  count: number;
}

/**
 * 全部被吃子（按被吃顺序）：
 * - byWhite：白方吃掉的黑子（白方托盘）；
 * - byBlack：黑方吃掉的白子（黑方托盘）。
 */
export function capturedPieces(state: ChessState): { byWhite: number[]; byBlack: number[] } {
  const byWhite: number[] = [];
  const byBlack: number[] = [];
  const n = state.history.length;
  for (let i = 0; i < n; i++) {
    // history[i] 是第 i+1 手【走子前】的状态（压栈于该手 makeMove）；
    // 第 i 手的 from/to 记录在下一状态的 lastFrom/lastTo（最后一手在 state 本身）。
    const before = state.history[i];
    const after = i + 1 < n ? state.history[i + 1] : state;
    if (after.lastFrom < 0 || after.lastTo < 0) continue; // 初始局面无 lastFrom
    const cap = capturedOfMove(before, after.lastFrom, after.lastTo);
    if (!cap) continue;
    (sideOf(cap.piece) === 2 ? byWhite : byBlack).push(cap.piece);
  }
  return { byWhite, byBlack };
}

/**
 * 托盘分组：按价值降序（后 > 车 > 象 > 马 > 兵）排列，同型多子合并为 ×N；
 * 同价值（同型）保持首次被吃顺序（Array.sort 稳定排序）。
 */
export function trayGroups(captured: number[]): TrayGroup[] {
  const counts = new Map<number, number>();
  for (const piece of captured) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  return [...counts.entries()]
    .map(([piece, count]) => ({ piece, count }))
    .sort((a, b) => (PIECE_VALUES[b.piece] ?? 0) - (PIECE_VALUES[a.piece] ?? 0));
}
