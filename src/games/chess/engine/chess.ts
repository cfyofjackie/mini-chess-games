// 国际象棋引擎：8×8 棋盘（idx = r * 8 + c，r=0 为黑方底线即第 8 横线，白在下方先行）。
// 全部纯函数，零 DOM 依赖。规则要点：
// - 合法步 = 伪合法步 − 走完后己王受攻（含吃过路兵/王车易位的完整落子效果）；
// - 王车易位：权利未失 + 路径无子 + 王不在将军中 + 经过与到达格均不受攻；
// - 吃过路兵：仅对方兵刚两格后的下一手内可用（enPassant 目标格一手即失效）；
// - 兵升变：v1 到底线自动变后；无合法步时被将军=将死（负），否则=逼和（和）；
// - 判和：逼和 + 子力不足（K vs K、K+B/N vs K、K+B vs K+B 同色象）。
// 50 回合、三次重复、升变自选、PGN/FEN 属阶段二，不做。
export const SIZE = 8;
export const CELLS = SIZE * SIZE; // 64

export type Player = 1 | 2; // 1 白（先行，棋盘下方） 2 黑
export type Status = 'playing' | 'won' | 'draw';
export type EndReason = '' | 'checkmate' | 'stalemate' | 'insufficient'; // 将死 / 逼和 / 子力不足

/** 棋子编码：1–6 白方（兵马车象后王），8–13 黑方，0 为空 */
export const W_PAWN = 1;
export const W_KNIGHT = 2;
export const W_BISHOP = 3;
export const W_ROOK = 4;
export const W_QUEEN = 5;
export const W_KING = 6;
export const B_PAWN = 8;
export const B_KNIGHT = 9;
export const B_BISHOP = 10;
export const B_ROOK = 11;
export const B_QUEEN = 12;
export const B_KING = 13;

export const sideOf = (piece: number): Player => (piece <= 6 ? 1 : 2);
/** 棋子种类：0 兵 1 马 2 象 3 车 4 后 5 王（仅对非空棋子调用） */
const typeOf = (piece: number): number => (piece <= 6 ? piece - 1 : piece - 8);
const other = (p: Player): Player => (p === 1 ? 2 : 1);

export interface Move {
  from: number;
  to: number;
}

export interface ChessState {
  /** 棋盘：0 空，其余为棋子编码；下标 idx = r * SIZE + c */
  board: Int8Array;
  /** 快照栈（悔棋用）：history[i] 为第 i+1 手走子之前的完整状态 */
  history: ChessState[];
  current: Player;
  /** 王车易位权利：'KQkq' 的子集（K 白王侧 Q 白后侧 k 黑王侧 q 黑后侧），无权利为 '' */
  castling: string;
  /** 吃过路兵目标格 idx（对方兵刚两格时所越过的格），无则 -1 */
  enPassant: number;
  status: Status;
  /** status === 'won' 时为胜方，和棋为 0 */
  winner: Player | 0;
  /** 终局原因；对局中为 '' */
  reason: EndReason;
  /** 轮到走子的一方是否正被将军（状态条"将军！"提示与王格高亮） */
  check: boolean;
  /** 最后一手的 from/to，尚无走子时为 -1 */
  lastFrom: number;
  lastTo: number;
}

// ---------- 几何与坐标 ----------

const at = (r: number, c: number) => r * SIZE + c;
const rowOf = (i: number) => Math.floor(i / SIZE);
const colOf = (i: number) => i % SIZE;
const onBoard = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

/** 代数坐标 → idx（'a8' → 0；r=0 对应第 8 横线） */
export function fromAlgebraic(sq: string): number {
  const c = sq.charCodeAt(0) - 97; // a..h
  const rank = sq.charCodeAt(1) - 48; // 1..8
  return at(8 - rank, c);
}

/** idx → 代数坐标（0 → 'a8'） */
export function algebraic(i: number): string {
  return String.fromCharCode(97 + colOf(i)) + String(8 - rowOf(i));
}

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
const ALL8: ReadonlyArray<readonly [number, number]> = [...ORTHO, ...DIAG];
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

// ---------- 初始局面 ----------

