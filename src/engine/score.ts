// 终局评分等级表（数据驱动，可按需调整）
import { Bits, CENTER, hasPeg, pegCount } from './board';

export interface Grade {
  label: string;
  perfect: boolean;
}

const GRADE_TABLE: ReadonlyArray<readonly [pegsLeft: number, label: string]> = [
  [2, '高手'],
  [3, '优秀'],
  [4, '良好'],
  [5, '还不错'],
];

export function grade(pegs: Bits): Grade {
  const n = pegCount(pegs);
  if (n === 1 && hasPeg(pegs, CENTER)) return { label: '天才', perfect: true };
  if (n === 1) return { label: '大师', perfect: false };
  for (const [pegsLeft, label] of GRADE_TABLE) {
    if (n === pegsLeft) return { label, perfect: false };
  }
  return { label: '继续努力', perfect: false };
}
