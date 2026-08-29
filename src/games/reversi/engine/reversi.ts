// 黑白棋引擎：8×8 棋盘，黑先，夹住翻转；无合法步自动 pass，双方连续无步终局。全部纯函数，零 DOM 依赖。
export const SIZE = 8;
export const CELLS = SIZE * SIZE; // 64

export type Player = 1 | 2; // 1 黑（先行） 2 白
export type Status = 'playing' | 'won' | 'draw';

export interface ReversiState {
  /** 0 空 / 1 黑 / 2 白 */
  board: Int8Array;
  /**
   * 快照栈（悔棋用）：history[i] 是第 i+1 手落子之前的完整状态。
   * pass 被折叠进"引发它的那一手"里，不单独产生快照，因此跨越 pass 的悔棋天然正确。
   */
  history: ReversiState[];
  current: Player;
  status: Status;
  /** status === 'won' 时为胜方，和棋为 0 */
  winner: Player | 0;
  /** 最后一手落子 idx，尚无落子时为 -1 */
  lastMove: number;
  /** 最后一手被翻转的棋子 idx 列表（UI 淡入动画用） */
  flipped: number[];
  /** 最后一手导致被自动跳过的一方（0 = 无人被跳过）；UI 据此提示"×方无合法落子，自动跳过" */
  passedBy: Player | 0;
}

const at = (r: number, c: number) => r * SIZE + c;

export function initialState(): ReversiState {
  const board = new Int8Array(CELLS);
  board[at(3, 3)] = 2; // 白
  board[at(4, 4)] = 2; // 白
  board[at(3, 4)] = 1; // 黑
  board[at(4, 3)] = 1; // 黑
  return {
    board,
    history: [],
    current: 1,
    status: 'playing',
    winner: 0,
    lastMove: -1,
    flipped: [],
    passedBy: 0,
  };
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const other = (p: Player): Player => (p === 1 ? 2 : 1);

/** 假设 player 落在 pos，收集沿 8 方向被夹住、将被翻转的对方棋子；非法落点返回空数组 */
function flipsFor(board: Int8Array, pos: number, player: Player): number[] {
  if (board[pos] !== 0) return [];
  const opp = other(player);
  const r0 = Math.floor(pos / SIZE);
  const c0 = pos % SIZE;
  const out: number[] = [];
  for (const [dr, dc] of DIRS) {
    const line: number[] = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[at(r, c)] === opp) {
      line.push(at(r, c));
      r += dr;
      c += dc;
    }
    // 连续对方棋子之后必须恰好是己方棋子才算夹住（越界/空位都不算）
    if (line.length > 0 && r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[at(r, c)] === player) {
      out.push(...line);
    }
  }
  return out;
}

/** 当前轮到 player 的全部合法落点（合法空位 = 至少夹住一枚对方棋子） */
export function legalMoves(state: ReversiState): number[] {
  if (state.status !== 'playing') return [];
  const moves: number[] = [];
  for (let pos = 0; pos < CELLS; pos++) {
    if (state.board[pos] === 0 && flipsFor(state.board, pos, state.current).length > 0) {
      moves.push(pos);
    }
  }
  return moves;
}

function hasMove(board: Int8Array, player: Player): boolean {
  for (let pos = 0; pos < CELLS; pos++) {
    if (board[pos] === 0 && flipsFor(board, pos, player).length > 0) return true;
  }
  return false;
}

/** 双方子数 */
export function discCounts(board: Int8Array): { black: number; white: number } {
  let black = 0;
  let white = 0;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === 1) black++;
    else if (board[i] === 2) white++;
  }
  return { black, white };
}

/**
 * 在 pos 落子（pos 必须是 current 的合法落点，否则原样返回同一状态）：
 * 翻转所有被夹住的对方棋子 → 对方有步则换手；
 * 对方无步而己方有步 → 自动 pass（轮次不变，passedBy 标记）；
 * 双方均无步 → 终局，子多者胜、等数和棋。
 */
export function place(state: ReversiState, pos: number): ReversiState {
  if (state.status !== 'playing') return state;
  if (pos < 0 || pos >= CELLS) return state;
  const flips = flipsFor(state.board, pos, state.current);
  if (flips.length === 0) return state; // 非法：占用已有棋子或不夹子

  const board = state.board.slice();
  board[pos] = state.current;
  for (const f of flips) board[f] = state.current;

  const next: ReversiState = {
    board,
    history: [...state.history, state], // 落子前状态压栈，悔棋直接弹出
    current: state.current,
    status: 'playing',
    winner: 0,
    lastMove: pos,
    flipped: flips,
    passedBy: 0,
  };

  const opp = other(state.current);
  if (hasMove(board, opp)) {
    return { ...next, current: opp };
  }
  if (hasMove(board, state.current)) {
    // 对方无合法步：自动跳过，己方连续行动
    return { ...next, passedBy: opp };
  }
  // 双方连续均无合法步（含棋盘下满）→ 终局
  const { black, white } = discCounts(board);
  return black === white
    ? { ...next, status: 'draw', winner: 0, passedBy: opp }
    : { ...next, status: 'won', winner: black > white ? 1 : 2, passedBy: opp };
}

/** 悔棋一步：弹出快照栈顶（即上一手落子之前的状态）；空栈原样返回 */
export function undo(state: ReversiState): ReversiState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}
