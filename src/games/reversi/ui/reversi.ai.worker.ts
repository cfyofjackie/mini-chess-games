// 黑白棋 AI Web Worker：薄封装，只做消息协议与 chooseMove 调用（模式参考 peg-solitaire solver.worker.ts）。
// 搜索逻辑全部在 engine/ai.ts（纯函数、确定性），本文件不含任何策略。
import { chooseMove, type Difficulty } from '../engine/ai';
import type { Player } from '../engine/reversi';

/** 请求：局面只传必要字段（board 用普通数组跨线程传输，避免克隆整个快照栈） */
export interface AiRequest {
  type: 'choose';
  /** 主线程自增 id，用于丢弃过期回复（重开/悔棋/换难度后） */
  id: number;
  difficulty: Difficulty;
  board: number[];
  current: Player;
}

/** 回复：move = 合法步 idx（无合法步为 -1），nodes = 搜索节点数（诊断用） */
export interface AiReply {
  type: 'result';
  id: number;
  move: number;
  nodes: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const { id, difficulty, board, current } = e.data;
  const { move, nodes } = chooseMove({ board: Int8Array.from(board), current, status: 'playing' }, difficulty);
  ctx.postMessage({ type: 'result', id, move, nodes } satisfies AiReply);
};
