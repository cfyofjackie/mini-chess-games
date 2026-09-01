// 围棋学堂目标判定（docs/games/chess.md 第十三节）：纯函数工厂、零 DOM 依赖。
// 全部建立在围棋引擎的 groupAt / groupsOf（棋群与气）之上，由运行器在每次 place 后调用，
// 也可在测试里用 place 逐手驱动单测。六种过关条件对应规格书关卡表：
// capture 提子 / atari 打吃 / doubleAtari 双叫吃（一手同时打吃两处）/
// escape 被打吃的己方棋群延气逃生 / counterCapture 对方来提时反提其棋群 /
// twoEyes 做出两只真眼（真眼 = 教学近似的启发判定，见 trueEyeAt）。
import {
  CELLS,
  NEIGH4,
  SIZE,
  groupAt,
  groupsOf,
  opponent,
  type GoState,
  type Player,
} from '../../engine/go';
import type { GoalContext, StageGoal } from './types';

/** 坐标标签 → idx：列 A–I（从左到右，9 路盘共 9 列）+ 行 1–9（从上到下），如 E5 = 第 5 列第 5 行（天元） */
export function pt(label: string): number {
  const col = label.toUpperCase().charCodeAt(0) - 65; // 'A' → 0
  const row = Number(label.slice(1)) - 1;
  if (col < 0 || col >= SIZE || !Number.isInteger(row) || row < 0 || row >= SIZE) {
    throw new Error(`非法坐标标签：${label}`);
  }
  return row * SIZE + col;
}

/** idx → 坐标标签（pt 的逆运算，文案与测试用） */
export function coordName(idx: number): string {
  const row = Math.floor(idx / SIZE);
  const col = idx % SIZE;
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/** 第 i 手（0 起）由哪一方落：从阶段初始行棋方逐手轮转推算 */
export function moverOf(ctx: GoalContext, i: number): Player {
  return (((ctx.start.current - 1 + i) % 2) + 1) as Player;
}

/** 第 i 手的提子数：盘上子数差 = 落 1 子 - 提 n 子 */
export function capturedCount(prev: GoState, next: GoState): number {
  const stones = (s: GoState) => {
    let n = 0;
    for (let i = 0; i < CELLS; i++) if (s.board[i] !== 0) n++;
    return n;
  };
  return stones(prev) - stones(next) + 1;
}

/** 上下文摘要：最近一手 + 行棋方 + 落子前局面（首手为阶段初始局面）+ 落子后局面 */
interface LastMove {
  mover: Player;
  move: number;
  prev: GoState;
  next: GoState;
}

/** 取最近一手及其前/后局面；尚无着法（或 moves/states 失配，防御）返回 null */
function lastOf(ctx: GoalContext): LastMove | null {
  if (ctx.moves.length === 0 || ctx.states.length !== ctx.moves.length) return null;
  const i = ctx.moves.length - 1;
  return {
    mover: moverOf(ctx, i),
    move: ctx.moves[i],
    prev: i > 0 ? ctx.states[i - 1] : ctx.start,
    next: ctx.states[i],
  };
}

/** color 色当前只剩 1 口气的棋群数（atari / doubleAtari 判定共用） */
function atariCount(state: GoState, color: Player): number {
  return groupsOf(state.board, color).filter((g) => g.liberties.length === 1).length;
}

/** 提子：最近一手提掉了对方的棋子（单子或整群） */
export function captureGoal(): StageGoal {
  return {
    kind: 'capture',
    describe: '提掉没有气的对方棋子——把它最后一口气也填上',
    check: (ctx) => {
      const last = lastOf(ctx);
      return !!last && capturedCount(last.prev, last.next) > 0;
    },
  };
}

/** 打吃：最近一手（未提子）把对方棋群从 ≥2 口气打到 1 口气（新增打吃才算，重复补刀无效） */
export function atariGoal(): StageGoal {
  return {
    kind: 'atari',
    describe: '把对方只剩 2 口气的棋群打吃到只剩 1 口气（打吃）',
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last || capturedCount(last.prev, last.next) !== 0) return false; // 打吃 ≠ 提子
      const enemy = opponent(last.mover);
      return atariCount(last.next, enemy) > atariCount(last.prev, enemy);
    },
  };
}

/** 双叫吃：最近一手（未提子）同时把两处对方棋群打成 1 口气（打吃棋群数一手 +2 以上） */
export function doubleAtariGoal(): StageGoal {
  return {
    kind: 'doubleAtari',
    describe: '落一子同时打吃两处对方棋群（两处同时只剩 1 口气）',
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last || capturedCount(last.prev, last.next) !== 0) return false;
      const enemy = opponent(last.mover);
      return atariCount(last.next, enemy) - atariCount(last.prev, enemy) >= 2;
    },
  };
}

/** 逃子（延气）：anchor 所在的己方棋群开局只剩 1 口气，被一手延气到 2 口以上（棋群仍在盘上） */
export function escapeGoal(anchor: string): StageGoal {
  const a = pt(anchor);
  return {
    kind: 'escape',
    describe: `给被打吃的己方棋群（${anchor} 一带）延长气——落到能长出气的点上逃生`,
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last) return false;
      if (groupAt(ctx.start.board, a).liberties.length !== 1) return false; // 设计校验：开局确被打吃
      if (last.mover !== ctx.start.board[a]) return false; // 须由己方亲手延气
      const now = groupAt(last.next.board, a);
      return now.stones.length > 0 && now.liberties.length >= 2;
    },
  };
}

/**
 * 反提：最近一手提掉了对方棋子，且此前一手由对方提过己方棋子（你来我往的反提）。
 * 双方均由学员操纵，用"相邻两手互换提子 + 行棋方不同"刻画"对方来提 → 反提回来"。
 */
export function counterCaptureGoal(): StageGoal {
  return {
    kind: 'counterCapture',
    describe: '先让白棋提掉你的棋子，再马上反提白棋的棋群',
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last || capturedCount(last.prev, last.next) === 0) return false;
      for (let i = 0; i < ctx.moves.length - 1; i++) {
        const prev = i > 0 ? ctx.states[i - 1] : ctx.start;
        if (capturedCount(prev, ctx.states[i]) > 0 && moverOf(ctx, i) !== last.mover) return true;
      }
      return false;
    },
  };
}

/**
 * 真眼近似判定（教学用启发）：空点四周全是己方棋子（边界自动少算边），
 * 且对角点上的对方子数少于一半（4 对角 ≤1、2~3 对角 =0）——排除最常见的假眼形状。
 */
export function trueEyeAt(board: Int8Array, idx: number, color: Player): boolean {
  if (board[idx] !== 0) return false;
  for (const n of NEIGH4[idx]) if (board[n] !== color) return false;
  const r = Math.floor(idx / SIZE);
  const c = idx % SIZE;
  let diags = 0;
  let enemyDiags = 0;
  for (const [dr, dc] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
    diags++;
    if (board[rr * SIZE + cc] === opponent(color)) enemyDiags++;
  }
  return enemyDiags <= Math.floor((diags - 1) / 2);
}

/** color 色盘上的真眼数 */
export function countTrueEyes(board: Int8Array, color: Player): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (trueEyeAt(board, i, color)) n++;
  return n;
}

/** 两眼做活：最近一手由 color 落下后，color 在盘上做出两只真眼（默认黑方教学） */
export function twoEyesGoal(color: Player = 1): StageGoal {
  return {
    kind: 'twoEyes',
    describe: '做出两只真眼——一块棋有了两只真眼就再也不会被提掉',
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last || last.mover !== color) return false;
      return countTrueEyes(last.next.board, color) >= 2;
    },
  };
}