export function initialState(): ChessState {
  const board = new Int8Array(CELLS);
  const backRank = [B_ROOK, B_KNIGHT, B_BISHOP, B_QUEEN, B_KING, B_BISHOP, B_KNIGHT, B_ROOK];
  for (let c = 0; c < SIZE; c++) {
    board[at(0, c)] = backRank[c];
    board[at(1, c)] = B_PAWN;
    board[at(6, c)] = W_PAWN;
    board[at(7, c)] = backRank[c] - 7; // 黑子编码 −7 即对应白子（车马象后王…）
  }
  return {
    board,
    history: [],
    current: 1,
    castling: 'KQkq',
    enPassant: -1,
    status: 'playing',
    winner: 0,
    reason: '',
    check: false,
    lastFrom: -1,
    lastTo: -1,
  };
}

// ---------- 局面构造器（测试辅助） ----------

export interface PositionOptions {
  /** 行棋方，默认白（1） */
  current?: Player;
  /** 易位权利子集，默认 'KQkq' */
  castling?: string;
  /** 吃过路兵目标格（代数坐标，如 'd6'），默认无 */
  enPassant?: string;
}

const PIECE_FROM_CHAR: Record<string, number> = {
  P: W_PAWN,
  N: W_KNIGHT,
  B: W_BISHOP,
  R: W_ROOK,
  Q: W_QUEEN,
  K: W_KING,
  p: B_PAWN,
  n: B_KNIGHT,
  b: B_BISHOP,
  r: B_ROOK,
  q: B_QUEEN,
  k: B_KING,
};

/**
 * 最小局面构造器：从 ['e1','K'] 形式的棋子列表搭建任意测试局面（不做合法性校验），
 * 供测试快捷摆放棋子 / 易位权利 / 行棋方 / 过路兵目标格。
 */
export function position(pieces: Array<[string, string]>, opts: PositionOptions = {}): ChessState {
  const board = new Int8Array(CELLS);
  for (const [sq, pc] of pieces) {
    const p = PIECE_FROM_CHAR[pc];
    if (!p) throw new Error(`未知棋子: ${pc}`);
    board[fromAlgebraic(sq)] = p;
  }
  const current = opts.current ?? 1;
  return {
    board,
    history: [],
    current,
    castling: opts.castling ?? 'KQkq',
    enPassant: opts.enPassant ? fromAlgebraic(opts.enPassant) : -1,
    status: 'playing',
    winner: 0,
    reason: '',
    check: isInCheck(board, current),
    lastFrom: -1,
    lastTo: -1,
  };
}

// ---------- 攻击检测 ----------

