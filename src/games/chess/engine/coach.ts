// 教练模式 v1 引擎层（docs/games/chess.md 第十节）：纯函数、零 DOM 依赖、完全确定。
//
// - gradeMove：给"走子前局面 + 一手着法"评级定因。复用 ai.ts 搜索（固定中等参数 + 小节点
//   预算，走前/走后各一次 ≈ 0.3–0.5s）：走前求"最优着法 + 分值"，走后求"实际价值"
//   （对手视角取反），Δ = 最优分 − 实际分；分级阈值与规则化原因复用 judge.ts
//   （GRADE_THRESHOLDS：Δ≤15 🌟 / ≤90 ✅ / ≤280 ⚠️ / >280 ❌；走出将杀 = 🌟、漏杀/送杀 = ❌）。
//   逐步评注（机制 1）与大错拦截预评估（机制 2）是同一计算，Worker 通道见
//   ui/chess.ai.worker.ts 的 coachEval 协议。
// - hintText：提示阶梯（机制 3）第一级的规则化泛泛文字（将杀机会 / 被捉 / 被将军 / 出子）。
// - hintHighlight：二/三级的高亮格与类型（高亮起点 / 起点+终点）。
// - interceptMessage：大错拦截卡文案（"这步会丢后（白后 d1×e4），建议重试"格式）。
import {
  B_PAWN,
  W_PAWN,
  algebraic,
  isAttacked,
  makeMove,
  type ChessState,
} from './chess';
import { chooseMove, MATE_SCORE, MATE_WIN, type AiMove, type AiPosition, type ChooseOptions } from './ai';
import { isCapture, judge, type Grade } from './judge';

/** 教练评估参数：中等深度 + 小节点预算（每步两次搜索约 0.3–0.5s，Worker 内跑） */
export const COACH_DEPTH = 3;
export const COACH_NODE_BUDGET = 150_000;
/** 大错拦截等待上限（毫秒，规格书第十节：超时放行不卡玩家） */
export const COACH_EVAL_TIMEOUT_MS = 1500;

/** 一次教练评估的完整结论（纯 JSON，可跨线程传输 / 直接渲染） */
export interface CoachVerdict {
  grade: Grade;
  /** 一句话原因（与复盘报告同一套规则化文案） */
  reason: string;
  /** 相对引擎首选的评估损失 Δ（行棋方视角，厘兵，≥0） */
  loss: number;
  /** 走前局面最优分（行棋方视角） */
  bestScore: number;
  /** 实际着法价值（行棋方视角） */
  playerValue: number;
  /** 走前局面引擎首选着法（提示阶梯/拦截卡展示用；终局局面为 null） */
  best: AiMove | null;
}

/** ChessState → AI 求解入参（结构兼容，共享同一 Int8Array 引用，搜索不改动） */
function toAiPos(s: ChessState): AiPosition {
  return { board: s.board, current: s.current, castling: s.castling, enPassant: s.enPassant, status: s.status };
}

/**
 * 教练分级纯函数：评估 before 局面下的一手着法 → 分级 + 原因 + 损失 + 引擎首选。
 * 确定性：同一局面 + 同一着法 + 同一参数 ⇒ 同一结论（搜索无随机）。
 * before 须处于 'playing' 且着法合法（UI 只会对行棋方的合法着法发起评估）；
 * 非法着法抛错（与复盘分析器 analyzeGame 同一裁决风格——makeMove 同引用拒绝）。
 */
export function gradeMove(
  before: ChessState,
  move: AiMove,
  opts: ChooseOptions = {},
): CoachVerdict {
  if (before.status !== 'playing') {
    // 防御：对局已结束（UI 不会走到），给中性结论
    return { grade: 'good', reason: '对局已结束', loss: 0, bestScore: 0, playerValue: 0, best: null };
  }
  const depth = opts.depth ?? COACH_DEPTH;
  const budget = opts.nodeBudget ?? COACH_NODE_BUDGET;

  // 走前：最优着法 + 最优分（行棋方视角）
  const pre = chooseMove(toAiPos(before), 'medium', { depth, nodeBudget: budget });

  // 落子（makeMove 为合法性最终裁决，同引用拒绝即非法）
  const after = makeMove(before, move.from, move.to, move.promotion);
  if (after === before) {
    throw new Error(`教练评估：${algebraic(move.from)}-${algebraic(move.to)} 不是合法着法`);
  }

  // 走后：实际价值（下一局面是对手行棋，其搜索分取反即本方视角；终局直接取 ±MATE/0）
  let playerValue: number;
  let reply: AiMove | null;
  if (after.status !== 'playing') {
    const whiteScore = after.status === 'won' ? (after.winner === 1 ? MATE_SCORE : -MATE_SCORE) : 0;
    playerValue = whiteScore * (before.current === 1 ? 1 : -1);
    reply = null;
  } else {
    const post = chooseMove(toAiPos(after), 'medium', { depth, nodeBudget: budget });
    playerValue = -post.score;
    reply = post.move;
  }

  const loss = Math.max(0, pre.score - playerValue);
  const { grade, reason } = judge({
    loss,
    bestScore: pre.score,
    playerValue,
    best: pre.move,
    reply,
    next: after,
    capture: isCapture(before, move.from, move.to),
    movedFrom: move.from,
    movedTo: move.to,
  });
  return { grade, reason, loss, bestScore: pre.score, playerValue, best: pre.move };
}

