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
  | { type: 'undo' }
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
    case 'undo':
      return { game: undo(s.game), selected: -1 };
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