/** (tr, tc) 是否被 by 一方攻击（覆盖兵、马、王、车/后、象/后的全部攻击方式） */
function isAttacked(board: Int8Array, tr: number, tc: number, by: Player): boolean {
  const pawn = by === 1 ? W_PAWN : B_PAWN;
  const knight = by === 1 ? W_KNIGHT : B_KNIGHT;
  const bishop = by === 1 ? W_BISHOP : B_BISHOP;
  const rook = by === 1 ? W_ROOK : B_ROOK;
  const queen = by === 1 ? W_QUEEN : B_QUEEN;
  const king = by === 1 ? W_KING : B_KING;

  // 兵：白兵位于目标下方两斜格（向上攻击），黑兵位于上方
  const pr = tr + (by === 1 ? 1 : -1);
  for (const dc of [-1, 1] as const) {
    const nc = tc + dc;
    if (onBoard(pr, nc) && board[at(pr, nc)] === pawn) return true;
  }
  // 马
  for (const [dr, dc] of KNIGHT) {
    const nr = tr + dr;
    const nc = tc + dc;
    if (onBoard(nr, nc) && board[at(nr, nc)] === knight) return true;
  }
  // 王（邻格含对方王即受攻——王不可走入对方王攻击范围）
  for (const [dr, dc] of ALL8) {
    const nr = tr + dr;
    const nc = tc + dc;
    if (onBoard(nr, nc) && board[at(nr, nc)] === king) return true;
  }
  // 直线滑子：车 / 后
  for (const [dr, dc] of ORTHO) {
    let nr = tr + dr;
    let nc = tc + dc;
    while (onBoard(nr, nc)) {
      const t = board[at(nr, nc)];
      if (t !== 0) {
        if (t === rook || t === queen) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
  // 斜线滑子：象 / 后
  for (const [dr, dc] of DIAG) {
    let nr = tr + dr;
    let nc = tc + dc;
    while (onBoard(nr, nc)) {
      const t = board[at(nr, nc)];
      if (t !== 0) {
        if (t === bishop || t === queen) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
  return false;
}

/** player 是否正被将军（无王局面返回 false，便于构造极简测试局面） */
export function isInCheck(board: Int8Array, player: Player): boolean {
  const k = player === 1 ? W_KING : B_KING;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === k) return isAttacked(board, rowOf(i), colOf(i), other(player));
  }
  return false;
}

// ---------- 走法生成 ----------

/** 王车易位规格：王/车起讫格、须为空的格、王经过与到达（含起点）不受攻的格 */
interface CastleSpec {
  kingFrom: number;
  kingTo: number;
  rookFrom: number;
  rookTo: number;
  empty: number[];
  safe: number[];
}

const CASTLE: Record<string, CastleSpec> = {
  K: {
    kingFrom: at(7, 4),
    kingTo: at(7, 6),
    rookFrom: at(7, 7),
    rookTo: at(7, 5),
    empty: [at(7, 5), at(7, 6)],
    safe: [at(7, 4), at(7, 5), at(7, 6)],
  },
  Q: {
    kingFrom: at(7, 4),
    kingTo: at(7, 2),
    rookFrom: at(7, 0),
    rookTo: at(7, 3),
    empty: [at(7, 3), at(7, 2), at(7, 1)],
    safe: [at(7, 4), at(7, 3), at(7, 2)],
  },
  k: {
    kingFrom: at(0, 4),
    kingTo: at(0, 6),
    rookFrom: at(0, 7),
    rookTo: at(0, 5),
    empty: [at(0, 5), at(0, 6)],
    safe: [at(0, 4), at(0, 5), at(0, 6)],
  },
  q: {
    kingFrom: at(0, 4),
    kingTo: at(0, 2),
    rookFrom: at(0, 0),
    rookTo: at(0, 3),
    empty: [at(0, 3), at(0, 2), at(0, 1)],
    safe: [at(0, 4), at(0, 3), at(0, 2)],
  },
};

/**
 * from 处棋子的伪合法落点（不考虑走后己王受攻）。
 * enPassant：吃过路兵目标格；castling：易位权利（王在原位且有权利时生成易位落点）。
 */
export function pseudoTargets(
  board: Int8Array,
  from: number,
  enPassant = -1,
  castling = '',
): number[] {
  const piece = board[from];
  if (piece === 0) return [];
  const side = sideOf(piece);
  const type = typeOf(piece);
  const r = rowOf(from);
  const c = colOf(from);
  const out: number[] = [];
  const push = (nr: number, nc: number) => {
    if (!onBoard(nr, nc)) return;
    const t = board[at(nr, nc)];
    if (t === 0 || sideOf(t) !== side) out.push(at(nr, nc));
  };

  switch (type) {
    case 0: {
      // 兵：前进一格、起始位置可两格（均要求路径为空）、斜吃（无子不可斜走）、吃过路兵
      const fwd = side === 1 ? -1 : 1;
      if (onBoard(r + fwd, c) && board[at(r + fwd, c)] === 0) {
        out.push(at(r + fwd, c));
        const startRow = side === 1 ? 6 : 1;
        if (r === startRow && board[at(r + 2 * fwd, c)] === 0) out.push(at(r + 2 * fwd, c));
      }
      for (const dc of [-1, 1] as const) {
        const nr = r + fwd;
        const nc = c + dc;
        if (!onBoard(nr, nc)) continue;
        const t = board[at(nr, nc)];
        if (t !== 0 && sideOf(t) !== side) out.push(at(nr, nc));
        else if (t === 0 && at(nr, nc) === enPassant) out.push(at(nr, nc)); // 吃过路兵
      }
      break;
    }
    case 1: {
      // 马：日字，可越子
      for (const [dr, dc] of KNIGHT) push(r + dr, c + dc);
      break;
    }
    case 2: {
      // 象：斜线滑动，遇子而止
      for (const [dr, dc] of DIAG) {
        let nr = r + dr;
        let nc = c + dc;
        while (onBoard(nr, nc)) {
          const t = board[at(nr, nc)];
          if (t === 0) out.push(at(nr, nc));
          else {
            if (sideOf(t) !== side) out.push(at(nr, nc));
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      break;
    }
    case 3: {
      // 车：直线滑动
      for (const [dr, dc] of ORTHO) {
        let nr = r + dr;
        let nc = c + dc;
        while (onBoard(nr, nc)) {
          const t = board[at(nr, nc)];
          if (t === 0) out.push(at(nr, nc));
          else {
            if (sideOf(t) !== side) out.push(at(nr, nc));
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      break;
    }
    case 4: {
      // 后：车 + 象
      for (const [dr, dc] of ALL8) {
        let nr = r + dr;
        let nc = c + dc;
        while (onBoard(nr, nc)) {
          const t = board[at(nr, nc)];
          if (t === 0) out.push(at(nr, nc));
          else {
            if (sideOf(t) !== side) out.push(at(nr, nc));
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      break;
    }
    default: {
      // 王：一格八方
      for (const [dr, dc] of ALL8) push(r + dr, c + dc);
      // 王车易位：权利未失 + 王在原位 + 车在原位 + 路径无子 + 起点经过到达均不受攻
      for (const right of side === 1 ? ['K', 'Q'] : ['k', 'q']) {
        if (!castling.includes(right)) continue;
        const spec = CASTLE[right];
        if (spec.kingFrom !== from) continue;
        if (board[spec.rookFrom] !== (side === 1 ? W_ROOK : B_ROOK)) continue;
        if (spec.empty.some((i) => board[i] !== 0)) continue;
        if (spec.safe.some((i) => isAttacked(board, rowOf(i), colOf(i), other(side)))) continue;
        out.push(spec.kingTo);
      }
      break;
    }
  }
  return out;
}

/**
 * 在棋盘上应用 from→to（含吃过路兵的兵 removal、王车易位的车移动），
 * 不处理升变与权利/过路兵状态更新；供落子与"走后己王受攻"过滤共用。
 */
function applyMoveBoard(board: Int8Array, from: number, to: number, enPassant: number): Int8Array {
  const next = board.slice();
  const piece = next[from];
  next[to] = piece;
  next[from] = 0;
  // 吃过路兵：被吃兵不在 to，而在己方兵原行、目标列
  if ((piece === W_PAWN || piece === B_PAWN) && to === enPassant && board[to] === 0) {
    next[at(rowOf(from), colOf(to))] = 0;
  }
  // 王车易位：王横移两格，同步移动参与的车
  if ((piece === W_KING || piece === B_KING) && Math.abs(colOf(to) - colOf(from)) === 2) {
    const rr = rowOf(from);
    if (colOf(to) === 6) {
      next[at(rr, 5)] = next[at(rr, 7)];
      next[at(rr, 7)] = 0;
    } else {
      next[at(rr, 3)] = next[at(rr, 0)];
      next[at(rr, 0)] = 0;
    }
  }
  return next;
}

/** 走完 from→to 后 player 是否安全（不被将军） */
function isSafeAfter(
  board: Int8Array,
  from: number,
  to: number,
  enPassant: number,
  player: Player,
): boolean {
  return !isInCheck(applyMoveBoard(board, from, to, enPassant), player);
}

/** 当前状态下 from 处己方棋子的全部合法落点 */
export function legalTargets(state: ChessState, from: number): number[] {
  if (state.status !== 'playing') return [];
  const piece = state.board[from];
  if (piece === 0 || sideOf(piece) !== state.current) return [];
  return pseudoTargets(state.board, from, state.enPassant, state.castling).filter((to) =>
    isSafeAfter(state.board, from, to, state.enPassant, state.current),
  );
}

/** player 在该棋盘上的全部合法步（终局判定用） */
export function allLegalMoves(
  board: Int8Array,
  player: Player,
  enPassant = -1,
  castling = '',
): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < CELLS; from++) {
    const piece = board[from];
    if (piece === 0 || sideOf(piece) !== player) continue;
    for (const to of pseudoTargets(board, from, enPassant, castling)) {
      if (isSafeAfter(board, from, to, enPassant, player)) moves.push({ from, to });
    }
  }
  return moves;
}

// ---------- 判和 ----------

/**
 * 子力不足判和（规格书三组合）：
 * K vs K；K+单轻子（象或马） vs K；K+B vs K+B 且双方象同色格。
 */
export function isInsufficientMaterial(board: Int8Array): boolean {
  const minors: Array<{ side: Player; isBishop: boolean; sqColor: number }> = [];
  for (let i = 0; i < CELLS; i++) {
    const p = board[i];
    if (p === 0) continue;
    const t = typeOf(p);
    if (t === 0 || t === 3 || t === 4) return false; // 存在兵/车/后 → 不判
    if (t === 1 || t === 2) {
      minors.push({ side: sideOf(p), isBishop: t === 2, sqColor: (rowOf(i) + colOf(i)) % 2 });
    }
  }
  if (minors.length <= 1) return true; // K vs K、K+B/N vs K
  return (
    minors.length === 2 &&
    minors[0].isBishop &&
    minors[1].isBishop &&
    minors[0].side !== minors[1].side &&
    minors[0].sqColor === minors[1].sqColor
  );
}

// ---------- 走子 / 悔棋 ----------

/** 易位权利字符 → 对应车原位（用于车移动/被吃时收权） */
const ROOK_HOME: Record<string, number> = {
  K: at(7, 7), // h1
  Q: at(7, 0), // a1
  k: at(0, 7), // h8
  q: at(0, 0), // a8
};

/**
 * 走子 from→to（必须是 current 的合法步，否则原样返回同一状态）。
 * 升变自动变后；走完后轮到对方：无合法步时被将军=将死（负），否则=逼和（和）；
 * 尚有合法步而子力不足亦判和。
 */
export function makeMove(state: ChessState, from: number, to: number): ChessState {
  if (state.status !== 'playing') return state;
  if (from < 0 || from >= CELLS || to < 0 || to >= CELLS || from === to) return state;
  const piece = state.board[from];
  if (piece === 0 || sideOf(piece) !== state.current) return state;
  if (!legalTargets(state, from).includes(to)) return state;

  const board = applyMoveBoard(state.board, from, to, state.enPassant);

  // 升变：兵到达底线自动变后（v1 取舍，升变自选列入阶段二）
  if (piece === W_PAWN && rowOf(to) === 0) board[to] = W_QUEEN;
  else if (piece === B_PAWN && rowOf(to) === 7) board[to] = B_QUEEN;

  // 易位权利更新：王移动收双侧；车移动或车在原位被吃收单侧
  let castling = state.castling;
  const drop = (right: string) => {
    castling = castling.replace(right, '');
  };
  if (piece === W_KING) {
    drop('K');
    drop('Q');
  } else if (piece === B_KING) {
    drop('k');
    drop('q');
  }
  for (const right of Object.keys(ROOK_HOME)) {
    const home = ROOK_HOME[right];
    if (from === home || to === home) drop(right);
  }

  // 吃过路兵目标格：仅兵起始两格时设置，仅对下一手有效（否则清空）
  let enPassant = -1;
  if (piece === W_PAWN && rowOf(from) === 6 && rowOf(to) === 4) enPassant = at(5, colOf(from));
  else if (piece === B_PAWN && rowOf(from) === 1 && rowOf(to) === 3) enPassant = at(2, colOf(from));

  const opp = other(state.current);
  const next: ChessState = {
    board,
    history: [...state.history, state], // 走子前状态压栈，悔棋直接弹出
    current: opp,
    castling,
    enPassant,
    status: 'playing',
    winner: 0,
    reason: '',
    check: isInCheck(board, opp),
    lastFrom: from,
    lastTo: to,
  };

  // 无合法步：被将军 = 将死（负），未被将军 = 逼和（和）
  if (allLegalMoves(board, opp, enPassant, castling).length === 0) {
    return next.check
      ? { ...next, status: 'won', winner: state.current, reason: 'checkmate' }
      : { ...next, status: 'draw', winner: 0, reason: 'stalemate' };
  }
  if (isInsufficientMaterial(board)) {
    return { ...next, status: 'draw', winner: 0, reason: 'insufficient' };
  }
  return next;
}

/** 悔棋一步：弹出快照栈顶（上一手走子之前的状态）；空栈原样返回 */
export function undo(state: ChessState): ChessState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}
