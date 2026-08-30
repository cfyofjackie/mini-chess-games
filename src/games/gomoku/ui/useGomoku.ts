// 五子棋状态机：引擎之上薄封装一层 reducer
import { useReducer } from 'react';
import {
  GomokuState,
  initialState,
  place,
  undo,
} from '../engine/gomoku';

export type GomokuAction =
  | { type: 'place'; idx: number }
  | { type: 'undo' }
  | { type: 'undoToHuman' }
  | { type: 'reset' };

export function gomokuReducer(state: GomokuState, action: GomokuAction): GomokuState {
  switch (action.type) {
    case 'place':
      return state.status === 'playing' ? place(state, action.idx) : state;
    case 'undo':
      return undo(state);
    case 'undoToHuman': {
      // 人机模式悔棋：连 AI 的手一起回退，直到轮到人类（黑方）或无可再退。
      // 否则悔一手落在 AI 回合上，AI 会立刻原样重下，悔棋看起来像没生效。
      let s = undo(state);
      while (s.history.length > 0 && s.current !== 1) s = undo(s);
      return s;
    }
    case 'reset':
      return initialState();
  }
}

export function useGomoku() {
  const [state, dispatch] = useReducer(gomokuReducer, undefined, initialState);
  return { state, dispatch } as const;
}
