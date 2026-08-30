// 国际跳棋（英式 8×8）引擎：64 格棋盘只走深色格，红方（1）居下先行向上走、白方（2）居上向下走。
// 规则要点：普通兵只能斜前进一格；斜跳过相邻敌子落到其后的空格即吃子；
// 有吃必吃，且连跳链必须走到不能再跳（链中可变向；普通兵跳入底线即成王并结束该手——英式规则）；
// 王沿斜向四方向走/跳。一方无子或无合法步判负；双方各剩一王且连续无吃子达阈值判和。
// 一次操作 = 一步或一条完整跳链，UI 点击落点一步直达链尾（同中国跳棋建模）。
// 全部纯函数，零 DOM 依赖。

export const SIZE = 8;
export const CELLS = SIZE * SIZE; // 64

export type Player = 1 | 2; // 1 红方（下方先行，向上） 2 白方（上方，向下）
export type Status = 'playing' | 'won' | 'draw';
/** 终局原因：cleared 吃光对方 / blocked 对方无合法步（困毙）/ no-progress 双王无进展判和 */
export type EndReason = '' | 'cleared' | 'blocked' | 'no-progress';

/** 棋子编码：0 空 / 1 红兵 / 2 白兵 / 3 红王 / 4 白王 */
export const EMPTY = 0;
export const MAN_1 = 1;
export const MAN_2 = 2;
export const KING_1 = 3;
export const KING_2 = 4;

export const at = (r: number, c: number) => r * SIZE + c;
export const rowOf = (i: number) => Math.floor(i / SIZE);
export const colOf = (i: number) => i % SIZE;
/** 深色格（唯一可落子/行棋的格）：行号+列号为奇数 */
export const isDark = (r: number, c: number) => (r + c) % 2 === 1;

export function sideOf(piece: number): Player | 0 {
  if (piece === MAN_1 || piece === KING_1) return 1;
  if (piece === MAN_2 || piece === KING_2) return 2;
  return EMPTY;
}

export function isKing(piece: number): boolean {
  return piece === KING_1 || piece === KING_2;
}

export function kingOf(player: Player): number {
  return player === 1 ? KING_1 : KING_2;
}

/** 升变行（对方底线）：红方到第 0 行，白方到第 7 行 */
const CROWN_ROW: Readonly<Record<Player, number>> = { 1: 0, 2: 7 };

/** 四个斜向（行,列），固定顺序保证走法生成可复现 */
const ALL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** 普通兵只能斜前两个方向；王四方向 */
const MAN_DIRS: Readonly<Record<Player, ReadonlyArray<readonly [number, number]>>> = {
  1: [
    [-1, -1],
    [-1, 1],
  ],
  2: [
    [1, -1],
    [1, 1],
  ],
};

const dirsOf = (piece: number, player: Player): ReadonlyArray<readonly [number, number]> =>
  isKing(piece) ? ALL_DIRS : MAN_DIRS[player];

/** 和棋阈值：双方各剩一王后，连续无吃子半步数达到该值判和 */
export const DRAW_PLIES = 40;

/** 一次操作：from → to（to 为链尾落点）；captures 为沿途被吃子（按序），landings 为逐跳落点（按序，不含 from） */
export interface Move {
  from: number;
  to: number;
  captures: number[];
  landings: number[];
}

export interface CheckersState {
  /** 棋盘：0 空 / 1 红兵 / 2 白兵 / 3 红王 / 4 白王，下标 = r * SIZE + c */
  board: Int8Array;
  /** 快照栈（悔棋用）：history[i] 为第 i+1 手操作之前的完整状态 */
  history: CheckersState[];
  current: Player;
  status: Status;
  /** status === 'won' 时为胜方，和棋/进行中为 0 */
  winner: Player | 0;
  /** 终局原因；对局中为 '' */
  reason: EndReason;
  /** 双方各剩一王后累计的无吃子半步数（任一手有吃子或未进入双王残局即清零） */
  noProgress: number;
  /** 最后一手的 from/to，尚无操作时为 -1 */
  lastFrom: number;
  lastTo: number;
}

export function initialState(): CheckersState {
  const board = new Int8Array(CELLS);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!isDark(r, c)) continue;
      if (r <= 2) board[at(r, c)] = MAN_2; // 白方上三排
      else if (r >= 5) board[at(r, c)] = MAN_1; // 红方下三排
    }
  }
  return {
    board,
    history: [],
    current: 1,
    status: 'playing',
    winner: 0,
    reason: '',
    noProgress: 0,
    lastFrom: -1,
    lastTo: -1,
  };
}

