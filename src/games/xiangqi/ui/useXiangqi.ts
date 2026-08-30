// 象棋状态机：引擎之上薄封装一层 reducer（与 gomoku / reversi 同构），
// 额外维护"当前选中交叉点"这一 UI 状态。
import { useReducer } from 'react';
import {
  initialState,
  legalTargets,
  place,
  sideOf,
  undo,
  type XiangqiState,
} from '../engine/xiangqi';

export interface XiangqiUiState {
  game: XiangqiState;
  /** 当前选中的交叉点 idx，-1 为未选中 */
  selected: number;
}

export type XiangqiAction =
  | { type: 'tap'; idx: number }
  | { type: 'aiMove'; from: number; to: number }
  | { type: 'undo' }
  | { type: 'undoToHuman' }
  | { type: 'reset' };

export function xiangqiReducer(s: XiangqiUiState, action: XiangqiAction): XiangqiUiState {
  switch (action.type) {
    case 'tap': {
      const { game } = s;
      if (game.status !== 'playing') return { ...s, selected: -1 };
      const { idx } = action;
      // 已有选中：点到合法落点则走子
      if (s.selected >= 0 && s.selected !== idx && legalTargets(game, s.selected).includes(idx)) {
        return { game: place(game, s.selected, idx), selected: -1 };
      }
      // 再点同一子取消选择
      if (s.selected === idx) return { ...s, selected: -1 };
      // 点己方棋子：选中 / 换选
      const piece = game.board[idx];
      if (piece !== 0 && sideOf(piece) === game.current) return { ...s, selected: idx };
      // 点空处或对方棋子（非落点）：取消选择
      return { ...s, selected: -1 };
    }
    case 'aiMove': {
      // AI（黑方）落子：与人类同一 place 通路，最后一手高亮 / 悔棋快照 / 终局判定天然复用
      if (s.game.status !== 'playing') return s;
      return { game: place(s.game, action.from, action.to), selected: -1 };
    }
    case 'undo':
      return { game: undo(s.game), selected: -1 };
    case 'undoToHuman': {
      // 人机模式悔棋：快照逐级弹出，连 AI 的应手一起回退，直到轮到人类（红方）或无可再退。
      // 否则悔一手落在 AI 回合上，AI 会立刻原样重下，悔棋看起来像没生效。
      let g = undo(s.game);
      while (g.history.length > 0 && g.current !== 1) g = undo(g);
      return { ...s, game: g, selected: -1 };
    }
    case 'reset':
      return { game: initialState(), selected: -1 };
  }
}

export function useXiangqi() {
  const [state, dispatch] = useReducer(xiangqiReducer, undefined, () => ({
    game: initialState(),
    selected: -1,
  }));
  return { state, dispatch } as const;
}
