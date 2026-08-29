// 黑白棋状态机：引擎之上薄封装一层 reducer（与 gomoku 同构）
import { useReducer } from 'react';
import { ReversiState, initialState, place, undo } from '../engine/reversi';

export type ReversiAction =
  | { type: 'place'; idx: number }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'clearPass' };

export function reversiReducer(state: ReversiState, action: ReversiAction): ReversiState {
  switch (action.type) {
    case 'place':
      return state.status === 'playing' ? place(state, action.idx) : state;
    case 'undo':
      return undo(state);
    case 'reset':
      return initialState();
    case 'clearPass':
      // 仅清除 UI 提示标记，不影响棋盘与快照栈
      return state.passedBy === 0 ? state : { ...state, passedBy: 0 };
  }
}

export function useReversi() {
  const [state, dispatch] = useReducer(reversiReducer, undefined, initialState);
  return { state, dispatch } as const;
}
