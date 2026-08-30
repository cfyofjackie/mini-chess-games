// 国际跳棋状态机：引擎之上薄封装一层 reducer（选中态与点击提示为纯 UI 状态）。
// 阶段一为同屏双人：点击己方棋子 → 高亮合法链尾落点（有吃必吃时只亮可吃子及其落点）
// → 点击落点一步完成整个操作（含整条跳链，同中国跳棋建模）。
import { useReducer } from 'react';
import {
  CheckersState,
  initialState,
  movesFrom,
  mustCapture,
  place,
  sideOf,
  undo,
} from '../engine/checkers';

export interface UIState {
  game: CheckersState;
  /** 当前选中棋子的格下标，-1 为未选中 */
  selected: number;
  /** 点击提示文案（有吃必吃/无路可走），空串表示无 */
  hint: string;
}

export type CheckersAction =
  | { type: 'tap'; idx: number }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'clearHint' };

export function uiReducer(state: UIState, action: CheckersAction): UIState {
  switch (action.type) {
    case 'tap': {
      const { game } = state;
      if (game.status !== 'playing') return state;
      const idx = action.idx;
      // 已有选中且点击的是合法链尾落点 → 一步完成整个操作（含整条跳链）
      if (state.selected >= 0 && movesFrom(game, state.selected).some((m) => m.to === idx)) {
        return { game: place(game, state.selected, idx), selected: -1, hint: '' };
      }
      // 点击己方棋子 → 选中 / 再点取消 / 无路提示
      if (game.board[idx] !== 0 && sideOf(game.board[idx]) === game.current) {
        if (state.selected === idx) return { ...state, selected: -1, hint: '' };
        if (movesFrom(game, idx).length === 0) {
          const hint = mustCapture(game)
            ? '有吃必吃：这颗棋子没有吃子路线，请选择可吃子的棋子'
            : '这颗棋子暂时无路可走，换一颗试试';
          return { ...state, selected: -1, hint };
        }
        return { ...state, selected: idx, hint: '' };
      }
      // 点击空位或对方棋子（非落点）→ 取消选中
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

export function useCheckers() {
  const [state, dispatch] = useReducer(uiReducer, undefined, () => ({
    game: initialState(),
    selected: -1,
    hint: '',
  }));
  return { state, dispatch } as const;
}
