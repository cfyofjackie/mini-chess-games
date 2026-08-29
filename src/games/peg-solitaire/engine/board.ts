// 棋盘几何与位棋盘表示：7×7 网格中的英式 33 孔十字棋盘。
// JS 位运算只有 32 位，49 格拆成 { lo, hi } 双 lane：lo 管 bit 0–31，hi 管 bit 32–48。

export const SIZE = 7;
export const CENTER = 3 * SIZE + 3; // 24，中心孔

export function idx(r: number, c: number): number {
  return r * SIZE + c;
}

export function rowOf(i: number): number {
  return Math.floor(i / SIZE);
}

export function colOf(i: number): number {
  return i % SIZE;
}

export function isValidCell(r: number, c: number): boolean {
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return false;
  return (r >= 2 && r <= 4) || (c >= 2 && c <= 4);
}

export const VALID_CELLS: readonly number[] = (() => {
  const cells: number[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (isValidCell(r, c)) cells.push(idx(r, c));
    }
  }
  return cells;
})();

export const VALID_SET: ReadonlySet<number> = new Set(VALID_CELLS);

export interface Bits {
  lo: number;
  hi: number;
}

export const NO_PEGS: Bits = { lo: 0, hi: 0 };

export function hasPeg(b: Bits, i: number): boolean {
  return i < 32 ? (b.lo & (1 << i)) !== 0 : (b.hi & (1 << (i - 32))) !== 0;
}

export function withPeg(b: Bits, i: number, on: boolean): Bits {
  if (i < 32) {
    return { lo: on ? b.lo | (1 << i) : b.lo & ~(1 << i), hi: b.hi };
  }
  return {
    lo: b.lo,
    hi: on ? b.hi | (1 << (i - 32)) : b.hi & ~(1 << (i - 32)),
  };
}

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

export function pegCount(b: Bits): number {
  return popcount32(b.lo) + popcount32(b.hi);
}

// 49 位状态打包成唯一 Number（lo 无符号 × 2^17 + hi），用于求解器记忆化
export function packed(b: Bits): number {
  return (b.lo >>> 0) * (1 << 17) + (b.hi >>> 0);
}

// 7×7 棋盘的 8 重对称（4 旋转 × 镜像），十字棋盘在每种变换下映射到自身
type CoordFn = (r: number, c: number) => [number, number];

const TRANSFORMS: CoordFn[] = [
  (r, c) => [r, c],
  (r, c) => [c, SIZE - 1 - r],
  (r, c) => [SIZE - 1 - r, SIZE - 1 - c],
  (r, c) => [SIZE - 1 - c, r],
  (r, c) => [r, SIZE - 1 - c],
  (r, c) => [SIZE - 1 - r, c],
  (r, c) => [c, r],
  (r, c) => [SIZE - 1 - c, SIZE - 1 - r],
];

export const SYMMETRY_PERMS: readonly number[][] = TRANSFORMS.map((f) => {
  const perm = new Array<number>(SIZE * SIZE).fill(-1);
  for (const i of VALID_CELLS) {
    const [nr, nc] = f(rowOf(i), colOf(i));
    perm[i] = idx(nr, nc);
  }
  return perm;
});

export function transform(b: Bits, k: number): Bits {
  const perm = SYMMETRY_PERMS[k];
  let lo = 0;
  let hi = 0;
  for (const i of VALID_CELLS) {
    if (!hasPeg(b, i)) continue;
    const t = perm[i];
    if (t < 32) lo |= 1 << t;
    else hi |= 1 << (t - 32);
  }
  return { lo, hi };
}

export function canonicalKey(b: Bits): number {
  let best = Infinity;
  for (let k = 0; k < SYMMETRY_PERMS.length; k++) {
    const p = packed(transform(b, k));
    if (p < best) best = p;
  }
  return best;
}

// 标准开局：33 孔全满，仅中心为空
export const START: Bits = (() => {
  let b = NO_PEGS;
  for (const i of VALID_CELLS) {
    if (i !== CENTER) b = withPeg(b, i, true);
  }
  return b;
})();
