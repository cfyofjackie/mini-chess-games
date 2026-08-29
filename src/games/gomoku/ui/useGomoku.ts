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
  | { type: 'reset' };

export function gomokuReducer(state: GomokuState, action: GomokuAction): GomokuState {
  switch (action.type) {
    case 'place':
      return state.status === 'playing' ? place(state, action.idx) : state;
    case 'undo':
      return undo(state);
    case 'reset':
      return initialState();
  }
}

export function useGomoku() {
  const [state, dispatch] = useReducer(gomokuReducer, undefined, initialState);
  return { state, dispatch } as const;
}
