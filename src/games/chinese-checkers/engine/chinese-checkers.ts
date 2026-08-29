// 中国跳棋引擎：六角星 121 孔（中央六边形 + 六条臂），同屏双人对角各 10 子。
// 先行方（Player 1）占据下方出发臂、目标为上方对臂；Player 2 反之。
// 走法 = 相邻走一步，或跳过紧邻棋子（任意颜色）落到其后空孔且可连续跳（链中可变向）；
// 不吃子，一次操作 = 走一步或一条完整跳链。全部纯函数，零 DOM 依赖。

export const HOLES = 121;

export type Player = 1 | 2;
export type Status = 'playing' | 'won';

/** 孔的几何信息：axial 坐标 (x, z)（cube 第三轴 y = -x-z）与 UI 定位百分比 */
export interface Hole {
  x: number;
  z: number;
  /** 容器内水平位置（百分比 0–100） */
  px: number;
  /** 容器内垂直位置（百分比 0–100） */
  py: number;
}

// ---------- 棋盘几何 ----------

/**
 * 六角星成员判定（cube 坐标 x+y+z=0）：
 * 中央六边形 = max(|x|,|y|,|z|) ≤ 4（61 孔）；
 * 六条臂各为 4 行三角（10 孔），沿 6 个格线方向由六边形各边向外延伸，
 * 例如 +x 方向的臂 = { x ≥ 5, y ≥ -4, z ≥ -4 }，臂尖 (8,-4,-4)。
 */
function onStar(x: number, z: number): boolean {
  const y = -x - z;
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 4) return true;
  return (
    (x >= 5 && y >= -4 && z >= -4) || // 臂 +x
    (x <= -5 && y <= 4 && z <= 4) || // 臂 -x
    (y >= 5 && x >= -4 && z >= -4) || // 臂 +y
    (y <= -5 && x <= 4 && z <= 4) || // 臂 -y
    (z >= 5 && x >= -4 && y >= -4) || // 臂 +z（正下方）
    (z <= -5 && x <= 4 && y <= 4) // 臂 -z（正上方）
  );
}

/** 星形外接正方形边长：垂直 17 行 × 行距 √3/2 = 8√3 ≈ 13.86（水平跨度 12，取大者） */
const SPAN = 8 * Math.sqrt(3);
/** 星形在容器中的占空比（四周留出棋子半径的边距） */
const FIT = 0.94;

/**
 * 121 孔坐标表：按行（z = -8…8，自上而下）生成，行内按 x 升序编号，
 * 并换算为正方形容器内的百分比坐标（保持等边三角形点阵比例）。
 */
export const HOLES_GEO: readonly Hole[] = (() => {
  const holes: Hole[] = [];
  for (let z = -8; z <= 8; z++) {
    for (let x = -8; x <= 8; x++) {
      if (!onStar(x, z)) continue;
      const pxn = x + z / 2;
      const pyn = (z * Math.sqrt(3)) / 2;
      holes.push({
        x,
        z,
        px: 50 + ((pxn / SPAN) * FIT * 100),
        py: 50 + ((pyn / SPAN) * FIT * 100),
      });
    }
  }
  return holes;
})();

const KEY = (x: number, z: number) => (x + 8) * 17 + (z + 8);
const INDEX = new Map<number, number>(HOLES_GEO.map((h, i) => [KEY(h.x, h.z), i] as const));

/** axial 坐标 → 孔下标；星形外返回 -1 */
export function indexOf(x: number, z: number): number {
  return INDEX.get(KEY(x, z)) ?? -1;
}

/** 6 个正邻方向（axial：dx,dz），与 DIR_NEIGHBORS 第二维同序 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
];

/** 方向化邻接表：DIR_NEIGHBORS[i][d] = i 沿 DIRS[d] 方向的邻孔，星形外为 -1 */
export const DIR_NEIGHBORS: readonly number[][] = HOLES_GEO.map(({ x, z }) =>
  DIRS.map(([dx, dz]) => INDEX.get(KEY(x + dx, z + dz)) ?? -1),
);

/** 邻接表：每孔 2–6 个正邻 */
export const NEIGHBORS: readonly number[][] = DIR_NEIGHBORS.map((ds) => ds.filter((n) => n >= 0));

/** 先行方（1）出发臂：下方臂（z ≥ 5），恰 10 孔 */
export const P1_CAMP: readonly number[] = (() => {
  const out: number[] = [];
  HOLES_GEO.forEach((h, i) => {
    if (h.z >= 5) out.push(i);
  });
  return out;
})();

