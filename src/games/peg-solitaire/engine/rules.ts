// 走法规则：生成、判定、执行。全部为纯函数。
import {
  Bits,
  VALID_CELLS,
  colOf,
  hasPeg,
  idx,
  isValidCell,
  rowOf,
  SIZE,
  withPeg,
} from './board';

export interface Move {
  from: number;
  over: number;
  to: number;
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function buildMovesFrom(): Move[][] {
  const table: Move[][] = Array.from({ length: SIZE * SIZE }, () => []);
  for (const from of VALID_CELLS) {
    for (const [dr, dc] of DIRECTIONS) {
      const or = rowOf(from) + dr;
      const oc = colOf(from) + dc;
      const tr = rowOf(from) + 2 * dr;
      const tc = colOf(from) + 2 * dc;
      if (!isValidCell(or, oc) || !isValidCell(tr, tc)) continue;
      table[from].push({ from, over: idx(or, oc), to: idx(tr, tc) });
    }
  }
  return table;
}

export const MOVES_FROM: readonly Move[][] = buildMovesFrom();

export function legalMoves(pegs: Bits): Move[] {
  const out: Move[] = [];
  for (const from of VALID_CELLS) {
    if (!hasPeg(pegs, from)) continue;
    for (const m of MOVES_FROM[from]) {
      if (hasPeg(pegs, m.over) && !hasPeg(pegs, m.to)) out.push(m);
    }
  }
  return out;
}

export function isLegal(pegs: Bits, m: Move): boolean {
  return (
    hasPeg(pegs, m.from) &&
    hasPeg(pegs, m.over) &&
    !hasPeg(pegs, m.to) &&
    MOVES_FROM[m.from].some((x) => x.over === m.over && x.to === m.to)
  );
}

export function applyMove(pegs: Bits, m: Move): Bits {
  return withPeg(withPeg(withPeg(pegs, m.from, false), m.over, false), m.to, true);
}

// UI 点击空位时，反查从 from 跳到 to 的那条走法
export function findMove(pegs: Bits, from: number, to: number): Move | null {
  if (!hasPeg(pegs, from) || hasPeg(pegs, to)) return null;
  return MOVES_FROM[from].find((m) => m.to === to && hasPeg(pegs, m.over)) ?? null;
}

export function isGameOver(pegs: Bits): boolean {
  return legalMoves(pegs).length === 0;
}
