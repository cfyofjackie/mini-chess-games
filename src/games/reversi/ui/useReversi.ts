// 黑白棋状态机：引擎之上薄封装一层 reducer（与 gomoku 同构）
import { useReducer } from 'react';
import { ReversiState, initialState, place, undo } from '../engine/reversi';

export type ReversiAction =
  | { type: 'place'; idx: number }
  | { type: 'undo' }
  | { type: 'undoToHuman' }
  | { type: 'reset' }
  | { type: 'clearPass' };

export function reversiReducer(state: ReversiState, action: ReversiAction): ReversiState {
  switch (action.type) {
    case 'place':
      return state.status === 'playing' ? place(state, action.idx) : state;
    case 'undo':
      return undo(state);
    case 'undoToHuman': {
      // 人机模式悔棋：快照逐级弹出，连 AI 的手一起回退，直到轮到人类（黑方）或无可再退。
      // 否则悔一手落在 AI 回合上，AI 会立刻原样重下，悔棋看起来像没生效。
      let s = undo(state);
      while (s.history.length > 0 && s.current !== 1) s = undo(s);
      return s;
    }
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
