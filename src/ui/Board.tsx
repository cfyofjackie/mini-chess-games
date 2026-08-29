// 棋盘渲染：49 格网格，棋子/高亮/动画全部由 props 派生
import { CSSProperties, useMemo } from 'react';
import { Bits, colOf, hasPeg, rowOf, SIZE, VALID_SET } from '../engine/board';
import { Move } from '../engine/rules';

interface BoardProps {
  pegs: Bits;
  selected: number | null;
  targets: number[];
  hint: Move | null;
  lastMove: Move | null;
  interactive: boolean;
  onSelect: (cell: number) => void;
}

export default function Board({
  pegs,
  selected,
  targets,
  hint,
  lastMove,
  interactive,
  onSelect,
}: BoardProps) {
  const targetSet = useMemo(() => new Set(targets), [targets]);
  // 落子滑入动画位移：以自身尺寸（=格子）为单位的百分比
  const dx = lastMove ? `${(colOf(lastMove.from) - colOf(lastMove.to)) * 100}%` : '0%';
  const dy = lastMove ? `${(rowOf(lastMove.from) - rowOf(lastMove.to)) * 100}%` : '0%';

  const cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!VALID_SET.has(i)) {
      cells.push(<div key={i} className="cell invalid" aria-hidden="true" />);
      continue;
    }
    const peg = hasPeg(pegs, i);
    const isTarget = targetSet.has(i);
    const isHintFrom = hint !== null && hint.from === i;
    const isHintTo = hint !== null && hint.to === i;
    const clickable = interactive && (peg || isTarget);
    const isJumpTo = lastMove !== null && lastMove.to === i;
    const slotStyle = isJumpTo ? ({ '--dx': dx, '--dy': dy } as CSSProperties) : undefined;

    cells.push(
      <div
        key={i}
        className={`cell${peg ? ' has-peg' : ''}${clickable ? ' clickable' : ''}`}
        onClick={clickable ? () => onSelect(i) : undefined}
        role={clickable ? 'button' : undefined}
        aria-label={
          peg
            ? `棋子 · 第${rowOf(i) + 1}行第${colOf(i) + 1}列`
            : isTarget
              ? '可落子的空位'
              : undefined
        }
      >
        {peg && (
          <span
            className={`peg-slot${selected === i ? ' selected' : ''}${isHintFrom ? ' hint' : ''}${
              isJumpTo ? ' jump' : ''
            }`}
            style={slotStyle}
          >
            <span className="peg" />
          </span>
        )}
        {!peg && (isTarget || isHintTo) && (
          <span className={`target${isHintTo ? ' gold' : ''}`} />
        )}
        {lastMove !== null && lastMove.over === i && (
          <span key={`ghost-${lastMove.to}`} className="peg-slot vanish">
            <span className="peg" />
          </span>
        )}
      </div>,
    );
  }

  return <div className="board">{cells}</div>;
}
