// 游戏状态机：useReducer 集中管理，UI 只发动作、只读状态
import { useReducer } from 'react';
import { Bits, hasPeg, START } from '../engine/board';
import { applyMove, findMove, legalMoves, Move } from '../engine/rules';

export interface DemoState {
  moves: Move[];
  index: number;
}

export interface GameState {
  pegs: Bits;
  history: Bits[];
  moveCount: number;
  selected: number | null;
  lastMove: Move | null;
  hint: Move | null;
  status: 'playing' | 'over';
  demo: DemoState | null;
  thinking: boolean;
  toast: string | null;
}

export type GameAction =
  | { type: 'select'; cell: number }
  | { type: 'play'; move: Move }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'solveStart' }
  | { type: 'hintDone'; moves: Move[] | null; note?: string }
  | { type: 'demoDone'; moves: Move[] | null; note?: string }
  | { type: 'demoStep' }
  | { type: 'stopDemo' }
  | { type: 'clearToast' };

export const initialGame: GameState = {
  pegs: START,
  history: [],
  moveCount: 0,
  selected: null,
  lastMove: null,
  hint: null,
  status: 'playing',
  demo: null,
  thinking: false,
  toast: null,
};

function moveState(state: GameState, move: Move): GameState {
  const pegs = applyMove(state.pegs, move);
  return {
    ...state,
    pegs,
    history: [...state.history, state.pegs],
    moveCount: state.moveCount + 1,
    selected: null,
    hint: null,
    lastMove: move,
    status: legalMoves(pegs).length === 0 ? 'over' : 'playing',
  };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'select': {
      // 求解期间锁定棋盘，避免收到过期的提示结果
      if (state.demo || state.thinking || state.status === 'over') return state;
      const { cell } = action;
      if (hasPeg(state.pegs, cell)) {
        if (state.selected === cell) return { ...state, selected: null };
        const movable = legalMoves(state.pegs).some((m) => m.from === cell);
        return {
          ...state,
          selected: cell,
          hint: null,
          toast: movable ? null : '这颗棋子暂时跳不动',
        };
      }
      if (state.selected != null) {
        const move = findMove(state.pegs, state.selected, cell);
        if (move) return moveState(state, move);
      }
      return { ...state, selected: null };
    }
    case 'play':
      if (state.demo || state.thinking || state.status === 'over') return state;
      return moveState(state, action.move);
    case 'undo': {
      if (state.demo || state.thinking || state.history.length === 0) return state;
      return {
        ...state,
        pegs: state.history[state.history.length - 1],
        history: state.history.slice(0, -1),
        moveCount: state.moveCount - 1,
        selected: null,
        lastMove: null,
        hint: null,
        status: 'playing',
      };
    }
    case 'reset':
      return { ...initialGame };
    case 'solveStart':
      if (state.demo || state.thinking || state.status === 'over') return state;
      return { ...state, thinking: true };
    case 'hintDone': {
      if (!state.thinking) return state; // 过期回复（如已重开）直接丢弃
      return {
        ...state,
        thinking: false,
        hint: action.moves ? action.moves[0] : null,
        toast: action.moves ? '按金色高亮走这一步' : (action.note ?? null),
      };
    }
    case 'demoDone': {
      if (!state.thinking) return state;
      if (action.moves) {
        return {
          ...state,
          thinking: false,
          demo: { moves: action.moves, index: 0 },
        };
      }
      return { ...state, thinking: false, toast: action.note ?? null };
    }
    case 'demoStep': {
      if (!state.demo) return state;
      const { moves, index } = state.demo;
      if (index >= moves.length) return { ...state, demo: null };
      return { ...moveState(state, moves[index]), demo: { moves, index: index + 1 } };
    }
    case 'stopDemo':
      return state.demo === null ? state : { ...state, demo: null };
    case 'clearToast':
      return state.toast === null ? state : { ...state, toast: null };
  }
}

export function useGame() {
  const [state, dispatch] = useReducer(gameReducer, initialGame);
  return { state, dispatch } as const;
}
