// 国际象棋 Web Worker：薄封装，只做消息协议与引擎调用（chooseMove / analyzeGame / gradeMove）
// （模式与 reversi / gomoku / peg-solitaire solver 一致）。
// 全部搜索与分析逻辑都在 engine/（纯函数、确定性），本文件不含任何策略。
// 复盘协议（docs/games/chess.md 第八节）：analyze 请求 + 逐局面进度回报（x/N），
// 避免一次性长阻塞；主线程按 id 丢弃过期进度/报告。
// 教练协议（docs/games/chess.md 第十节）：coachEval 评估指定着法（逐步评注与大错拦截
// 预评估共用同一计算），coachHint 求当前局面最佳着法（提示阶梯）；主线程按 id 丢弃过期回复。
import { chooseMove, type Difficulty } from '../engine/ai';
import { analyzeGame, seedState, type AnalysisReport } from '../engine/analysis';
import {
  COACH_DEPTH,
  COACH_NODE_BUDGET,
  gradeMove,
  type CoachVerdict,
} from '../engine/coach';
import type { Player, Promotion } from '../engine/chess';

/** AI 求解请求：局面只传必要字段（board 用普通数组跨线程传输，避免克隆整个快照栈） */
export interface ChooseRequest {
  type: 'choose';
  /** 主线程自增 id，用于丢弃过期回复（重开/悔棋/换难度后） */
  id: number;
  difficulty: Difficulty;
  board: number[];
  current: Player;
  castling: string;
  enPassant: number;
}

/** 复盘分析请求：初始局面 + 全部着法（升变步显式携带升变子） */
export interface AnalyzeRequest {
  type: 'analyze';
  id: number;
  initial: { board: number[]; current: Player; castling: string; enPassant: number };
  moves: Array<{ from: number; to: number; promotion?: Promotion }>;
  /** 可选覆盖分析参数（缺省 = engine/analysis.ts 的 ANALYSIS_DEPTH / ANALYSIS_NODE_BUDGET） */
  depth?: number;
  nodeBudget?: number;
}

/** 教练评估请求（机制 1 逐步评注 / 机制 2 大错拦截预评估共用）：走子前局面 + 待评估着法 */
export interface CoachEvalRequest {
  type: 'coachEval';
  id: number;
  board: number[];
  current: Player;
  castling: string;
  enPassant: number;
  from: number;
  to: number;
  /** 升变步显式携带升变子（与 makeMove 语义一致） */
  promotion?: Promotion;
  /** 可选覆盖评估参数（缺省 = engine/coach.ts 的 COACH_DEPTH / COACH_NODE_BUDGET） */
  depth?: number;
  nodeBudget?: number;
}

/** 教练提示请求（机制 3 提示阶梯）：求当前局面（行棋方视角）的最佳着法与分值 */
export interface CoachHintRequest {
  type: 'coachHint';
  id: number;
  board: number[];
  current: Player;
  castling: string;
  enPassant: number;
  depth?: number;
  nodeBudget?: number;
}

export type AiRequest = ChooseRequest | AnalyzeRequest | CoachEvalRequest | CoachHintRequest;

/** 回复联合：
 *  - result：AI 应手（from = -1 表示无合法步）；nodes = 搜索节点数（诊断用）
 *  - progress：复盘逐局面进度（done / total，total = 手数 + 1）
 *  - report：复盘完整报告（纯 JSON 数据，可直接结构化克隆与序列化）
 *  - coachVerdict：教练评估结论（分级 + 原因 + 损失 + 引擎首选）
 *  - coachHint：提示阶梯用的最佳着法与分值（行棋方视角） */
export type AiReply =
  | { type: 'result'; id: number; from: number; to: number; promotion?: Promotion; nodes: number }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'report'; id: number; report: AnalysisReport }
  | { type: 'coachVerdict'; id: number; verdict: CoachVerdict }
  | { type: 'coachHint'; id: number; best: { from: number; to: number; promotion?: Promotion } | null; score: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'choose') {
    const r = chooseMove(
      {
        board: Int8Array.from(msg.board),
        current: msg.current,
        castling: msg.castling,
        enPassant: msg.enPassant,
        status: 'playing',
      },
      msg.difficulty,
    );
    ctx.postMessage({
      type: 'result',
      id: msg.id,
      from: r.move ? r.move.from : -1,
      to: r.move ? r.move.to : -1,
      promotion: r.move?.promotion,
      nodes: r.nodes,
    } satisfies AiReply);
    return;
  }
  if (msg.type === 'coachEval') {
    // 教练评估：走子前局面 + 待评估着法 → 分级 + 原因 + 损失 + 引擎首选
    const before = seedState({
      board: msg.board,
      current: msg.current,
      castling: msg.castling,
      enPassant: msg.enPassant,
    });
    const verdict = gradeMove(
      before,
      { from: msg.from, to: msg.to, promotion: msg.promotion },
      { depth: msg.depth, nodeBudget: msg.nodeBudget },
    );
    ctx.postMessage({ type: 'coachVerdict', id: msg.id, verdict } satisfies AiReply);
    return;
  }
  if (msg.type === 'coachHint') {
    // 提示阶梯：当前局面最佳着法 + 分值（行棋方视角；固定中等参数 + 小节点预算）
    const seed = seedState({
      board: msg.board,
      current: msg.current,
      castling: msg.castling,
      enPassant: msg.enPassant,
    });
    const r = chooseMove(
      {
        board: seed.board,
        current: seed.current,
        castling: seed.castling,
        enPassant: seed.enPassant,
        status: 'playing',
      },
      'medium',
      { depth: msg.depth ?? COACH_DEPTH, nodeBudget: msg.nodeBudget ?? COACH_NODE_BUDGET },
    );
    ctx.postMessage({
      type: 'coachHint',
      id: msg.id,
      best: r.move,
      score: r.score,
    } satisfies AiReply);
    return;
  }
  // 复盘分析：重放 + 逐局面搜索，每完成一个局面回报一次进度（x/N）
  const seed = seedState(msg.initial);
  const report = analyzeGame(seed, msg.moves, {
    depth: msg.depth,
    nodeBudget: msg.nodeBudget,
    onProgress: (done, total) => {
      ctx.postMessage({ type: 'progress', id: msg.id, done, total } satisfies AiReply);
    },
  });
  ctx.postMessage({ type: 'report', id: msg.id, report } satisfies AiReply);
};
