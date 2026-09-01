// 新手学堂目标判定（docs/games/chess.md 第十一节）：纯函数工厂、零 DOM 依赖。
// 每种过关条件一个工厂，返回 { kind, describe, check }；check 以"阶段累计着法 + 各手走完局面"
//（GoalContext）为输入，由运行器在每次 makeMove 后调用，也可在测试里用 makeMove 直接驱动单测。
// 覆盖规格书六种目标：走到指定格 / 吃掉指定子 / 完成将死 / 完成易位 / 完成吃过路兵 /
// 指定着法序列，另加 promote（兵升变教学）。
import {
  B_KING,
  B_PAWN,
  SIZE,
  W_KING,
  W_PAWN,
  fromAlgebraic,
  type ChessState,
} from '../../engine/chess';
import type { GoalContext, StageGoal, StageMove } from './types';

/** 上下文摘要：最近一手 + 走子前局面（首手为阶段初始局面）+ 走子后局面 */
interface LastMove {
  move: StageMove;
  prev: ChessState;
  next: ChessState;
}

/** 取最近一手及其前/后局面；尚无着法（或 moves/states 失配，防御）返回 null */
function lastOf(ctx: GoalContext): LastMove | null {
  if (ctx.moves.length === 0 || ctx.states.length !== ctx.moves.length) return null;
  const i = ctx.moves.length - 1;
  return {
    move: ctx.moves[i],
    prev: i > 0 ? ctx.states[i - 1] : ctx.start,
    next: ctx.states[i],
  };
}

const colOf = (i: number) => i % SIZE;

/** 走到指定格：最近一手落在 target 格 */
export function reachGoal(target: string): StageGoal {
  const t = fromAlgebraic(target);
  return {
    kind: 'reach',
    describe: `把棋子走到 ${target}`,
    check: (ctx) => lastOf(ctx)?.move.to === t,
  };
}

/** 吃掉指定子：target 格上的棋子被最近一手吃掉（普通吃子） */
export function captureGoal(target: string): StageGoal {
  const t = fromAlgebraic(target);
  return {
    kind: 'capture',
    describe: `吃掉 ${target} 格上的目标棋子`,
    check: (ctx) => {
      const last = lastOf(ctx);
      return !!last && last.move.to === t && last.prev.board[t] !== 0;
    },
  };
}

/** 完成将死：最近一手把对方将死（引擎终局判定 status='won' && reason='checkmate'） */
export function checkmateGoal(): StageGoal {
  return {
    kind: 'checkmate',
    describe: '将死对方的王',
    check: (ctx) => {
      const last = lastOf(ctx);
      return !!last && last.next.status === 'won' && last.next.reason === 'checkmate';
    },
  };
}

export type CastleSide = 'short' | 'long' | 'any';

/** 完成易位：最近一手是王横移两格的王车易位（side 指定短 / 长 / 任意一侧） */
export function castleGoal(side: CastleSide): StageGoal {
  const describe =
    side === 'short'
      ? '完成一次短易位（点击王 e1 走到 g1，车会自动跟到 f1）'
      : side === 'long'
        ? '完成一次长易位（点击王 e1 走到 c1，车会自动跟到 d1）'
        : '完成一次王车易位';
  return {
    kind: 'castle',
    describe,
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last) return false;
      const piece = last.prev.board[last.move.from];
      if (piece !== W_KING && piece !== B_KING) return false;
      // 王一步横移两格只可能是易位（makeMove 已含完整易位效果与合法性校验）
      if (Math.abs(colOf(last.move.to) - colOf(last.move.from)) !== 2) return false;
      if (side === 'short') return colOf(last.move.to) === 6;
      if (side === 'long') return colOf(last.move.to) === 2;
      return true;
    },
  };
}

/** 完成吃过路兵：最近一手是兵斜进至过路兵目标格（落点本为空，被吃兵在旁格） */
export function enPassantGoal(): StageGoal {
  return {
    kind: 'enPassant',
    describe: '用兵斜进一格，吃掉对方的过路兵',
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last) return false;
      const piece = last.prev.board[last.move.from];
      const isPawn = piece === W_PAWN || piece === B_PAWN;
      return (
        isPawn &&
        last.prev.enPassant === last.move.to &&
        last.prev.board[last.move.to] === 0 &&
        colOf(last.move.from) !== colOf(last.move.to)
      );
    },
  };
}

/** 指定着法序列：累计着法从头逐手匹配（前缀匹配——中途走错可用悔棋回到匹配轨道） */
export function sequenceGoal(seq: Array<[string, string]>): StageGoal {
  const plan = seq.map(([f, t]) => ({ from: fromAlgebraic(f), to: fromAlgebraic(t) }));
  return {
    kind: 'sequence',
    describe: `依次完成着法：${seq.map(([f, t]) => `${f}→${t}`).join('，')}`,
    check: (ctx) =>
      ctx.moves.length >= plan.length &&
      plan.every((m, i) => ctx.moves[i].from === m.from && ctx.moves[i].to === m.to),
  };
}

/** 兵升变：最近一手把兵推进到 target 并完成升变（落点已是后/车/象/马） */
export function promoteGoal(target: string): StageGoal {
  const t = fromAlgebraic(target);
  return {
    kind: 'promote',
    describe: `把兵推进到 ${target}，并选择升变棋子（后/车/象/马）`,
    check: (ctx) => {
      const last = lastOf(ctx);
      if (!last || last.move.to !== t) return false;
      const landed = last.next.board[t];
      return landed !== 0 && landed !== W_PAWN && landed !== B_PAWN;
    },
  };
}
