// 复盘分析器（docs/games/chess.md 第八节）：纯函数、零 DOM 依赖、完全确定。
//
// 原理：按着法序列重放对局（引擎 makeMove 为合法性最终裁决），逐局面用 ai.ts 的搜索
// （固定中等参数：α-β + 静态搜索、无启发排序；小节点预算保证 40 手局面总时长可控）
// 求该局面"行棋方视角"的最佳着法与评估分。每个局面只搜一次：
// - 玩家某手的价值 = 该手走完局面的搜索分取负（下一手是对手行棋，其视角取负即本方视角）；
// - 该手的损失 loss = 本方最佳分 − 玩家着法价值（≥0，越大越差）。
//
// 分级（阈值见 GRADE_THRESHOLDS）：🟢 最佳（≈引擎首选或 Δ≈0）/ ⚪ 好棋（小损）/
// 🟡 失误（中损，兵级）/ 🔴 大错（大子级丢子 / 漏杀 / 送杀）。
// 原因为规则化文案：将死得手 / 错过绝杀 / 送杀 / 丢X（被谁吃）/ 换子亏 / 逼和 / 平稳。
// 评估分统一换算白方视角输出曲线（长度 = 手数 + 1；将死 = ±MATE_SCORE，和棋 = 0）。
//
// 不做（规格明确）：URL 分享编码、逐手教练重试、置换表（分析复用 ai.ts 的搜索即无）。
import {
  B_BISHOP,
  B_KING,
  B_KNIGHT,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  W_BISHOP,
  W_KING,
  W_KNIGHT,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  algebraic,
  makeMove,
  sideOf,
  type ChessState,
  type Player,
  type Promotion,
  type Status,
} from './chess';
import { chooseMove, MATE_SCORE, MATE_WIN, type AiMove, type AiPosition } from './ai';

export type Grade = 'best' | 'good' | 'mistake' | 'blunder';

/**
 * 评级阈值（行棋方视角损失，厘兵）：≤ best 🟢 / ≤ good ⚪ / ≤ mistake 🟡 / 超过 🔴。
 * 兵级损失（约 100）落 🟡，轻子及以上（≥ 320）落 🔴，可测试（规格第八节）。
 */
export const GRADE_THRESHOLDS = { best: 15, good: 90, mistake: 280 } as const;

/** 分析默认参数：中等深度 3 + 小节点预算（40 手对局逐局面评估总计秒级；测试可再调小） */
export const ANALYSIS_DEPTH = 3;
export const ANALYSIS_NODE_BUDGET = 200_000;

/** 逐手分析条目：着法 + 引擎首选 + 评级/原因（字段平铺，供 moveText 与报告 UI 直接使用） */
export interface AnalyzedMove {
  /** 半回合序号（1 起） */
  ply: number;
  /** 行棋方 */
  side: Player;
  /** 玩家实际着法（升变步含升变子） */
  from: number;
  to: number;
  promotion?: Promotion;
  /** 走动的棋子编码（走子前） */
  piece: number;
  /** 是否吃子（含吃过路兵） */
  capture: boolean;
  /** 引擎首选着法（该局面行棋方视角；终局局面为 null） */
  best: AiMove | null;
  /** 相对首选的评估损失（行棋方视角，厘兵，≥0） */
  loss: number;
  grade: Grade;
  /** 一句话原因（规则化文案） */
  reason: string;
}

export interface GradeCount {
  best: number;
  good: number;
  mistake: number;
  blunder: number;
}

export interface AnalysisReport {
  /** 逐手分析（长度 = 手数） */
  moves: AnalyzedMove[];
  /** 白方视角评估曲线（长度 = 手数 + 1；厘兵；将死 = ±MATE_SCORE，和棋 = 0） */
  curve: number[];
  /** 分析终点对局状态（对局中进入复盘 = 'playing'） */
  status: Status;
  /** status === 'won' 时为胜方，否则 0 */
  winner: Player | 0;
  /** 双方评级计数 */
  white: GradeCount;
  black: GradeCount;
}

