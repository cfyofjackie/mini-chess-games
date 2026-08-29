// 五子棋引擎：15 路棋盘，自由规则（无禁手，长连同样获胜）。全部纯函数。
export const SIZE = 15;
export const CELLS = SIZE * SIZE; // 225

export type Player = 1 | 2; // 1 黑（先行） 2 白
export type Status = 'playing' | 'won' | 'draw';

export interface GomokuState {
  /** 0 空 / 1 黑 / 2 白 */
  board: Int8Array;
  /** 落子序列（悔棋用），idx = r * SIZE + c */
  history: number[];
  current: Player;
  status: Status;
  /** status === 'won' 时为获胜方，否则 0 */
  winner: Player | 0;
  /** 获胜连珠的格子列表（高亮用），无则空 */
  line: number[];
}

export function initialState(): GomokuState {
  return {
    board: new Int8Array(CELLS),
    history: [],
    current: 1,
    status: 'playing',
    winner: 0,
    line: [],
  };
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

// 只围绕最新落子检查四方向连珠；长连（≥5）同样获胜（自由规则）
function winningLine(board: Int8Array, r: number, c: number): number[] {
  const me = board[r * SIZE + c];
  for (const [dr, dc] of DIRS) {
    const cells: number[] = [r * SIZE + c];
    for (const sign of [1, -1] as const) {
      let rr = r + dr * sign;
      let cc = c + dc * sign;
      while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr * SIZE + cc] === me) {
        cells.push(rr * SIZE + cc);
        rr += dr * sign;
        cc += dc * sign;
      }
    }
    if (cells.length >= 5) return cells;
  }
  return [];
}

export function place(state: GomokuState, idx: number): GomokuState {
  if (state.status !== 'playing') return state;
  if (idx < 0 || idx >= CELLS || state.board[idx] !== 0) return state;

  const board = state.board.slice();
  board[idx] = state.current;
  const history = [...state.history, idx];
  const r = Math.floor(idx / SIZE);
  const c = idx % SIZE;

  const line = winningLine(board, r, c);
  if (line.length >= 5) {
    // 胜利时 current 停在获胜方，便于悔棋后仍轮到该方重下
    return { board, history, current: state.current, status: 'won', winner: state.current, line };
  }
  if (history.length === CELLS) {
    return { board, history, current: state.current, status: 'draw', winner: 0, line: [] };
  }
  return {
    board,
    history,
    current: state.current === 1 ? 2 : 1,
    status: 'playing',
    winner: 0,
    line: [],
  };
}

export function undo(state: GomokuState): GomokuState {
  if (state.history.length === 0) return state;
  const history = state.history.slice(0, -1);
  const last = state.history[state.history.length - 1];
  const board = state.board.slice();
  board[last] = 0;
  return {
    board,
    history,
    current: state.status === 'playing' ? (state.current === 1 ? 2 : 1) : state.current,
    status: 'playing',
    winner: 0,
    line: [],
  };
}
