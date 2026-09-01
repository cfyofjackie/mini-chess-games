// 围棋引擎：9 路中国规则（数子法 + 简单劫）。全部纯函数，零 DOM 依赖。
// 盘径参数化：改 SIZE 常量即可扩至 13/19 路，引擎逻辑零改动（docs/games/go.md 第六节取舍）。
export const SIZE = 9;
export const CELLS = SIZE * SIZE; // 81

/** 中国规则贴目：黑方贴白 3¾ 子（9 路常用，docs/games/go.md 第一节） */
export const KOMI = 3.75;

export type Player = 1 | 2; // 1 黑（先行） 2 白
export type Status = 'playing' | 'marking' | 'done';
// playing 对局中 → marking 双虚着后的标记死子阶段 → done 已数子出结果

export interface GameResult {
  /** 黑得分 = 盘上活子数 + 围住的空点数 */
  black: number;
  /** 白得分 = 活子数 + 围空数 + 贴目 */
  white: number;
  /** 1 黑胜 / 2 白胜 / 0 和（3¾ 贴目下不会出现，保留通用性） */
  winner: Player | 0;
}

export interface GoState {
  /** 0 空 / 1 黑 / 2 白 */
  board: Int8Array;
  /**
   * 快照栈（悔棋用，平台惯例）：history[i] 是第 i+1 手之前的完整状态。
   * 落子 / 虚着 / 确认数子都压栈，从任意阶段悔棋一步即还原到上一手之前。
   */
  history: GoState[];
  current: Player;
  status: Status;
  /** 最后一手落点 idx；虚着或开局为 -1（UI 最后一手标记用） */
  lastMove: number;
  /** 简单劫：当前行棋方禁止立即回提的点，无则为 -1 */
  koPoint: number;
  /** 提子数：captures[0] 黑提子数、captures[1] 白提子数（UI chips 用，不参与数子） */
  captures: [number, number];
  /** 连续虚着次数：任一落子清零，达到 2 进入标记模式 */
  passes: number;
  /** 标记模式：被判死的棋子 idx 列表（整群同进退） */
  dead: number[];
  /** status === 'done' 时的数子结果 */
  result: GameResult | null;
}

const at = (r: number, c: number) => r * SIZE + c;

export const opponent = (p: Player): Player => (p === 1 ? 2 : 1);

const ORTH: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** NEIGH4[i]：idx 正交相邻的界内格（预计算表，引擎与 AI 共用） */
export const NEIGH4: readonly number[][] = (() => {
  const out: number[][] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const list: number[] = [];
      for (const [dr, dc] of ORTH) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) list.push(at(rr, cc));
      }
      out.push(list);
    }
  }
  return out;
})();

export interface Group {
  stones: number[];
  liberties: number[];
}

/** flood-fill：idx 处棋子所在的连通棋群与全部气（界外不算气）；空点返回空群 */
export function groupAt(board: Int8Array, idx: number): Group {
  const color = board[idx];
  if (color === 0) return { stones: [], liberties: [] };
  const stones: number[] = [];
  const inGroup = new Uint8Array(CELLS);
  const isLiberty = new Uint8Array(CELLS);
  const stack = [idx];
  inGroup[idx] = 1;
  while (stack.length > 0) {
    const m = stack.pop()!;
    stones.push(m);
    for (const n of NEIGH4[m]) {
      if (board[n] === 0) isLiberty[n] = 1;
      else if (board[n] === color && inGroup[n] === 0) {
        inGroup[n] = 1;
        stack.push(n);
      }
    }
  }
  const liberties: number[] = [];
  for (let i = 0; i < CELLS; i++) if (isLiberty[i] === 1) liberties.push(i);
  return { stones, liberties };
}

