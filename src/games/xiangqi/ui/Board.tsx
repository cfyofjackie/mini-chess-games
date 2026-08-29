// 象棋棋盘：9×10 交叉点，线条全部用 CSS 绘制（网格 + 九宫斜线 + 楚河汉界），
// 棋子为圆形片+汉字，摆放在交叉点上；选中/合法落点/被吃目标/上一手均有标记。
import {
  B_K,
  COLS,
  legalTargets,
  PIECE_CHAR,
  R_K,
  sideOf,
  type Player,
  type XiangqiState,
} from '../engine/xiangqi';

interface BoardProps {
  state: XiangqiState;
  /** 当前选中交叉点 idx，-1 为未选中 */
  selected: number;
  onTap: (idx: number) => void;
}

export function sideName(p: Player): string {
  return p === 1 ? '红方' : '黑方';
}

export default function Board({ state, selected, onTap }: BoardProps) {
  const playable = state.status === 'playing';
  const targets =
    playable && selected >= 0 ? new Set(legalTargets(state, selected)) : new Set<number>();
  // 被将军时高亮当前一方的将/帅
  const checkedIdx =
    playable && state.check ? state.board.indexOf(state.current === 1 ? R_K : B_K) : -1;

  const points = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const piece = state.board[i];
      const isTarget = targets.has(i);
      const willCapture = isTarget && piece !== 0;
      const isSelected = selected === i;
      const isLast = i === state.lastFrom || i === state.lastTo;
      const canPick = playable && piece !== 0 && sideOf(piece) === state.current;
      const clickable = playable && (canPick || isTarget);

      const cls = [
        'x-pt',
        clickable ? 'clickable' : '',
        isSelected ? 'selected' : '',
        isLast ? 'last' : '',
      ]
        .filter(Boolean)
        .join(' ');

      points.push(
        <div
          key={i}
          className={cls}
          style={{ left: `${(c / (COLS - 1)) * 100}%`, top: `${(r / 9) * 100}%` }}
          onClick={playable ? () => onTap(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={`第${r + 1}行第${c + 1}列${
            piece !== 0 ? ` ${sideOf(piece) === 1 ? '红' : '黑'}${PIECE_CHAR[piece]}` : ''
          }`}
        >
          {piece !== 0 && (
            <span
              className={`x-pc ${sideOf(piece) === 1 ? 'red' : 'black'}${
                willCapture ? ' cap' : ''
              }${i === checkedIdx ? ' checked' : ''}`}
            >
              {PIECE_CHAR[piece]}
            </span>
          )}
          {isTarget && !willCapture && <span className="x-dot" aria-hidden="true" />}
        </div>,
      );
    }
  }

  // 线格层：8×9 个格子，以右边线 + 下边线拼出完整网格；河界带内纵线断开（保留两侧边线）
  const lattice = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const gap = r === 4 && c >= 1 && c <= 6;
      lattice.push(<div key={`${r}-${c}`} className={`x-cell${gap ? ' gap' : ''}`} />);
    }
  }

  return (
    <div className="x-board">
      <div className="x-inner">
        <div className="x-lines" aria-hidden="true">
          {lattice}
        </div>
        <div className="x-palace x-palace-top" aria-hidden="true" />
        <div className="x-palace x-palace-bottom" aria-hidden="true" />
        <div className="x-river" aria-hidden="true">
          <span>楚 河</span>
          <span>汉 界</span>
        </div>
        {points}
      </div>
    </div>
  );
}
