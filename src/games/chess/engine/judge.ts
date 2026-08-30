// 评级与规则化原因文案的公共模块（docs/games/chess.md 第十节：教练评语与复盘报告
// "抽公共函数共用"）：纯函数、零 DOM 依赖。原实现位于 analysis.ts（复盘报告 v1），
// 教练模式 gradeMove 复用同一套阈值（GRADE_THRESHOLDS）与原因文案（judge），
// 故抽出到此共享；analysis.ts / coach.ts 均从本文件引入。
//
// 分级（行棋方视角损失 Δ，厘兵）：🟢/🌟 最佳（≈引擎首选或 Δ≈0）/ ⚪/✅ 好棋（小损）/
// 🟡/⚠️ 失误（中损，兵级）/ 🔴/❌ 大错（大子级丢子 / 漏杀 / 送杀）。
// 原因为规则化文案：将死得手 / 错过绝杀 / 送杀 / 丢X（被谁吃）/ 换子亏 / 逼和 / 平稳。
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
  sideOf,
  type ChessState,
} from './chess';
import { MATE_SCORE, MATE_WIN, type AiMove } from './ai';

export type Grade = 'best' | 'good' | 'mistake' | 'blunder';

/**
 * 评级阈值（行棋方视角损失，厘兵）：≤ best 🟢 / ≤ good ⚪ / ≤ mistake 🟡 / 超过 🔴。
 * 兵级损失（约 100）落 🟡，轻子及以上（≥ 320）落 🔴，可测试（规格第八节定值，教练模式共用）。
 */
export const GRADE_THRESHOLDS = { best: 15, good: 90, mistake: 280 } as const;

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

/** 损失 → 评级 */
export function gradeOf(loss: number): Grade {
  if (loss <= GRADE_THRESHOLDS.best) return 'best';
  if (loss <= GRADE_THRESHOLDS.good) return 'good';
  if (loss <= GRADE_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

/** 着法 m 在局面 st 上吃掉的棋子编码（普通吃子 / 吃过路兵；无吃子返回 0） */
export function capturedPieceOf(st: ChessState, m: AiMove): number {
  const victim = st.board[m.to];
  if (victim !== 0) return victim;
  const piece = st.board[m.from];
  if ((piece === W_PAWN || piece === B_PAWN) && m.to === st.enPassant && m.from % 8 !== m.to % 8) {
    return st.board[m.to + (piece === W_PAWN ? 8 : -8)]; // 被吃兵在走子兵原行、目标列
  }
  return 0;
}

/** from→to 在局面 st 上是否为吃子（普通吃子 / 吃过路兵） */
export function isCapture(st: ChessState, from: number, to: number): boolean {
  if (st.board[to] !== 0) return true;
  const piece = st.board[from];
  return (piece === W_PAWN || piece === B_PAWN) && to === st.enPassant && from % 8 !== to % 8;
}

export interface JudgeInput {
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
export function judge(input: JudgeInput): { grade: Grade; reason: string } {
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
