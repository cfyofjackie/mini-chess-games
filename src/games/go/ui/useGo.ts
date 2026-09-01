// 围棋状态机：引擎之上薄封装一层 reducer（平台惯例）
import { useReducer } from 'react';
import {
  type GoState,
  clearDead,
  confirmScoring,
  initialState,
  pass,
  place,
  toggleDead,
  undo,
} from '../engine/go';

export type GoAction =
  | { type: 'place'; idx: number }
  | { type: 'pass' }
  | { type: 'toggleDead'; idx: number }
  | { type: 'clearDead' }
  | { type: 'confirm' }
  | { type: 'undo' }
  | { type: 'reset' };

export function goReducer(state: GoState, action: GoAction): GoState {
  switch (action.type) {
    case 'place':
      return place(state, action.idx);
    case 'pass':
      return pass(state);
    case 'toggleDead':
      return toggleDead(state, action.idx);
    case 'clearDead':
      return clearDead(state);
    case 'confirm':
      return confirmScoring(state);
    case 'undo':
      return undo(state);
    case 'reset':
      return initialState();
  }
}

export function useGo() {
  const [state, dispatch] = useReducer(goReducer, undefined, initialState);
  return { state, dispatch } as const;
}