export function pieceCount(board: Int8Array, player: Player): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    if (sideOf(board[i]) === player) n++;
  }
  return n;
}

/** 双方是否各恰剩一颗王（无普通子、无第二颗子）——和棋判定前提 */
export function isBareKings(board: Int8Array): boolean {
  let p1 = 0;
  let p2 = 0;
  let p1k = 0;
  let p2k = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = board[i];
    if (v === EMPTY) continue;
    if (sideOf(v) === 1) {
      p1++;
      if (isKing(v)) p1k++;
    } else {
      p2++;
      if (isKing(v)) p2k++;
    }
  }
  return p1 === 1 && p1k === 1 && p2 === 1 && p2k === 1;
}

/** from 处棋子的斜向一步目标（落点须为空格）。不含吃子跳。 */
function stepTargets(board: Int8Array, from: number, piece: number, player: Player): number[] {
  const out: number[] = [];
  const r = rowOf(from);
  const c = colOf(from);
  for (const [dr, dc] of dirsOf(piece, player)) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
    if (board[at(rr, cc)] === EMPTY) out.push(at(rr, cc));
  }
  return out;
}

/** from 处棋子是否至少存在一个立即跳吃（存在即必有完整吃链可走） */
function hasJump(board: Int8Array, from: number, piece: number, player: Player): boolean {
  const opponent = player === 1 ? 2 : 1;
  const r = rowOf(from);
  const c = colOf(from);
  for (const [dr, dc] of dirsOf(piece, player)) {
    const mr = r + dr;
    const mc = c + dc;
    const lr = r + 2 * dr;
    const lc = c + 2 * dc;
    if (mr < 0 || mr >= SIZE || mc < 0 || mc >= SIZE) continue;
    if (lr < 0 || lr >= SIZE || lc < 0 || lc >= SIZE) continue;
    if (sideOf(board[at(mr, mc)]) !== opponent) continue; // 只跳敌子（兵/王皆可被跳）
    if (board[at(lr, lc)] === EMPTY) return true;
  }
  return false;
}

/** 当前行棋方是否处于"有吃必吃"局面（己方任一子存在跳吃） */
export function mustCapture(state: CheckersState): boolean {
  if (state.status !== 'playing') return false;
  for (let i = 0; i < CELLS; i++) {
    const piece = state.board[i];
    if (piece === EMPTY || sideOf(piece) !== state.current) continue;
    if (hasJump(state.board, i, piece, state.current)) return true;
  }
  return false;
}

/**
 * from 处棋子的全部完整吃子链（深度优先枚举，方向序固定，结果可复现）：
 * - 链必须走到不能再跳（中途落点不作为合法终点）；
 * - 已被跳吃的敌子不能重复跳；不能落回走过的格子（含起点）；
 * - 普通兵跳入升变行立即成王并结束该手（英式规则：即使原本还能继续跳）。
 */
function captureChains(state: CheckersState, from: number): Move[] {
  const board = state.board;
  const piece = board[from];
  const player = state.current;
  const opponent = player === 1 ? 2 : 1;
  const out: Move[] = [];
  const visited = new Set<number>([from]); // 起点与逐跳落点：链中不可再次落子
  const captured: number[] = [];
  const landings: number[] = [];

  const dfs = (pos: number) => {
    let extended = false;
    const r = rowOf(pos);
    const c = colOf(pos);
    for (const [dr, dc] of dirsOf(piece, player)) {
      const mr = r + dr;
      const mc = c + dc;
      const lr = r + 2 * dr;
      const lc = c + 2 * dc;
      if (mr < 0 || mr >= SIZE || mc < 0 || mc >= SIZE) continue;
      if (lr < 0 || lr >= SIZE || lc < 0 || lc >= SIZE) continue;
      const mid = at(mr, mc);
      const land = at(lr, lc);
      if (sideOf(board[mid]) !== opponent) continue;
      if (captured.includes(mid)) continue;
      if (visited.has(land)) continue;
      // 落点须为空：被吃子格与落点格分属两类奇偶性互补的深色格，几何上不可能重合，
      // 因此按原盘判空不会误挡"已被吃掉棋子的格子"
      if (board[land] !== EMPTY) continue;
      extended = true;
      captured.push(mid);
      landings.push(land);
      visited.add(land);
      if (!isKing(piece) && rowOf(land) === CROWN_ROW[player]) {
        // 普通兵跳入底线：成王即收步
        out.push({ from, to: land, captures: [...captured], landings: [...landings] });
      } else {
        dfs(land);
      }
      visited.delete(land);
      landings.pop();
      captured.pop();
    }
    if (!extended && landings.length > 0) {
      // 无跳可续 → 该链完整；首层无任何跳时不产出"原地"伪链
      out.push({ from, to: pos, captures: [...captured], landings: [...landings] });
    }
  };

  dfs(from);
  return out;
}

