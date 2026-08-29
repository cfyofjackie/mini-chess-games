// 国际象棋棋盘：8×8 明暗格（白在下），Unicode 棋子；
// 选中 / 合法落点（空格圆点、可吃子含吃过路兵红环）/ 最后一手 / 被将军王格均有高亮标记。
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
  legalTargets,
  sideOf,
  type ChessState,
  type Player,
} from '../engine/chess';

/** Unicode 棋子：白 ♔♕♖♗♘♙ / 黑 ♚♛♜♝♞♟ */
const GLYPHS: Record<number, string> = {
  [W_KING]: '♔',
  [W_QUEEN]: '♕',
  [W_ROOK]: '♖',
  [W_BISHOP]: '♗',
  [W_KNIGHT]: '♘',
  [W_PAWN]: '♙',
  [B_KING]: '♚',
  [B_QUEEN]: '♛',
  [B_ROOK]: '♜',
  [B_BISHOP]: '♝',
  [B_KNIGHT]: '♞',
  [B_PAWN]: '♟',
};

/** 棋子中文名（aria 标签用） */
const NAMES: Record<number, string> = {
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

interface BoardProps {
  state: ChessState;
  /** 当前选中格 idx，-1 为未选中 */
  selected: number;
  onTap: (idx: number) => void;
}

export function sideName(p: Player): string {
  return p === 1 ? '白方' : '黑方';
}

export default function Board({ state, selected, onTap }: BoardProps) {
  const playable = state.status === 'playing';
  const targets =
    playable && selected >= 0 ? new Set(legalTargets(state, selected)) : new Set<number>();
  const selectedPiece = selected >= 0 ? state.board[selected] : 0;
  const selPawn = selectedPiece === W_PAWN || selectedPiece === B_PAWN;
  // 被将军时高亮当前一方王的所在格
  const checkedIdx = state.check
    ? state.board.indexOf(state.current === 1 ? W_KING : B_KING)
    : -1;

  const cells = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      const piece = state.board[i];
      const isTarget = targets.has(i);
      // 可吃标记：落点有对方子，或为吃过路兵（目标格为空但会移除被吃兵）
      const willCapture = isTarget && (piece !== 0 || (selPawn && i === state.enPassant));
      const isSelected = selected === i;
      const isLast = i === state.lastFrom || i === state.lastTo;
      const canPick = playable && piece !== 0 && sideOf(piece) === state.current;
      const clickable = playable && (canPick || isTarget);

      const cls = [
        'c-cell',
        (r + c) % 2 === 0 ? 'light' : 'dark',
        clickable ? 'clickable' : '',
        isSelected ? 'selected' : '',
        isLast ? 'last' : '',
        i === checkedIdx ? 'check' : '',
      ]
        .filter(Boolean)
        .join(' ');

      cells.push(
        <div
          key={i}
          className={cls}
          onClick={playable ? () => onTap(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={`${algebraic(i)}${
            piece !== 0 ? ` ${sideOf(piece) === 1 ? '白' : '黑'}${NAMES[piece]}` : ''
          }`}
        >
          {piece !== 0 && (
            <span className={`c-pc ${sideOf(piece) === 1 ? 'white' : 'black'}`}>
              {GLYPHS[piece]}
            </span>
          )}
          {isTarget && !willCapture && <span className="c-dot" aria-hidden="true" />}
          {willCapture && <span className="c-ring" aria-hidden="true" />}
        </div>,
      );
    }
  }

  return <div className="c-board">{cells}</div>;
}