export interface AnalyzeOptions {
  /** 主搜索深度（默认 ANALYSIS_DEPTH） */
  depth?: number;
  /** 单局面节点预算（默认 ANALYSIS_NODE_BUDGET） */
  nodeBudget?: number;
  /** 逐局面进度回报（done/total；total = 手数 + 1） */
  onProgress?: (done: number, total: number) => void;
}

/** 着法输入 = 引擎 AiMove（升变步必须显式携带升变子，与 makeMove 语义一致） */
export type AnalysisMoveInput = AiMove;

/** 局面种子：跨线程传输 / 存储恢复时的最小字段（board 允许普通数组） */
export interface AnalysisSeed {
  board: Int8Array | number[];
  current: Player;
  castling: string;
  enPassant: number;
}

// ---------------------------------------------------------------- 辅助（纯函数）

const PIECE_CN: Record<number, string> = {
  [W_KING]: '王',
  [W_QUEEN]: '后',
  [W_ROOK]: '车',
  [W_BISHOP]: '象',
  [W_KNIGHT]: '马',
  [W_PAWN]: '兵',
  [B_KING]: '王',
  [B_QUEEN]: '后',
  [B_ROOK]: '车',
  [B_BISHOP]: '象',
  [B_KNIGHT]: '马',
  [B_PAWN]: '兵',
};

/** 升变后的棋子编码 → 升变字母（extractMoves 反查用） */
const PROMO_LETTER: Record<number, Promotion> = {
  [W_QUEEN]: 'q',
  [W_ROOK]: 'r',
  [W_BISHOP]: 'b',
  [W_KNIGHT]: 'n',
  [B_QUEEN]: 'q',
  [B_ROOK]: 'r',
  [B_BISHOP]: 'b',
  [B_KNIGHT]: 'n',
};

