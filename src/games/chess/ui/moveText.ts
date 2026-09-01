// 最近一手的中文文案（规格书第七节 A5）：纯函数、零 DOM 依赖。
// - moveText(move, color)：把一手着法格式化为如 "白后 d1×h5" / "黑兵 e7-e5" 的文案；
//   升变步显示升变子名，如 "白兵 e7-e8=后"。
// - lastMoveInfo(state)：从"走子后的状态"反推最近一手的结构化信息（走子前快照取棋子、
//   判吃子含吃过路兵、升变子反查），供 Game 状态条 chip 与 Board 被吃子幽灵动画共用。
// - capturedOfMove(before, from, to)：单手被吃子提取（lastMoveInfo 的公共内核，
//   规格书第十二节抽出），吃子托盘 ui/captured.ts 复用同一判定。
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
  algebraic,
  sideOf,
  type ChessState,
  type Player,
  type Promotion,
} from '../engine/chess';

/** 走子描述：from/to 格 + 走动的棋子（走子前编码）+ 是否吃子（含吃过路兵）+ 升变子 */
export interface MoveInfo {
  from: number;
  to: number;
  piece: number;
  capture: boolean;
  promotion?: Promotion;
}

/** 被吃的棋子：所在格 idx 与棋子编码（吃过路兵时被吃兵不在落点而在旁格） */
export interface CapturedInfo {
  idx: number;
  piece: number;
}

/** 最近一手完整信息：文案所需字段 + 被吃子（无吃子为 null） */
export interface LastMoveInfo extends MoveInfo {
  captured: CapturedInfo | null;
}

/** 棋子中文名（按棋子编码，黑白同名） */
const PIECE_NAMES: Record<number, string> = {
  [W_KING]: '王',
  [W_QUEEN]: '后',
  [W_ROOK]: '车',
  [W_BISHOP]: '象',
  [W_KNIGHT]: '马',
  [W_PAWN]: '兵',
  [B_KING]: '王',
  [B_QUEEN]: '后',
  [B_ROOK]: '车',
  [B_BISHOP]: '象',
  [B_KNIGHT]: '马',
  [B_PAWN]: '兵',
};

/** 升变字母 → 中文名 */
const PROMO_NAMES: Record<Promotion, string> = {
  q: '后',
  r: '车',
  b: '象',
  n: '马',
};

/** 升变后的棋子编码 → 升变字母（反查用） */
const PROMO_LETTER: Record<number, Promotion> = {
  [W_QUEEN]: 'q',
  [W_ROOK]: 'r',
  [W_BISHOP]: 'b',
  [W_KNIGHT]: 'n',
  [B_QUEEN]: 'q',
  [B_ROOK]: 'r',
  [B_BISHOP]: 'b',
  [B_KNIGHT]: 'n',
};

/** 着法 → 中文文案：颜色前缀（白/黑）+ 棋子名 + 代数坐标（吃子 ×，升变 =子名） */
export function moveText(move: MoveInfo, color: Player): string {
  const side = color === 1 ? '白' : '黑';
  const name = PIECE_NAMES[move.piece] ?? '子';
  const sep = move.capture ? '×' : '-';
  const promo = move.promotion ? `=${PROMO_NAMES[move.promotion]}` : '';
  return `${side}${name} ${algebraic(move.from)}${sep}${algebraic(move.to)}${promo}`;
}

/**
 * 从"走子前快照 + from/to"提取该手的被吃子；无吃子返回 null。
 * 判定：落点原有敌子，或兵斜进至过路兵目标格（吃过路兵，被吃兵在旁格）。
 * lastMoveInfo（上一手 chip / 幽灵动画）与吃子托盘（ui/captured.ts）共用，
 * 保证三处对"什么算吃子、吃的是什么"的判定永远一致。
 */
export function capturedOfMove(before: ChessState, from: number, to: number): CapturedInfo | null {
  if (from < 0 || to < 0) return null;
  const piece = before.board[from];
  if (piece === 0) return null;
  const isPawn = piece === W_PAWN || piece === B_PAWN;
  // 吃过路兵：兵斜向进至对方刚两格所留的目标格（直进至同格不是吃子）
  const epCapture = isPawn && before.enPassant === to && from % 8 !== to % 8;
  const landed = before.board[to];
  if (landed !== 0) return { idx: to, piece: landed };
  if (epCapture) {
    // 被吃兵位于走子兵原行、目标列
    const idx = Math.floor(from / 8) * 8 + (to % 8);
    if (before.board[idx] !== 0) return { idx, piece: before.board[idx] };
  }
  return null;
}

/**
 * 从走子后的状态提取最近一手信息；尚无走子（或快照不一致）返回 null。
 * - 走动的棋子取自走子前快照 history[history.length - 1]；
 * - 吃子：落点原有敌子，或兵斜进至过路兵目标格（吃过路兵，被吃兵在旁格）；
 * - 升变：兵抵达己方底线，升变子反查自走子后的落点棋子。
 */
export function lastMoveInfo(state: ChessState): LastMoveInfo | null {
  const { lastFrom, lastTo } = state;
  if (lastFrom < 0 || lastTo < 0 || state.history.length === 0) return null;
  const prev = state.history[state.history.length - 1];
  const piece = prev.board[lastFrom];
  if (piece === 0) return null;

  const captured = capturedOfMove(prev, lastFrom, lastTo);

  // 升变：兵抵达己方底线（白 row 0 / 黑 row 7），升变子即走子后落点上的棋子
  let promotion: Promotion | undefined;
  const isPawn = piece === W_PAWN || piece === B_PAWN;
  const promoRow = sideOf(piece) === 1 ? lastTo < 8 : lastTo >= 56;
  if (isPawn && promoRow) promotion = PROMO_LETTER[state.board[lastTo]];

  return {
    from: lastFrom,
    to: lastTo,
    piece,
    capture: captured !== null,
    promotion,
    captured,
  };
}