/** 盘上 color 色的全部棋群 */
export function groupsOf(board: Int8Array, color: Player): Group[] {
  const seen = new Uint8Array(CELLS);
  const out: Group[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === color && seen[i] === 0) {
      const g = groupAt(board, i);
      for (const s of g.stones) seen[s] = 1;
      out.push(g);
    }
  }
  return out;
}

export interface MoveEffect {
  board: Int8Array;
  /** 本手被提掉的对方棋子 idx */
  captured: number[];
}

/**
 * 试着一手（不查劫，劫依赖状态里的 koPoint，由 place/isLegal 把关）：
 * 空点落子 → 提取无气的邻接对方棋群 → 若己方棋群无气则为自杀，返回 null。
 * 纯计算，不修改入参。
 */
export function simulate(board: Int8Array, idx: number, player: Player): MoveEffect | null {
  if (idx < 0 || idx >= CELLS || board[idx] !== 0) return null;
  const nb = board.slice();
  nb[idx] = player;
  const opp = opponent(player);
  const captured: number[] = [];
  const handled = new Set<number>(); // 已检查过的对方棋群代表子（去重 flood-fill）
  for (const n of NEIGH4[idx]) {
    if (nb[n] === opp && !handled.has(n)) {
      const g = groupAt(nb, n);
      for (const s of g.stones) handled.add(s);
      if (g.liberties.length === 0) {
        for (const s of g.stones) {
          nb[s] = 0;
          captured.push(s);
        }
      }
    }
  }
  if (groupAt(nb, idx).liberties.length === 0) return null; // 自杀禁着
  return { board: nb, captured };
}

export function initialState(): GoState {
  return {
    board: new Int8Array(CELLS),
    history: [],
    current: 1,
    status: 'playing',
    lastMove: -1,
    koPoint: -1,
    captures: [0, 0],
    passes: 0,
    dead: [],
    result: null,
  };
}

/** 该点对当前行棋方是否合法：界内空点、非劫禁点、非自杀 */
export function isLegal(state: GoState, idx: number): boolean {
  if (state.status !== 'playing') return false;
  if (idx < 0 || idx >= CELLS || state.board[idx] !== 0 || idx === state.koPoint) return false;
  return simulate(state.board, idx, state.current) !== null;
}

/** 当前行棋方的全部合法落点（AI 与 UI 共用；idx 升序，保证确定性遍历） */
export function legalMoves(state: GoState): number[] {
  const out: number[] = [];
  if (state.status !== 'playing') return out;
  for (let i = 0; i < CELLS; i++) if (isLegal(state, i)) out.push(i);
  return out;
}

/**
 * 落子：非法（占子 / 劫禁 / 自杀 / 出界 / 非对局阶段）一律同引用拒绝（平台惯例）。
 * 成功则提取无气对方棋群、累计提子数，并按"简单劫"规则记录禁着点。
 */
export function place(state: GoState, idx: number): GoState {
  if (state.status !== 'playing') return state;
  if (idx < 0 || idx >= CELLS || state.board[idx] !== 0 || idx === state.koPoint) return state;
  const effect = simulate(state.board, idx, state.current);
  if (effect === null) return state;

  // 简单劫（docs/games/go.md 第二节）：本手恰提一子，且落下的子自成"单子单气"（经典劫形）
  // → 记录被提点，禁对方下一手立即回提；全局同形禁止列入后续版本
  const own = groupAt(effect.board, idx);
  const koPoint =
    effect.captured.length === 1 && own.stones.length === 1 && own.liberties.length === 1
      ? effect.captured[0]
      : -1;

  const captures: [number, number] = [state.captures[0], state.captures[1]];
  captures[state.current - 1] += effect.captured.length;

  return {
    board: effect.board,
    history: [...state.history, state],
    current: opponent(state.current),
    status: 'playing',
    lastMove: idx,
    koPoint,
    captures,
    passes: 0, // 落子打断连续虚着
    dead: [],
    result: null,
  };
}