/**
 * from 处棋子（须为当前行棋方）的全部合法操作：
 * - 己方任一子可吃时（有吃必吃）：只返回该子的完整吃子链（无链则空）；
 * - 否则返回斜向一步的空格落点（普通兵仅斜前，王四向）。
 */
export function movesFrom(state: CheckersState, from: number): Move[] {
  if (state.status !== 'playing') return [];
  if (from < 0 || from >= CELLS) return [];
  const piece = state.board[from];
  if (piece === EMPTY || sideOf(piece) !== state.current) return [];
  if (mustCapture(state)) return captureChains(state, from);
  return stepTargets(state.board, from, piece, state.current).map(
    (to): Move => ({ from, to, captures: [], landings: [to] }),
  );
}

/** 当前行棋方的全部合法操作（终局判定等内部逻辑与测试用） */
export function legalMoves(state: CheckersState): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (sideOf(state.board[i]) === state.current) out.push(...movesFrom(state, i));
  }
  return out;
}

/** player 方是否存在任何合法操作（吃链或普通步） */
function hasAnyMove(board: Int8Array, player: Player): boolean {
  for (let i = 0; i < CELLS; i++) {
    const piece = board[i];
    if (piece === EMPTY || sideOf(piece) !== player) continue;
    if (hasJump(board, i, piece, player)) return true;
    if (stepTargets(board, i, piece, player).length > 0) return true;
  }
  return false;
}

/**
 * 执行一次操作（from → to 须为 movesFrom 给出的合法终点）：
 * 同一终点存在多条链时（不同路径吃子不同），取吃子最多的一条，并列取生成序首条——
 * UI 一步直达链尾，无法区分同终点链，取多吃符合"有吃必吃"的直觉。
 * 成功返回新状态（原状态压入快照栈、成王、换手、判定终局）；
 * 非法（终局 / from 非己方棋子 / to 非合法链尾）原样返回同一状态。
 */
export function place(state: CheckersState, from: number, to: number): CheckersState {
  if (state.status !== 'playing') return state;
  const candidates = movesFrom(state, from).filter((m) => m.to === to);
  if (candidates.length === 0) return state;
  const move = candidates.reduce((a, b) => (b.captures.length > a.captures.length ? b : a));

  const player = state.current;
  const piece = state.board[from];
  const board = state.board.slice();
  board[from] = EMPTY;
  for (const cap of move.captures) board[cap] = EMPTY;
  board[to] = !isKing(piece) && rowOf(to) === CROWN_ROW[player] ? kingOf(player) : piece;

  const bare = isBareKings(board);
  const next: CheckersState = {
    board,
    history: [...state.history, state],
    current: player === 1 ? 2 : 1,
    status: 'playing',
    winner: 0,
    reason: '',
    // 和棋计数：有吃子即清零；未进入双王残局也清零；双王残局中的安静半步 +1
    noProgress: move.captures.length > 0 || !bare ? 0 : state.noProgress + 1,
    lastFrom: from,
    lastTo: to,
  };

  // 终局判定：对手无子 / 无合法步判负；双王残局无进展达阈值判和
  if (pieceCount(board, next.current) === 0) {
    return { ...next, status: 'won', winner: player, reason: 'cleared' };
  }
  if (!hasAnyMove(board, next.current)) {
    return { ...next, status: 'won', winner: player, reason: 'blocked' };
  }
  if (bare && next.noProgress >= DRAW_PLIES) {
    return { ...next, status: 'draw', winner: 0, reason: 'no-progress' };
  }
  return next;
}

/** 悔棋一步：弹出快照栈顶（上一手之前的状态）；空栈原样返回 */
export function undo(state: CheckersState): CheckersState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}
