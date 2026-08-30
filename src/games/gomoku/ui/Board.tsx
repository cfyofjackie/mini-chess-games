// 五子棋棋盘：15×15 网格，黑白棋子、最后一手标记、获胜连珠高亮
import { GomokuState, SIZE, Player } from '../engine/gomoku';

interface BoardProps {
  state: GomokuState;
  onPlace: (idx: number) => void;
  /** true 时锁盘（AI 回合），仅终局判定之外的锁定场景使用 */
  locked?: boolean;
}

export const STAR_POINTS = [
  [3, 3],
  [3, 11],
  [7, 7],
  [11, 3],
  [11, 11],
];

export function stoneName(p: Player): string {
  return p === 1 ? '黑方' : '白方';
}

export default function Board({ state, onPlace, locked = false }: BoardProps) {
  const lineSet = new Set(state.line);
  const last = state.history.length > 0 ? state.history[state.history.length - 1] : -1;
  const playable = state.status === 'playing' && !locked;

  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      const stone = state.board[i];
      const isLast = last === i;
      const inWinLine = lineSet.has(i);
      const isStar = STAR_POINTS.some(([sr, sc]) => sr === r && sc === c);
      const clickable = playable && stone === 0;

      cells.push(
        <div
          key={i}
          className={`g-cell${clickable ? ' clickable' : ''}${isStar ? ' star' : ''}`}
          onClick={clickable ? () => onPlace(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={clickable ? `第${r + 1}行第${c + 1}列` : undefined}
        >
          {stone !== 0 && (
            <span
              className={`g-stone ${stone === 1 ? 'black' : 'white'}${isLast ? ' last' : ''}${
                inWinLine ? ' win-line' : ''
              }`}
            />
          )}
        </div>,
      );
    }
  }

  return <div className="gomoku-board">{cells}</div>;
}