/**
 * 虚着（pass）：轮转行棋方；双方连续虚着 → 进入标记模式（默认全活）。
 * 虚着同时解除劫禁——简单劫只约束"立即"回提，上一手已非提子。
 */
export function pass(state: GoState): GoState {
  if (state.status !== 'playing') return state;
  const passes = state.passes + 1;
  return {
    ...state,
    history: [...state.history, state],
    current: opponent(state.current),
    status: passes >= 2 ? 'marking' : 'playing',
    lastMove: -1,
    koPoint: -1,
    passes,
  };
}

/** 标记模式：点击某颗棋子，其整群在死 / 活之间切换；非标记阶段或空点同引用拒绝 */
export function toggleDead(state: GoState, idx: number): GoState {
  if (state.status !== 'marking' || idx < 0 || idx >= CELLS || state.board[idx] === 0) return state;
  const stones = groupAt(state.board, idx).stones;
  const set = new Set(state.dead);
  const isDead = set.has(stones[0]);
  for (const s of stones) {
    if (isDead) set.delete(s);
    else set.add(s);
  }
  return { ...state, dead: [...set].sort((a, b) => a - b) };
}

/** 标记模式：全部恢复活棋（死子标记清空）；无标记可清时同引用返回 */
export function clearDead(state: GoState): GoState {
  if (state.status !== 'marking' || state.dead.length === 0) return state;
  return { ...state, dead: [] };
}

/**
 * 确认数子（简化中国规则，docs/games/go.md 第二节第 5 条）：
 * 按标记移除死子 → 每方得分 = 活子数 + 围空数（连通空区域只邻一色才算围空，
 * 两色皆邻的点为公气不计），白加贴 3¾ 子，多者胜。确认也压快照，数错可悔棋退回标记模式。
 */
export function confirmScoring(state: GoState): GoState {
  if (state.status !== 'marking') return state;
  const board = state.board.slice();
  let aliveBlack = 0;
  let aliveWhite = 0;
  const deadSet = new Set(state.dead);
  for (let i = 0; i < CELLS; i++) {
    if (board[i] === 0) continue;
    if (deadSet.has(i)) board[i] = 0;
    else if (board[i] === 1) aliveBlack++;
    else aliveWhite++;
  }
  let terrBlack = 0;
  let terrWhite = 0;
  const visited = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== 0 || visited[i] === 1) continue;
    let size = 0;
    let sawBlack = false;
    let sawWhite = false;
    const stack = [i];
    visited[i] = 1;
    while (stack.length > 0) {
      const m = stack.pop()!;
      size++;
      for (const n of NEIGH4[m]) {
        if (board[n] === 1) sawBlack = true;
        else if (board[n] === 2) sawWhite = true;
        else if (visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (sawBlack && !sawWhite) terrBlack += size;
    else if (sawWhite && !sawBlack) terrWhite += size;
  }
  const black = aliveBlack + terrBlack;
  const white = aliveWhite + terrWhite + KOMI;
  const winner: Player | 0 = black > white ? 1 : white > black ? 2 : 0;
  return {
    ...state,
    history: [...state.history, state],
    status: 'done',
    result: { black, white, winner },
  };
}

/** 悔棋一步：弹出快照栈顶；空栈原样返回 */
export function undo(state: GoState): GoState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}

/** 星位：小盘取边线第 2 路、大盘第 3 路的四星 + 天元（奇数盘），按盘径参数化 */
export const STAR_POINTS: ReadonlyArray<readonly [number, number]> = (() => {
  const edge = SIZE >= 13 ? 3 : 2;
  const pts: Array<[number, number]> = [
    [edge, edge],
    [edge, SIZE - 1 - edge],
    [SIZE - 1 - edge, edge],
    [SIZE - 1 - edge, SIZE - 1 - edge],
  ];
  if (SIZE % 2 === 1) pts.push([(SIZE - 1) / 2, (SIZE - 1) / 2]);
  return pts;
})();
