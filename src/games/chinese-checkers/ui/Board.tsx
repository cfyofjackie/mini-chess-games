// 中国跳棋棋盘：六角星 121 孔，按引擎给出的百分比坐标绝对定位渲染；
// 孔为小圆点（双方出发臂淡色染色），棋子为高区分度双色圆片，
// 选中 / 可达终点（含跳链终点）/ 上一手均有标记。
import {
  HOLES_GEO,
  P1_CAMP,
  P2_CAMP,
  movesFrom,
  type CCState,
  type Player,
} from '../engine/chinese-checkers';

interface BoardProps {
  state: CCState;
  /** 当前选中棋子 idx，-1 为未选中 */
  selected: number;
  /** 锁盘（AI 回合 / AI 思考中）：不响应任何点击 */
  locked?: boolean;
  onTap: (idx: number) => void;
}

export function sideName(p: Player): string {
  return p === 1 ? '靛蓝方' : '玫红方';
}

const P1_HOME = new Set(P1_CAMP);
const P2_HOME = new Set(P2_CAMP);

export default function Board({ state, selected, locked = false, onTap }: BoardProps) {
  const playable = state.status === 'playing' && !locked;
  const targets =
    playable && selected >= 0 ? new Set(movesFrom(state, selected)) : new Set<number>();

  return (
    <div className="cc-board">
      {HOLES_GEO.map((h, i) => {
        const piece = state.board[i];
        const isTarget = targets.has(i);
        const isSelected = selected === i;
        const isLast = i === state.lastFrom || i === state.lastTo;
        const canPick = playable && piece === state.current;
        const clickable = playable && (canPick || isTarget);
        const home = P1_HOME.has(i) ? ' home-p1' : P2_HOME.has(i) ? ' home-p2' : '';
        const cls = [
          'cc-pt',
          clickable ? 'clickable' : '',
          isSelected ? 'selected' : '',
          isTarget ? 'target' : '',
          isLast ? 'last' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={i}
            className={cls}
            style={{ left: `${h.px}%`, top: `${h.py}%` }}
            onClick={playable ? () => onTap(i) : undefined}
            role={clickable ? 'button' : undefined}
            aria-label={`第${i + 1}孔${
              piece !== 0 ? ` ${piece === 1 ? '靛蓝' : '玫红'}子` : ''
            }${isTarget ? '（可达落点）' : ''}`}
          >
            <span className={`cc-hole${home}`} aria-hidden="true" />
            {piece !== 0 && (
              <span
                className={`cc-piece ${piece === 1 ? 'indigo' : 'rose'}${
                  isSelected ? ' picked' : ''
                }`}
              />
            )}
            {isTarget && piece === 0 && <span className="cc-aim" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
