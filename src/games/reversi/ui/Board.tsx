// 黑白棋棋盘：8×8 绿色棋盘，棋子、合法落点半透明提示圆点、最后一手标记
import { ReversiState, SIZE, legalMoves, type Player } from '../engine/reversi';

interface BoardProps {
  state: ReversiState;
  onPlace: (idx: number) => void;
}

export function stoneName(p: Player): string {
  return p === 1 ? '黑方' : '白方';
}

export default function Board({ state, onPlace }: BoardProps) {
  const legal = new Set(legalMoves(state));
  const flippedSet = new Set(state.flipped);
  const playable = state.status === 'playing';

  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      const stone = state.board[i];
      const isLegal = playable && stone === 0 && legal.has(i);
      const isLast = state.lastMove === i;
      const clickable = playable && isLegal;

      cells.push(
        <div
          key={i}
          className={`r-cell${clickable ? ' clickable' : ''}`}
          onClick={clickable ? () => onPlace(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={clickable ? `第${r + 1}行第${c + 1}列` : undefined}
        >
          {stone !== 0 && (
            <span
              className={`r-stone ${stone === 1 ? 'black' : 'white'}${isLast ? ' last' : ''}${
                flippedSet.has(i) ? ' flipped' : ''
              }`}
            />
          )}
          {stone === 0 && isLegal && (
            <span className={`r-dot ${state.current === 1 ? 'black' : 'white'}`} />
          )}
        </div>,
      );
    }
  }

  return <div className="reversi-board">{cells}</div>;
}
