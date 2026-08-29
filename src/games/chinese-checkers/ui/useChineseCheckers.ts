// 中国跳棋状态机：引擎之上薄封装一层 reducer（选中态与点击提示为纯 UI 状态）
import { useReducer } from 'react';
import { CCState, initialState, movesFrom, place, undo } from '../engine/chinese-checkers';

export interface UIState {
  game: CCState;
  /** 当前选中棋子的孔下标，-1 为未选中 */
  selected: number;
  /** 点击提示文案（不可动棋子等），空串表示无 */
  hint: string;
}

export type CCAction =
  | { type: 'tap'; idx: number }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'clearHint' };

export function uiReducer(state: UIState, action: CCAction): UIState {
  switch (action.type) {
    case 'tap': {
      const { game } = state;
      if (game.status !== 'playing') return state;
      const idx = action.idx;
      // 已有选中且点击的是可达终点 → 一步完成整个操作（含跳链）
      if (state.selected >= 0 && movesFrom(game, state.selected).includes(idx)) {
        return { game: place(game, state.selected, idx), selected: -1, hint: '' };
      }
      // 点击己方棋子 → 选中 / 再点取消 / 无路提示
      if (game.board[idx] === game.current) {
        if (state.selected === idx) return { ...state, selected: -1, hint: '' };
        if (movesFrom(game, idx).length === 0) {
          return { ...state, selected: -1, hint: '这颗棋子暂时无路可走，换一颗试试' };
        }
        return { ...state, selected: idx, hint: '' };
      }
      // 点击空位或对方棋子 → 取消选中
      return state.selected === -1 && state.hint === ''
        ? state
        : { ...state, selected: -1, hint: '' };
    }
    case 'undo':
      return { game: undo(state.game), selected: -1, hint: '' };
    case 'reset':
      return { game: initialState(), selected: -1, hint: '' };
    case 'clearHint':
      return state.hint === '' ? state : { ...state, hint: '' };
  }
}

export function useChineseCheckers() {
  const [state, dispatch] = useReducer(uiReducer, undefined, () => ({
    game: initialState(),
    selected: -1,
    hint: '',
  }));
  return { state, dispatch } as const;
}
