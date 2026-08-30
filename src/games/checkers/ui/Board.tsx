// 国际跳棋棋盘：8×8 网格，仅深色格为可交互点；双色圆片棋子（红/白），王加皇冠标记；
// 选中 / 合法落点（连跳一步直达的链尾）/ 上一手 / 强制吃子提示均有标记。
import {
  SIZE,
  at,
  isDark,
  isKing,
  movesFrom,
  mustCapture,
  sideOf,
  type CheckersState,
  type Player,
} from '../engine/checkers';

interface BoardProps {
  state: CheckersState;
  /** 当前选中棋子的格下标，-1 为未选中 */
  selected: number;
  onTap: (idx: number) => void;
}

export function sideName(p: Player): string {
  return p === 1 ? '红方' : '白方';
}

export default function Board({ state, selected, onTap }: BoardProps) {
  const playable = state.status === 'playing';
  const forced = playable && mustCapture(state);
  const targets =
    playable && selected >= 0
      ? new Set(movesFrom(state, selected).map((m) => m.to))
      : new Set<number>();

  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = at(r, c);
      const piece = state.board[i];
      const side = sideOf(piece);
      const movable = playable && side === state.current && movesFrom(state, i).length > 0;
      const isTarget = targets.has(i);
      const clickable = playable && (movable || isTarget);
      const isSelected = selected === i;
      const isLast = i === state.lastFrom || i === state.lastTo;
      const cls = [
        'ck-cell',
        isDark(r, c) ? 'dark' : 'light',
        clickable ? 'clickable' : '',
        isTarget ? 'target' : '',
        isSelected ? 'selected' : '',
        isLast ? 'last' : '',
        forced && movable ? 'must' : '',
      ]
        .filter(Boolean)
        .join(' ');

      cells.push(
        <div
          key={i}
          className={cls}
          onClick={playable ? () => onTap(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={`第${r + 1}行第${c + 1}列${
            piece !== 0 ? ` ${side === 1 ? '红' : '白'}${isKing(piece) ? '王' : '兵'}` : ''
          }${isTarget ? '（可达落点）' : ''}`}
        >
          {piece !== 0 && (
            <span className={`ck-pc ${side === 1 ? 'red' : 'white'}${isSelected ? ' picked' : ''}`}>
              {isKing(piece) && (
                <span className="ck-crown" aria-hidden="true">
                  ♛
                </span>
              )}
            </span>
          )}
          {isTarget && piece === 0 && <span className="ck-aim" aria-hidden="true" />}
        </div>,
      );
    }
  }

  return <div className="ck-board">{cells}</div>;
}
