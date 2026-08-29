// 中国象棋引擎：9 列 × 10 行交叉点棋盘（idx = r * COLS + c），红先、红在下方。
// 全部纯函数，零 DOM 依赖。飞将规则以"将帅同列无遮挡 = 被将"并入将军检测，
// 合法步 = 伪合法步 − 走完后己方被将军（含构成将帅照面）的局面。
export const COLS = 9;
export const ROWS = 10;
export const CELLS = ROWS * COLS; // 90

export type Player = 1 | 2; // 1 红（先行，棋盘下方） 2 黑
export type Status = 'playing' | 'won';
export type EndReason = '' | 'checkmate' | 'stalemate'; // 将死 / 困毙

/** 棋子编码：1–7 红方（帅仕相马车炮兵），8–14 黑方（将士象马车炮卒），0 为空 */
export const R_K = 1;
export const R_A = 2;
export const R_B = 3;
export const R_N = 4;
export const R_R = 5;
export const R_C = 6;
export const R_P = 7;
export const B_K = 8;
export const B_A = 9;
export const B_B = 10;
export const B_N = 11;
export const B_R = 12;
export const B_C = 13;
export const B_P = 14;

/** 棋子显示字（马/车/炮红黑同字，仅颜色区分） */
export const PIECE_CHAR: Readonly<Record<number, string>> = {
  [R_K]: '帅',
  [R_A]: '仕',
  [R_B]: '相',
  [R_N]: '马',
  [R_R]: '车',
  [R_C]: '炮',
  [R_P]: '兵',
  [B_K]: '将',
  [B_A]: '士',
  [B_B]: '象',
  [B_N]: '马',
  [B_R]: '车',
  [B_C]: '炮',
  [B_P]: '卒',
};

export interface Move {
  from: number;
  to: number;
}

export interface XiangqiState {
  /** 棋盘：0 空，其余为棋子编码；下标 idx = r * COLS + c */
  board: Int8Array;
  /** 快照栈（悔棋用）：history[i] 为第 i+1 手走子之前的完整状态 */
  history: XiangqiState[];
  current: Player;
  status: Status;
  /** status === 'won' 时为胜方 */
  winner: Player | 0;
  /** 终局原因：checkmate 将死 / stalemate 困毙；对局中为 '' */
  reason: EndReason;
  /** 轮到走子的一方是否正被将军（状态条"将军！"提示） */
  check: boolean;
  /** 最后一手的 from/to，尚无走子时为 -1 */
  lastFrom: number;
  lastTo: number;
}

// ---------- 几何与方向 ----------

const at = (r: number, c: number) => r * COLS + c;
const rowOf = (i: number) => Math.floor(i / COLS);
const colOf = (i: number) => i % COLS;
const onBoard = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
/** 九宫（双方通用：列 3–5，行 0–2 或 7–9） */
const inPalace = (r: number, c: number) => c >= 3 && c <= 5 && (r <= 2 || r >= 7);
/** 是否已过河（红 r ≤ 4，黑 r ≥ 5；河界在第 4/5 行之间） */
const crossedRiver = (r: number, side: Player) => (side === 1 ? r <= 4 : r >= 5);
/** 己方半场（相/象不可越河） */
const ownHalf = (r: number, side: Player) => (side === 1 ? r >= 5 : r <= 4);

export const sideOf = (piece: number): Player => (piece < 8 ? 1 : 2);
const other = (p: Player): Player => (p === 1 ? 2 : 1);

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const DIAG: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
/** 马的 8 个日字方向（从马位到目标位的偏移） */
const KNIGHT: ReadonlyArray<readonly [number, number]> = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];
/** 相/象的 4 个田字方向 */
const ELEPHANT: ReadonlyArray<readonly [number, number]> = [
  [-2, -2],
  [-2, 2],
  [2, -2],
  [2, 2],
];

// ---------- 初始局面 ----------

export function initialState(): XiangqiState {
  const board = new Int8Array(CELLS);
  const setup: Array<[number, number, number]> = [
    // 黑方（上方）
    [0, 0, B_R], [0, 1, B_N], [0, 2, B_B], [0, 3, B_A], [0, 4, B_K],
    [0, 5, B_A], [0, 6, B_B], [0, 7, B_N], [0, 8, B_R],
    [2, 1, B_C], [2, 7, B_C],
    [3, 0, B_P], [3, 2, B_P], [3, 4, B_P], [3, 6, B_P], [3, 8, B_P],
    // 红方（下方）
    [9, 0, R_R], [9, 1, R_N], [9, 2, R_B], [9, 3, R_A], [9, 4, R_K],
    [9, 5, R_A], [9, 6, R_B], [9, 7, R_N], [9, 8, R_R],
    [7, 1, R_C], [7, 7, R_C],
    [6, 0, R_P], [6, 2, R_P], [6, 4, R_P], [6, 6, R_P], [6, 8, R_P],
  ];
  for (const [r, c, p] of setup) board[at(r, c)] = p;
  return {
    board,
    history: [],
    current: 1,
    status: 'playing',
    winner: 0,
    reason: '',
    check: false,
    lastFrom: -1,
    lastTo: -1,
  };
}