/** 损失 → 评级 */
function gradeOf(loss: number): Grade {
  if (loss <= GRADE_THRESHOLDS.best) return 'best';
  if (loss <= GRADE_THRESHOLDS.good) return 'good';
  if (loss <= GRADE_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

/** ChessState → AI 求解入参（结构兼容，共享同一 Int8Array 引用，搜索不改动） */
function toAiPos(s: ChessState): AiPosition {
  return { board: s.board, current: s.current, castling: s.castling, enPassant: s.enPassant, status: s.status };
}

/** 着法 m 在局面 st 上吃掉的棋子编码（普通吃子 / 吃过路兵；无吃子返回 0） */
function capturedPieceOf(st: ChessState, m: AiMove): number {
  const victim = st.board[m.to];
  if (victim !== 0) return victim;
  const piece = st.board[m.from];
  if ((piece === W_PAWN || piece === B_PAWN) && m.to === st.enPassant && m.from % 8 !== m.to % 8) {
    return st.board[m.to + (piece === W_PAWN ? 8 : -8)]; // 被吃兵在走子兵原行、目标列
  }
  return 0;
}

interface JudgeInput {
  /** 相对首选的损失（行棋方视角，厘兵） */
  loss: number;
  /** 本方最佳分（行棋方视角） */
  bestScore: number;
  /** 玩家着法价值（行棋方视角） */
  playerValue: number;
  /** 引擎首选（可能为 null：终局局面） */
  best: AiMove | null;
  /** 对手最佳回应（下一局面的搜索结果；下一局面终局时为 null） */
  reply: AiMove | null;
  /** 该手走完的局面（终局特判 / 回应吃子判定用） */
  next: ChessState;
  capture: boolean;
  movedFrom: number;
  movedTo: number;
}

/** 规则化原因 + 评级：将死类特判优先，其次丢子（对手最佳回应直接吃子），再按损失分档 */
function judge(input: JudgeInput): { grade: Grade; reason: string } {
  const { loss, bestScore, playerValue, best, reply, next, capture, movedFrom, movedTo } = input;
  // 走完即达成将杀（或进入必胜将杀路径）
  if (playerValue >= MATE_WIN) return { grade: 'best', reason: '将死得手，胜局已定' };
  // 漏杀：本有强制将杀却未走（规格：漏杀属大错）
  if (bestScore >= MATE_WIN) {
    const k = Math.max(1, Math.ceil((MATE_SCORE - bestScore) / 2));
    return { grade: 'blunder', reason: `错过绝杀：有 ${k} 步将杀未走` };
  }
  // 送杀：走完送对方强制将杀
  if (playerValue <= -MATE_WIN) {
    const k = Math.max(1, Math.ceil((MATE_SCORE + playerValue) / 2));
    return { grade: 'blunder', reason: `送杀：${k} 步内被将死` };
  }
  const grade = gradeOf(loss);
  // 终局特判：逼和 / 子力不足和棋
  if (next.status === 'draw') {
    if (next.reason === 'stalemate') {
      return {
        grade,
        reason: loss > GRADE_THRESHOLDS.good ? '逼和：对方无子可动，胜势化为和棋' : '逼和：成功守和',
      };
    }
    return { grade, reason: '和棋：双方子力不足' };
  }
  // 丢子：对手最佳回应直接吃子且损失明显（兵级 🟡 / 轻子大子级 🔴 由阈值定级）
  if (reply && loss > GRADE_THRESHOLDS.good) {
    const lost = capturedPieceOf(next, reply);
    if (lost !== 0) {
      const attacker = next.board[reply.from];
      const who =
        attacker !== 0
          ? `${sideOf(attacker) === 1 ? '白' : '黑'}${PIECE_CN[attacker] ?? '子'}`
          : sideOf(lost) === 1 ? '白方' : '黑方';
      return { grade, reason: `丢${PIECE_CN[lost] ?? '子'}：被${who}吃` };
    }
  }
  // 换子亏 / 一般损失
  if (capture && loss > GRADE_THRESHOLDS.good) {
    return { grade, reason: `换子亏：损失约 ${(loss / 100).toFixed(1)} 兵` };
  }
  if (loss > GRADE_THRESHOLDS.mistake) return { grade, reason: '大错：局面大幅恶化' };
  if (loss > GRADE_THRESHOLDS.good) return { grade, reason: '失误：局面明显变差' };
  if (grade === 'best') {
    return {
      grade,
      reason: best && best.from === movedFrom && best.to === movedTo ? '与引擎首选一致' : '与首选几乎等价，平稳',
    };
  }
  return { grade, reason: '平稳：小幅损失' };
}

// ---------------------------------------------------------------- 对外 API

/** 从最小字段搭建可重放的初始局面（Worker / 本地存储恢复用；不校验局面合法性） */
export function seedState(seed: AnalysisSeed): ChessState {
  return {
    board: seed.board instanceof Int8Array ? seed.board.slice() : Int8Array.from(seed.board),
    history: [],
    current: seed.current,
    castling: seed.castling,
    enPassant: seed.enPassant,
    status: 'playing',
    winner: 0,
    reason: '',
    check: false,
    lastFrom: -1,
    lastTo: -1,
  };
}

/**
 * 从"走子后的状态"提取全部着法（Game 页复盘入口用，避免另存着法列表）：
 * history[i] 为第 i 手走子前的快照，第 k 手（0 起）的起讫 = 下一快照的 lastFrom/lastTo；
 * 升变子反查自走子后落点棋子。
 */
export function extractMoves(final: ChessState): AnalysisMoveInput[] {
  const n = final.history.length;
  const out: AnalysisMoveInput[] = [];
  for (let k = 0; k < n; k++) {
    const before = final.history[k];
    const after = k + 1 < n ? final.history[k + 1] : final;
    const from = after.lastFrom;
    const to = after.lastTo;
    if (from < 0 || to < 0) break; // 快照链损坏（防御）
    const move: AnalysisMoveInput = { from, to };
    const piece = before.board[from];
    const promoRow = piece === W_PAWN ? 0 : piece === B_PAWN ? 7 : -1;
    if (promoRow >= 0 && Math.floor(to / 8) === promoRow) {
      move.promotion = PROMO_LETTER[after.board[to]];
    }
    out.push(move);
  }
  return out;
}

/**
 * 复盘分析主入口：analyzeGame(initialState, moves, options) → Report。
 * 按着法重放（makeMove 为合法性最终裁决，非法即抛错——复盘输入只应来自真实对局），
 * 逐局面搜索一次（进度回报 total = 手数 + 1），输出每手评级/原因与白方视角评估曲线。
 */
export function analyzeGame(
  initial: ChessState,
  moves: readonly AnalysisMoveInput[],
  options: AnalyzeOptions = {},
): AnalysisReport {
  const depth = options.depth ?? ANALYSIS_DEPTH;
  const budget = options.nodeBudget ?? ANALYSIS_NODE_BUDGET;
  const onProgress = options.onProgress;

  // ---- 重放：states[i] 为第 i 手走完的局面（states[0] = 初始局面） ----
  const states: ChessState[] = [initial];
  for (let i = 0; i < moves.length; i++) {
    const prev = states[states.length - 1];
    const m = moves[i];
    const next = makeMove(prev, m.from, m.to, m.promotion);
    if (next === prev) {
      throw new Error(
        `复盘分析：第 ${i + 1} 手不是合法着法（${algebraic(m.from)}-${algebraic(m.to)}）`,
      );
    }
    states.push(next);
  }
  const n = moves.length;

  // ---- 逐局面搜索（每个局面恰好一次；终局局面直接给将死/和棋分） ----
  // scores[i]：行棋方视角（终局局面为白方视角 ±MATE_SCORE / 0）
  const scores: number[] = new Array(n + 1).fill(0);
  const bestMoves: Array<AiMove | null> = new Array(n + 1).fill(null);
  for (let i = 0; i <= n; i++) {
    const st = states[i];
    if (st.status !== 'playing') {
      scores[i] = st.status === 'won' ? (st.winner === 1 ? MATE_SCORE : -MATE_SCORE) : 0;
    } else {
      const r = chooseMove(toAiPos(st), 'medium', { depth, nodeBudget: budget });
      scores[i] = r.score;
      bestMoves[i] = r.move;
    }
    onProgress?.(i + 1, n + 1);
  }

  // ---- 评估曲线（白方视角）：行棋方视角分 × 行棋方符号 ----
  const curve: number[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const st = states[i];
    curve[i] = st.status !== 'playing' ? scores[i] : scores[i] * (st.current === 1 ? 1 : -1);
  }

  // ---- 逐手评级与原因 ----
  const emptyCount = (): GradeCount => ({ best: 0, good: 0, mistake: 0, blunder: 0 });
  const white = emptyCount();
  const black = emptyCount();
  const analyzed: AnalyzedMove[] = [];
  for (let i = 0; i < n; i++) {
    const before = states[i];
    const next = states[i + 1];
    const m = moves[i];
    const mover = before.current;
    const sign = mover === 1 ? 1 : -1;
    // 玩家着法价值（行棋方视角）：下一局面终局 → 白方视角分 × 行棋方符号；
    // 否则下一局面搜索分是对手视角，取负。
    const playerValue = next.status !== 'playing' ? scores[i + 1] * sign : -scores[i + 1];
    const loss = Math.max(0, scores[i] - playerValue);
    const piece = before.board[m.from];
    const isPawn = piece === W_PAWN || piece === B_PAWN;
    const capture =
      before.board[m.to] !== 0 ||
      (isPawn && m.to === before.enPassant && m.from % 8 !== m.to % 8);
    const { grade, reason } = judge({
      loss,
      bestScore: scores[i],
      playerValue,
      best: bestMoves[i],
      reply: bestMoves[i + 1],
      next,
      capture,
      movedFrom: m.from,
      movedTo: m.to,
    });
    const am: AnalyzedMove = {
      ply: i + 1,
      side: mover,
      from: m.from,
      to: m.to,
      promotion: m.promotion,
      piece,
      capture,
      best: bestMoves[i],
      loss,
      grade,
      reason,
    };
    analyzed.push(am);
    (mover === 1 ? white : black)[grade]++;
  }

  const finalState = states[n];
  return {
    moves: analyzed,
    curve,
    status: finalState.status,
    winner: finalState.winner,
    white,
    black,
  };
}
