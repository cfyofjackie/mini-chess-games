// 围棋棋盘：SIZE×SIZE 交叉点网格（线条 / 星位 / 棋子 / 最后一手标记 / 死子标记 / 劫禁点）。
// 尺寸与星位全部取自引擎常量，换盘径零改组件（为学堂关卡 Runner 留同样的参数化接缝）。
import { type GoState, SIZE, STAR_POINTS } from '../engine/go';

interface BoardProps {
  state: GoState;
  /** 对局阶段的引擎合法落点（悬停预览与可点性）；标记阶段忽略 */
  legal: ReadonlySet<number>;
  /** 交叉点被点击：对局阶段 = 落子，标记阶段 = 切换死子（语义由 Game 分派） */
  onPick: (idx: number) => void;
}

export default function Board({ state, legal, onPick }: BoardProps) {
  const marking = state.status === 'marking';
  const deadSet = new Set(state.dead);
  const starSet = new Set(STAR_POINTS.map(([r, c]) => r * SIZE + c));

  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      const stone = state.board[i];
      const cls = ['go-cell'];
      if (r === 0) cls.push('et');
      if (r === SIZE - 1) cls.push('eb');
      if (c === 0) cls.push('el');
      if (c === SIZE - 1) cls.push('er');
      if (starSet.has(i)) cls.push('star');
      // 对局阶段只有合法空点可点（自杀 / 劫禁点不亮），标记阶段只有棋子可点
      const clickable = marking ? stone !== 0 : state.status === 'playing' && stone === 0 && legal.has(i);
      if (clickable) cls.push('clickable');

      cells.push(
        <div
          key={i}
          className={cls.join(' ')}
          onClick={clickable ? () => onPick(i) : undefined}
          role={clickable ? 'button' : undefined}
          aria-label={
            clickable
              ? marking
                ? `标记第${r + 1}行第${c + 1}列`
                : `落子第${r + 1}行第${c + 1}列`
              : undefined
          }
        >
          {stone !== 0 && (
            <span
              className={`go-stone ${stone === 1 ? 'black' : 'white'}${
                i === state.lastMove ? ' last' : ''
              }${deadSet.has(i) ? ' dead' : ''}`}
            />
          )}
          {state.status === 'playing' && i === state.koPoint && (
            <span className="go-ko" aria-hidden="true" />
          )}
        </div>,
      );
    }
  }

  return <div className="go-board">{cells}</div>;
}
