// 国际象棋棋盘：8×8 明暗格（白在下），Unicode 棋子（两色均实心字形，白/黑由 CSS 上色区分，B1）；
// 选中 / 合法落点（空格圆点、可吃子含吃过路兵红环）/ 最后一手 / 被将军王格均有高亮标记；
// A2 落子滑动：落点棋子带 --dx/--dy 位移的滑入动画（人类与 AI 落子共用）；
// A3 被吃淡出：被吃棋子以幽灵元素在原格缩小淡出；两者均以着法序号作 key，换手即重触发。
// 第十二节坐标标注：外框左侧 8–1 行标、下侧 a–h 列标（白方视角，半透明小字不挤压棋盘格）；
// 第十二节吃子托盘：棋盘上（黑方吃掉的白子）/下（白方吃掉的黑子）各一排，
//   数据由 ui/captured.ts 从 history 快照提取（按被吃顺序），按价值降序 ×N 显示，随走子/悔棋实时更新。
import type { CSSProperties } from 'react';
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
import { lastMoveInfo } from './moveText';
import { capturedPieces, trayGroups, type TrayGroup } from './captured';
import { kingNeighborReasons, type NeighborReason } from './hints';

/**
 * Unicode 实心棋子字形（♚♛♜♝♞♟）：白方渲染为实心白 + 深描边、黑方实心近黑 + 浅描边（B1），
 * 明暗两种格子上均一眼可辨；颜色与描边见 chess.css 的 .c-pc.white / .c-pc.black。
 */
