// 复盘报告本地保存（docs/games/chess.md 第八节第 4 条）：localStorage 持久化，
// key 前缀 chess-review-，保留最近 10 局；提供列表读取与局面序列重建（重看用）。
// localStorage 是浏览器 API，不放 engine/（分析器保持纯函数、node 环境可测）。
// 存储内容 = 报告（纯 JSON 数据）+ 初始局面 + 着法列表；重看时重放着法重建局面序列。
import { makeMove, type ChessState, type Player } from '../engine/chess';
import { seedState, type AnalysisMoveInput, type AnalysisReport } from '../engine/analysis';

const PREFIX = 'chess-review-';
const MAX_KEEP = 10;

export interface SavedReview {
  id: string;
  savedAt: number;
  moveCount: number;
  /** 列表展示文案：时间 · 手数 · 结果 */
  label: string;
  report: AnalysisReport;
  initial: { board: number[]; current: Player; castling: string; enPassant: number };
  moves: AnalysisMoveInput[];
}

function resultText(report: AnalysisReport): string {
  if (report.status === 'won') return report.winner === 1 ? '白胜' : '黑胜';
  return report.status === 'draw' ? '和棋' : '进行中';
}

/** 保存一份复盘报告；超出 MAX_KEEP 时从旧到新淘汰。失败（隐私模式/配额）静默返回 null */
export function saveReview(
  input: Omit<SavedReview, 'id' | 'savedAt' | 'label' | 'moveCount'>,
): SavedReview | null {
  const savedAt = Date.now();
  const rec: SavedReview = {
    ...input,
    id: `${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt,
    moveCount: input.moves.length,
    label: `${new Date(savedAt).toLocaleString()} · ${input.moves.length} 手 · ${resultText(input.report)}`,
  };
  try {
    localStorage.setItem(PREFIX + rec.id, JSON.stringify(rec));
    for (const old of listReviews().slice(MAX_KEEP)) {
      localStorage.removeItem(PREFIX + old.id); // 保留最近 10 局
    }
    return rec;
  } catch {
    return null;
  }
}

/** 全部已保存复盘（新 → 旧） */
export function listReviews(): SavedReview[] {
  const out: SavedReview[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (raw) out.push(JSON.parse(raw) as SavedReview);
      } catch {
        // 单条损坏忽略，不影响其余
      }
    }
  } catch {
    // 隐私模式等：视作空列表
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** 重建局面序列（长度 = 手数 + 1）：states[i] 为第 i 手走完的局面，states[0] = 初始局面 */
export function buildPositions(rec: SavedReview): ChessState[] {
  const states: ChessState[] = [seedState(rec.initial)];
  for (const m of rec.moves) {
    const prev = states[states.length - 1];
    const next = makeMove(prev, m.from, m.to, m.promotion);
    if (next === prev) break; // 防御：存储数据损坏时停在最近合法局面
    states.push(next);
  }
  return states;
}