/** 后行方（2）出发臂：上方臂（z ≤ -5），恰 10 孔 */
export const P2_CAMP: readonly number[] = (() => {
  const out: number[] = [];
  HOLES_GEO.forEach((h, i) => {
    if (h.z <= -5) out.push(i);
  });
  return out;
})();

const TARGET_CAMPS: readonly [readonly number[], readonly number[]] = [P2_CAMP, P1_CAMP];

/** 玩家的目标营区 = 对方的出发臂（对臂） */
export function targetCamp(player: Player): readonly number[] {
  return TARGET_CAMPS[player - 1];
}

// ---------- 对局状态 ----------

export interface CCState {
  /** 棋盘：0 空 / 1 先行方 / 2 后行方，下标即孔下标 */
  board: Int8Array;
  /** 快照栈（悔棋用）：history[i] 为第 i+1 手操作之前的完整状态 */
  history: CCState[];
  current: Player;
  status: Status;
  /** status === 'won' 时为胜方 */
  winner: Player | 0;
  /** 最后一手的 from/to，尚无操作时为 -1 */
  lastFrom: number;
  lastTo: number;
}

export function initialState(): CCState {
  const board = new Int8Array(HOLES);
  for (const i of P1_CAMP) board[i] = 1;
  for (const i of P2_CAMP) board[i] = 2;
  return {
    board,
    history: [],
    current: 1,
    status: 'playing',
    winner: 0,
    lastFrom: -1,
    lastTo: -1,
  };
}

/**
 * from 处棋子一次操作可达的全部终点（相邻走一步 ∪ 跳链闭包），升序返回。
 * 仅对"轮到走子的一方"的棋子有效，其余情形返回空数组。
 * 跳链规则：跳过紧邻的一颗任意颜色棋子落到其正后方空孔，可连续跳、可变向；
 * 棋子起跳后原孔视为空——既不能落回原孔，也不能把原孔当作跳板。
 */
export function movesFrom(state: CCState, from: number): number[] {
  if (state.status !== 'playing') return [];
  if (from < 0 || from >= HOLES || state.board[from] !== state.current) return [];

  const board = state.board;
  const targets = new Set<number>();

  // 相邻走一步
  for (const n of NEIGHBORS[from]) {
    if (board[n] === 0) targets.add(n);
  }

  // 跳链闭包：从 from 出发广度优先扩展
  const seen = new Set<number>([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (let d = 0; d < 6; d++) {
      const over = DIR_NEIGHBORS[cur][d];
      if (over < 0 || over === from || board[over] === 0) continue; // 无子可跳（原孔已腾空）
      const land = DIR_NEIGHBORS[over][d];
      if (land < 0 || board[land] !== 0 || seen.has(land)) continue; // 不可穿越、不可落非空孔
      seen.add(land);
      targets.add(land);
      queue.push(land);
    }
  }

  return [...targets].sort((a, b) => a - b);
}

/** 胜负判定：某方 10 子全部进入对臂（对方出发臂）即胜；否则 0 */
export function winnerOf(board: Int8Array): Player | 0 {
  if (P2_CAMP.every((i) => board[i] === 1)) return 1;
  if (P1_CAMP.every((i) => board[i] === 2)) return 2;
  return 0;
}

/** 玩家已进入目标营区（对臂）的子数（进度展示用） */
export function campProgress(board: Int8Array, player: Player): number {
  let n = 0;
  for (const i of targetCamp(player)) {
    if (board[i] === player) n++;
  }
  return n;
}

/**
 * 执行一次操作（from → to 须为 movesFrom 给出的合法终点）：
 * 成功则返回新状态（原状态压入快照栈、换手、判定胜负）；
 * 非法（终局 / from 非己方棋子 / to 非可达终点含占用孔）原样返回同一状态。
 */
export function place(state: CCState, from: number, to: number): CCState {
  if (state.status !== 'playing') return state;
  if (!movesFrom(state, from).includes(to)) return state;

  const board = state.board.slice();
  board[from] = 0;
  board[to] = state.current;

  const next: CCState = {
    board,
    history: [...state.history, state],
    current: state.current,
    status: 'playing',
    winner: 0,
    lastFrom: from,
    lastTo: to,
  };
  const w = winnerOf(board);
  if (w !== 0) return { ...next, status: 'won', winner: w };
  return { ...next, current: state.current === 1 ? 2 : 1 };
}

/** 悔棋一步：弹出快照栈顶（上一手之前的状态）；空栈原样返回 */
export function undo(state: CCState): CCState {
  return state.history.length > 0 ? state.history[state.history.length - 1] : state;
}