const GLYPHS: Record<number, string> = {
  [W_KING]: '♚',
  [W_QUEEN]: '♛',
  [W_ROOK]: '♜',
  [W_BISHOP]: '♝',
  [W_KNIGHT]: '♞',
  [W_PAWN]: '♟',
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

/** 王邻格徽标文案（规格书第九节：己方占位=己 / 空格受攻=攻 / 敌子受保护=守） */
const BADGE_TEXT: Record<NeighborReason, string> = {
  own: '己',
  attacked: '攻',
  defended: '守',
};

/** 第十二节坐标标注（白方视角）：下边 a–h 列标（左→右） */
const FILE_LABELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
/** 第十二节坐标标注（白方视角）：左边 8–1 行标（上→下，row 0 为第 8 横线） */
const RANK_LABELS = ['8', '7', '6', '5', '4', '3', '2', '1'];

interface BoardProps {
  state: ChessState;
  /** 当前选中格 idx，-1 为未选中 */
  selected: number;
  onTap: (idx: number) => void;
  /** 教练提示阶梯高亮（二级起点/被吃目标，三级起点+终点）；undefined = 不高亮（教练关闭零 UI 变化） */
  hint?: { from: number; to: number; level: 1 | 2 | 3; capture: boolean } | null;
}

export function sideName(p: Player): string {
  return p === 1 ? '白方' : '黑方';
}

/** 第十二节吃子托盘：一排被吃棋子（价值降序，同型多子 ×N）；由 state 派生，走子/悔棋/复盘跳转自动更新 */
function Tray({ groups, label }: { groups: TrayGroup[]; label: string }) {
  return (
    <div className="c-tray" role="img" aria-label={label}>
      {groups.map((g) => (
        <span key={g.piece} className="c-tray-item">
          <span
            className={`c-pc ${sideOf(g.piece) === 1 ? 'white' : 'black'}`}
            aria-hidden="true"
          >
            {GLYPHS[g.piece]}
          </span>
          {g.count > 1 && <span className="c-tray-n">×{g.count}</span>}
        </span>
      ))}
    </div>
  );
}

export default function Board({ state, selected, onTap, hint }: BoardProps) {
  const playable = state.status === 'playing';
  const targets =
    playable && selected >= 0 ? new Set(legalTargets(state, selected)) : new Set<number>();
  const selectedPiece = selected >= 0 ? state.board[selected] : 0;
  const selPawn = selectedPiece === W_PAWN || selectedPiece === B_PAWN;
  // 被将军时高亮当前一方王的所在格
  const checkedIdx = state.check
    ? state.board.indexOf(state.current === 1 ? W_KING : B_KING)
    : -1;
  // 第九节王邻格徽标：选中王时，邻格中不可用格标注原因（合法落点不标注，见 hints.ts）
  const badges =
    playable && selected >= 0 ? new Map(kingNeighborReasons(state, selected).map((b) => [b.idx, b.reason])) : new Map<number, NeighborReason>();
  // 第十节提示阶梯：二级高亮起点（吃子加被吃目标），三级高亮起点+终点；一级纯文字不点亮
  const hintFrom = hint ? hint.from : -1;
  const hintTo = hint && hint.level === 3 ? hint.to : -1;
  const hintCap = hint && hint.level === 2 && hint.capture ? hint.to : -1;

  // A2/A3：最近一手（人类与 AI 共用）。key 取着法序号（history 长度），
  // 换手 / 悔棋回放都会换 key 重触发动画，且状态回退后不残留任何动画。
  const seq = state.history.length;
  const last = lastMoveInfo(state);
  // 落点棋子滑入位移：以自身尺寸（=格子）为单位的百分比
  const dx = last ? `${((last.from % 8) - (last.to % 8)) * 100}%` : '0%';
  const dy = last ? `${((Math.floor(last.from / 8)) - Math.floor(last.to / 8)) * 100}%` : '0%';
  const ghost = last?.captured ?? null;

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
      const isSlideTo = last !== null && i === last.to;
      const slotStyle = isSlideTo ? ({ '--dx': dx, '--dy': dy } as CSSProperties) : undefined;
      const badge = badges.get(i);

      const cls = [
        'c-cell',
        (r + c) % 2 === 0 ? 'light' : 'dark',
        clickable ? 'clickable' : '',
        isSelected ? 'selected' : '',
        isLast ? 'last' : '',
        i === checkedIdx ? 'check' : '',
        i === hintFrom ? 'hint-from' : '',
        i === hintTo ? 'hint-to' : '',
        i === hintCap ? 'hint-cap' : '',
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
            <span
              key={isSlideTo ? `m${seq}` : 'pc'}
              className={`c-pc ${sideOf(piece) === 1 ? 'white' : 'black'}${
                isSlideTo ? ' slide' : ''
              }`}
              style={slotStyle}
            >
              {GLYPHS[piece]}
            </span>
          )}
          {ghost !== null && i === ghost.idx && (
            <span
              key={`ghost-${seq}`}
              className={`c-pc c-ghost ${sideOf(ghost.piece) === 1 ? 'white' : 'black'}`}
              aria-hidden="true"
            >
              {GLYPHS[ghost.piece]}
            </span>
          )}
          {isTarget && !willCapture && <span className="c-dot" aria-hidden="true" />}
          {willCapture && <span className="c-ring" aria-hidden="true" />}
          {badge && (
            <span className={`c-badge c-badge-${badge}`} aria-hidden="true">
              {BADGE_TEXT[badge]}
            </span>
          )}
        </div>,
      );
    }
  }

  // 第十二节吃子托盘：上排 = 黑方吃掉的白子，下排 = 白方吃掉的黑子；
  // 从 history 快照按被吃顺序提取（captured.ts），按价值降序 ×N 显示
  const captures = capturedPieces(state);

  return (
    <div className="c-board-zone">
      <Tray groups={trayGroups(captures.byBlack)} label="黑方吃掉的白子" />
      <div className="c-board-wrap">
        <div className="c-coord c-coord-ranks" aria-hidden="true">
          {RANK_LABELS.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
        <div className="c-board">{cells}</div>
        <div className="c-coord c-coord-files" aria-hidden="true">
          {FILE_LABELS.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      </div>
      <Tray groups={trayGroups(captures.byWhite)} label="白方吃掉的黑子" />
    </div>
  );
}