/** 提示阶梯状态（UI 侧）：level = 已披露级数；best/score 由 Worker 回填后生成文字与高亮 */
export interface HintState {
  level: 1 | 2 | 3;
  /** 请求时的手数：换手 / 走子后过期（阶梯随换手重置，过期回复按 ply 丢弃） */
  ply: number;
  best: AiMove | null;
  /** 走前局面最优分（行棋方视角，将杀步数换算用） */
  score: number;
  /** 一级泛泛文字（best 回填后生成） */
  text: string;
  /** 请求是否已在途/已回填（防止空回复时效果层重复请求） */
  asked: boolean;
}

/** score ≥ MATE_WIN 时的将杀步数；非将杀分返回 0 */
function mateStepsIn(score: number): number {
  return score >= MATE_WIN ? Math.max(1, Math.ceil((MATE_SCORE - score) / 2)) : 0;
}

/** 棋子分值（下标 = 引擎棋子编码），"被捉"提醒挑最贵的一枚 */
const VAL: Record<number, number> = {
  1: 100, 2: 320, 3: 330, 4: 500, 5: 900,
  8: 100, 9: 320, 10: 330, 11: 500, 12: 900,
};
const TYPE_CN = ['兵', '马', '象', '车', '后', '王'];

/**
 * 提示阶梯一级的规则化泛泛文字（规格书示例：注意你的X被捉 / 有一步将杀机会 / 向中心发展出子）。
 * 优先级：将杀机会 > 被将军 > 己方无保护子被捉 > 有吃子机会 > 开局出子 > 通用。
 * "被捉"为泛泛提醒：被对方攻击且无己方子保护（有保护不报，从宽不误导）。
 */
export function hintText(state: ChessState, best: AiMove | null, score: number): string {
  if (!best) return '当前没有可推荐的着法';
  const steps = mateStepsIn(score);
  if (steps === 1) return '有一步将杀机会';
  if (steps > 1) return `有 ${steps} 步将杀机会`;
  if (state.check) return '你正被将军，先化解威胁';
  const mover = state.current;
  const opp = mover === 1 ? 2 : 1;
  let worstType = -1;
  let worstVal = 0;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p === 0 || (p <= 6) !== (mover === 1)) continue; // 只看行棋方棋子
    const type = p <= 6 ? p - 1 : p - 8;
    if (type === 5) continue; // 王不适用"被捉"
    if (isAttacked(state.board, i >> 3, i & 7, opp) && !isAttacked(state.board, i >> 3, i & 7, mover)) {
      const v = VAL[p] ?? 0;
      if (v > worstVal) {
        worstVal = v;
        worstType = type;
      }
    }
  }
  if (worstType >= 0) return `注意你的${TYPE_CN[worstType]}被捉`;
  if (state.board[best.to] !== 0) return '有吃子机会，算清兑换得失';
  if (state.history.length < 16) return '向中心发展出子，注意王的安全';
  return '寻找更积极的着法，改善子力协同';
}

/**
 * 提示阶梯二/三级的高亮数据：二级高亮起点（吃子时目标格标"被吃"样式），三级高亮起点+终点。
 * 一级（泛泛文字）返回 null，不点亮任何格子。
 */
export function hintHighlight(
  state: ChessState,
  hint: Pick<HintState, 'level' | 'best'> | null,
): { from: number; to: number; level: 1 | 2 | 3; capture: boolean } | null {
  if (!hint || !hint.best || hint.level < 2) return null;
  const { from, to } = hint.best;
  const piece = state.board[from];
  const isPawn = piece === W_PAWN || piece === B_PAWN;
  const capture = state.board[to] !== 0 || (isPawn && to === state.enPassant && from % 8 !== to % 8);
  return { from, to, level: hint.level, capture };
}

/**
 * 大错拦截卡文案（规格书第十节格式："教练：这步会丢后（白后 d1×e4），建议重试"）。
 * reason 取冒号前的短头（丢后 / 错过绝杀 / 送杀 / 大错），moveDesc 为该手的中文描述。
 */
export function interceptMessage(reason: string, moveDesc: string): string {
  const head = reason.split('：')[0];
  const core = head === '大错' ? '这步局面会大幅恶化' : `这步会${head}`;
  return `${core}（${moveDesc}），建议重试`;
}