// ---------- 走法生成 ----------

/**
 * from 处棋子的伪合法落点（不考虑己方被将 / 将帅照面）。
 * 约定：将/帅不可被吃（合法对局中不会发生，飞将规则在合法性过滤中处理）。
 */
export function pseudoTargets(board: Int8Array, from: number): number[] {
  const piece = board[from];
  if (piece === 0) return [];
  const side = sideOf(piece);
  const type = (piece - 1) % 7; // 0帅 1仕 2相 3马 4车 5炮 6兵
  const r = rowOf(from);
  const c = colOf(from);
  const enemyKing = side === 1 ? B_K : R_K;
  const out: number[] = [];
  const landable = (nr: number, nc: number): boolean => {
    const t = board[at(nr, nc)];
    return t === 0 || (sideOf(t) !== side && t !== enemyKing);
  };
  const push = (nr: number, nc: number) => {
    if (onBoard(nr, nc) && landable(nr, nc)) out.push(at(nr, nc));
  };

  switch (type) {
    case 0: {
      // 帅/将：九宫内每步一格直行
      for (const [dr, dc] of ORTHO) {
        const nr = r + dr;
        const nc = c + dc;
        if (onBoard(nr, nc) && inPalace(nr, nc)) push(nr, nc);
      }
      break;
    }
    case 1: {
      // 仕/士：九宫内斜一格
      for (const [dr, dc] of DIAG) {
        const nr = r + dr;
        const nc = c + dc;
        if (onBoard(nr, nc) && inPalace(nr, nc)) push(nr, nc);
      }
      break;
    }
    case 2: {
      // 相/象：田字（斜两格），塞象眼，不可过河
      for (const [dr, dc] of ELEPHANT) {
        const nr = r + dr;
        const nc = c + dc;
        if (!onBoard(nr, nc) || !ownHalf(nr, side)) continue;
        if (board[at(r + dr / 2, c + dc / 2)] !== 0) continue; // 象眼被塞
        push(nr, nc);
      }
      break;
    }
    case 3: {
      // 马：日字，蹩马腿（先直后斜的那一格有子不可走该方向）
      for (const [dr, dc] of KNIGHT) {
        const nr = r + dr;
        const nc = c + dc;
        if (!onBoard(nr, nc)) continue;
        const lr = r + (Math.abs(dr) === 2 ? dr / 2 : 0);
        const lc = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
        if (board[at(lr, lc)] !== 0) continue; // 马腿被蹩
        push(nr, nc);
      }
      break;
    }
    case 4: {
      // 车：直线任意距离，不可越子
      for (const [dr, dc] of ORTHO) {
        let nr = r + dr;
        let nc = c + dc;
        while (onBoard(nr, nc)) {
          const t = board[at(nr, nc)];
          if (t === 0) {
            out.push(at(nr, nc));
          } else {
            if (sideOf(t) !== side && t !== enemyKing) out.push(at(nr, nc));
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      break;
    }
    case 5: {
      // 炮：平移同车；吃子必须隔恰好一个炮架
      for (const [dr, dc] of ORTHO) {
        let nr = r + dr;
        let nc = c + dc;
        let hasScreen = false;
        while (onBoard(nr, nc)) {
          const t = board[at(nr, nc)];
          if (!hasScreen) {
            if (t === 0) out.push(at(nr, nc));
            else hasScreen = true; // 遇到的第一个子成为炮架
          } else if (t !== 0) {
            if (sideOf(t) !== side && t !== enemyKing) out.push(at(nr, nc));
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      break;
    }
    default: {
      // 兵/卒：过河前每步只能前进；过河后可前进或左右横移；永不后退
      const fwd = side === 1 ? -1 : 1;
      push(r + fwd, c);
      if (crossedRiver(r, side)) {
        push(r, c - 1);
        push(r, c + 1);
      }
      break;
    }
  }
  return out;
}

// ---------- 将军检测 ----------

/** 找到 player 的将/帅所在交叉点，找不到返回 -1 */
function findGeneral(board: Int8Array, player: Player): number {
  const king = player === 1 ? R_K : B_K;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === king) return i;
  }
  return -1;
}

/** (tr, tc) 是否被 by 一方攻击。覆盖：车、马（含蹩腿）、炮（隔一炮架）、兵/卒、将帅飞将（同列无遮挡） */
function isAttacked(board: Int8Array, tr: number, tc: number, by: Player): boolean {
  const nP = by === 1 ? R_N : B_N;
  const rP = by === 1 ? R_R : B_R;
  const cP = by === 1 ? R_C : B_C;
  const pP = by === 1 ? R_P : B_P;
  const kP = by === 1 ? R_K : B_K;

  // 马：马位在目标的日字偏移处，且马腿（靠马的直行格）为空
  for (const [dr, dc] of KNIGHT) {
    const nr = tr + dr;
    const nc = tc + dc;
    if (!onBoard(nr, nc) || board[at(nr, nc)] !== nP) continue;
    const lr = nr + (Math.abs(dr) === 2 ? -dr / 2 : 0);
    const lc = nc + (Math.abs(dc) === 2 ? -dc / 2 : 0);
    if (board[at(lr, lc)] === 0) return true;
  }

  // 四个正方向：车 / 飞将（遇到的第一个子）/ 炮（隔一炮架后的第一个子）
  for (const [dr, dc] of ORTHO) {
    let nr = tr + dr;
    let nc = tc + dc;
    let hasScreen = false;
    while (onBoard(nr, nc)) {
      const t = board[at(nr, nc)];
      if (t !== 0) {
        if (!hasScreen) {
          if (t === rP || (t === kP && dc === 0)) return true; // 飞将仅限同列
          hasScreen = true;
        } else {
          if (t === cP) return true;
          break;
        }
      }
      nr += dr;
      nc += dc;
    }
  }

  // 兵/卒：红兵从下侧正面吃、黑卒从上侧正面吃；过河后可横吃
  const pr = tr + (by === 1 ? 1 : -1);
  if (onBoard(pr, tc) && board[at(pr, tc)] === pP) return true;
  if (by === 1 ? tr <= 4 : tr >= 5) {
    if (tc > 0 && board[at(tr, tc - 1)] === pP) return true;
    if (tc < COLS - 1 && board[at(tr, tc + 1)] === pP) return true;
  }
  return false;
}

/** player 是否正被将军（含两将同列无遮挡的飞将局面） */
export function isInCheck(board: Int8Array, player: Player): boolean {
  const g = findGeneral(board, player);
  if (g < 0) return false;
  return isAttacked(board, rowOf(g), colOf(g), other(player));
}

// ---------- 合法步 ----------

/** 走完 from→to 后 player 是否安全（不被将军，含不构成将帅照面） */
function isSafeAfter(board: Int8Array, from: number, to: number, player: Player): boolean {
  const next = board.slice();
  next[to] = next[from];
  next[from] = 0;
  return !isInCheck(next, player);
}

/** 当前状态下 from 处己方棋子的全部合法落点 */
export function legalTargets(state: XiangqiState, from: number): number[] {
  if (state.status !== 'playing') return [];
  const piece = state.board[from];
  if (piece === 0 || sideOf(piece) !== state.current) return [];
  return pseudoTargets(state.board, from).filter((to) =>
    isSafeAfter(state.board, from, to, state.current),
  );
}

/** player 在该棋盘上的全部合法步（终局判定用） */
export function allLegalMoves(board: Int8Array, player: Player): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < CELLS; from++) {
    const piece = board[from];
    if (piece === 0 || sideOf(piece) !== player) continue;
    for (const to of pseudoTargets(board, from)) {
      if (isSafeAfter(board, from, to, player)) moves.push({ from, to });
    }
  }
  return moves;
}

// ---------- 走子 / 悔棋 ----------

/**
 * 走子 from→to（必须是 current 的合法步，否则原样返回同一状态）。
 * 走完后轮到对方若无任何合法步：正被将军 = 将死，否则 = 困毙，均判负。
 */
export function place(state: XiangqiState, from: number, to: number): XiangqiState {
  if (state.status !== 'playing') return state;
  if (from < 0 || from >= CELLS || to < 0 || to >= CELLS || from === to) return state;
  const piece = state.board[from];
  if (piece === 0 || sideOf(piece) !== state.current) return state;
  if (!legalTargets(state, from).includes(to)) return state;

  const board = state.board.slice();
  board[to] = piece;
  board[from] = 0;

  const opp = other(state.current);
  const next: XiangqiState = {
    board,
    history: [...state.history, state], // 走子前状态压栈，悔棋直接弹出
    current: opp,
    status: 'playing',
    winner: 0,
    reason: '',
    check: isInCheck(board, opp),
    lastFrom: from,
    lastTo: to,
  };

  // 轮到一方无合法步即负：被将军为将死，未被将军为困毙（中国象棋无逼和）
  if (allLegalMoves(board, opp).length === 0) {
    return { ...next, status: 'won', winner: state.current, reason: next.check ? 'checkmate' : 'stalemate' };
  }
  return next;
}

/** 悔棋一步：弹出快照栈顶（上一手走子之前的状态）；空栈原样返回 */
export function undo(state: XiangqiState): XiangqiState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}
