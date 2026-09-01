// 新手学堂进度本地保存（docs/games/chess.md 第十一节：进度本地保存，key 前缀 chess-lessons-，
// 记录已完成关卡）。localStorage 属浏览器 API，不放引擎目录；解析与去重抽成纯函数，
// node 环境可单测（读写包装在 Runner 里调用）。
const KEY = 'chess-lessons-completed';

/** 解析已存进度：非数组 / 元素非字符串 / JSON 损坏 → 过滤或回退空列表（纯函数） */
export function parseCompleted(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/** 读取已完成关卡 id（无 localStorage / 隐私模式 → 空列表） */
export function loadCompleted(): string[] {
  try {
    return parseCompleted(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

/** 保存已完成关卡 id；失败（隐私模式 / 配额）静默 */
export function saveCompleted(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // 静默
  }
}

/** 纯函数：把 id 标记为已完成（去重、保序），返回新列表 */
export function markCompleted(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}
