// 国际象棋状态机：引擎之上薄封装一层 reducer（与 gomoku / reversi / xiangqi 同构），
// 额外维护"当前选中格"与"待决升变"两个 UI 状态。
import { useReducer } from 'react';
import {
  initialState,
  legalTargets,
  makeMove,
  needsPromotion,
  sideOf,
  undo,
  type ChessState,
  type Promotion,
} from '../engine/chess';

export interface ChessUiState {
  game: ChessState;
  /** 当前选中的格 idx，-1 为未选中 */
  selected: number;
  /** 待决升变：兵已点到升变落点，等待玩家选择升变子（后/车/象/马）；null 为无 */
  pending: { from: number; to: number } | null;
}

export type ChessAction =
  | { type: 'tap'; idx: number }
  | { type: 'promote'; piece: Promotion }
  | { type: 'cancelPromotion' }
  | { type: 'aiMove'; from: number; to: number; promotion?: Promotion }
  | { type: 'undo' }
  | { type: 'undoToHuman' }
  | { type: 'reset' };

export function chessReducer(s: ChessUiState, action: ChessAction): ChessUiState {
  switch (action.type) {
    case 'tap': {
      const { game } = s;
      if (game.status !== 'playing') return { ...s, selected: -1, pending: null };
      // 升变弹窗打开时浮层遮挡棋盘，正常点不到；防御性忽略
      if (s.pending) return s;
      const { idx } = action;
      // 已有选中：点到合法落点——升变步先弹选择浮层，其余直接走子
      if (s.selected >= 0 && s.selected !== idx && legalTargets(game, s.selected).includes(idx)) {
        if (needsPromotion(game, s.selected, idx)) {
          return { ...s, pending: { from: s.selected, to: idx } };
        }
        return { game: makeMove(game, s.selected, idx), selected: -1, pending: null };
      }
      // 再点同一子取消选择
      if (s.selected === idx) return { ...s, selected: -1 };
      // 点己方棋子：选中 / 换选
      const piece = game.board[idx];
      if (piece !== 0 && sideOf(piece) === game.current) return { ...s, selected: idx };
      // 点空处或对方棋子（非落点）：取消选择
      return { ...s, selected: -1 };
    }
    case 'promote': {
      if (!s.pending) return s;
      const { from, to } = s.pending;
      // makeMove 会对非法升变子同引用拒绝，此处正常传入浮层选择结果
      return { game: makeMove(s.game, from, to, action.piece), selected: -1, pending: null };
    }
    case 'aiMove': {
      // AI（黑方）落子：与人类同一 makeMove 通路（升变步由 AI 显式携带升变子）
      if (s.game.status !== 'playing') return s;
      return {
        game: makeMove(s.game, action.from, action.to, action.promotion),
        selected: -1,
        pending: null,
      };
    }
    case 'cancelPromotion':
      // 取消：回到选子前状态（清除选中与待决），可改走别的步
      return { ...s, selected: -1, pending: null };
    case 'undo':
      return { game: undo(s.game), selected: -1, pending: null };
    case 'undoToHuman': {
      // 人机模式悔棋：快照逐级弹出，连 AI 的手一起回退，直到轮到人类（白方）或无可再退。
      // 否则悔一手落在 AI 回合上，AI 会立刻原样重下，悔棋看起来像没生效。
      let g = undo(s.game);
      while (g.history.length > 0 && g.current !== 1) g = undo(g);
      return { ...s, game: g, selected: -1, pending: null };
    }
    case 'reset':
      return { game: initialState(), selected: -1, pending: null };
  }
}

export function useChess() {
  const [state, dispatch] = useReducer(chessReducer, undefined, () => ({
    game: initialState(),
    selected: -1,
    pending: null,
  }));
  return { state, dispatch } as const;
}
