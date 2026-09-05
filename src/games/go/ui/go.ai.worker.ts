// 围棋 Web Worker：薄封装，只做消息协议与引擎调用（三档难度统一入口 chooseAiMove）。
// 模式与 chess / gomoku / reversi 的 AI worker 一致；全部搜索逻辑都在 engine/
// （ai.ts 启发式 + mcts.ts 蒙特卡洛树搜索，纯函数、确定性），本文件不含任何策略。
// 过期回复（重开 / 悔棋 / 换难度）由主线程按请求 id 丢弃。
import type { GoState, Player } from '../engine/go';
import { chooseAiMove, type Difficulty } from '../engine/mcts';

/** AI 求解请求：局面只传必要字段（board 用普通数组跨线程传输，避免克隆整个快照栈） */
export interface GoAiRequest {
  type: 'choose';
  /** 主线程自增 id，用于丢弃过期回复（重开 / 悔棋 / 换难度后） */
  id: number;
  difficulty: Difficulty;
  board: number[];
  current: Player;
  /** 简单劫禁着点（无则 -1） */
  koPoint: number;
  /** 连续虚着数（影响启发式的虚着时机判断） */
  passes: number;
  /** 已行手数（启发式的脱线松棋罚分按手数衰减） */
  ply: number;
}

/** 回复：move = 落点 idx（-1 表示虚着） */
export type GoAiReply = { type: 'result'; id: number; move: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<GoAiRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  // 还原引擎状态：history 只用于手数（启发式 ply 罚分），占位数组即可
  const state: GoState = {
    board: Int8Array.from(msg.board),
    history: Array.from({ length: msg.ply }),
    current: msg.current,
    status: 'playing',
    lastMove: -1,
    koPoint: msg.koPoint,
    captures: [0, 0],
    passes: msg.passes,
    dead: [],
    result: null,
  };
  const { move } = chooseAiMove(state, msg.difficulty);
  ctx.postMessage({ type: 'result', id: msg.id, move } satisfies GoAiReply);
};
