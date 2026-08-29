// DFS 求解器（性能敏感，热路径避免分配）：
// - 状态用两个闭包变量 lo/hi 原地 make/unmake，不复制对象
// - 失败记忆化：轨道不变键（对称变换取 min）入 Set，保证可达空间内必然终止
// - 走法按预排序表迭代（可切换排序策略），节点预算兜底
import {
  Bits,
  CENTER,
  colOf,
  pegCount,
  rowOf,
  SIZE,
  SYMMETRY_PERMS,
  VALID_CELLS,
} from '../engine/board';
import { MOVES_FROM, Move } from '../engine/rules';

export type SolveResult =
  | { status: 'solved'; moves: Move[] }
  | { status: 'unsolvable' }
  | { status: 'timeout' };

export interface SolveOptions {
  /** 搜索节点预算，超出即返回 timeout */
  nodeBudget?: number;
  /** 要求最后一子落在中心（完美模式） */
  endAtCenter?: boolean;
  /** 走法排序策略（性能调优用） */
  order?: OrderVariant;
}

export type OrderVariant = 'toCenter' | 'toEdge' | 'clearPeriphery';

export const HINT_BUDGET = 3_000_000;
export const DEMO_BUDGET = 40_000_000;

const dist = (i: number): number => Math.abs(rowOf(i) - 3) + Math.abs(colOf(i) - 3);

// 每个格子的走法表，按不同排序策略预排序
const SORTED_MOVES: Record<OrderVariant, readonly Move[][]> = (() => {
  const byToCenter = (a: Move, b: Move) => dist(a.to) - dist(b.to);
  const byToEdge = (a: Move, b: Move) => dist(b.to) - dist(a.to);
  const byClearPeriphery = (a: Move, b: Move) =>
    dist(b.from) - dist(a.from) || dist(a.to) - dist(b.to);
  const build = (cmp: (a: Move, b: Move) => number): readonly Move[][] =>
    MOVES_FROM.map((list) => [...list].sort(cmp));
  return {
    toCenter: build(byToCenter),
    toEdge: build(byToEdge),
    clearPeriphery: build(byClearPeriphery),
  };
})();

// 位掩码表：格子 i 在 lo/hi 中的位（另一 lane 恒为 0，便于无条件双 lane 运算）
const BIT_LO = new Int32Array(SIZE * SIZE);
const BIT_HI = new Int32Array(SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) {
  if (i < 32) BIT_LO[i] = 1 << i;
  else BIT_HI[i] = 1 << (i - 32);
}

// 对称变换掩码表：MASK_LO[k][i] = 格子 i 在第 k 种变换下的 lo 位贡献
const MASK_LO: Int32Array[] = [];
const MASK_HI: Int32Array[] = [];
for (let k = 0; k < SYMMETRY_PERMS.length; k++) {
  const mLo = new Int32Array(SIZE * SIZE);
  const mHi = new Int32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const t = SYMMETRY_PERMS[k][i];
    if (t < 0) continue;
    mLo[i] = BIT_LO[t];
    mHi[i] = BIT_HI[t];
  }
  MASK_LO.push(mLo);
  MASK_HI.push(mHi);
}

class SearchTimeout extends Error {
  constructor() {
    super('solver budget exceeded');
  }
}

export function solve(pegs: Bits, opts: SolveOptions = {}): SolveResult {
  const endAtCenter = opts.endAtCenter ?? false;
  const budget = opts.nodeBudget ?? HINT_BUDGET;
  const movesOf = SORTED_MOVES[opts.order ?? 'toCenter'];
  const dead = new Set<number>();
  const solution: Move[] = [];
  let lo = pegs.lo;
  let hi = pegs.hi;
  let nodes = 0;

  const hasBit = (i: number): boolean =>
    i < 32 ? (lo & BIT_LO[i]) !== 0 : (hi & BIT_HI[i]) !== 0;

  // 轨道不变键：对各对称变换各算 packed 取最小值，同轨道状态必得同键
  const orbitKey = (): number => {
    let best = Infinity;
    for (let k = 0; k < MASK_LO.length; k++) {
      const mL = MASK_LO[k];
      const mH = MASK_HI[k];
      let klo = 0;
      let khi = 0;
      for (let j = 0; j < VALID_CELLS.length; j++) {
        const i = VALID_CELLS[j];
        if (i < 32) {
          if ((lo & BIT_LO[i]) !== 0) {
            klo |= mL[i];
            khi |= mH[i];
          }
        } else if ((hi & BIT_HI[i]) !== 0) {
          klo |= mL[i];
          khi |= mH[i];
        }
      }
      const p = (klo >>> 0) * (1 << 17) + (khi >>> 0);
      if (p < best) best = p;
    }
    return best;
  };

  const dfs = (): boolean => {
    if (++nodes > budget) throw new SearchTimeout();
    const key = orbitKey();
    if (dead.has(key)) return false;
    let moved = false;
    for (let c = 0; c < VALID_CELLS.length; c++) {
      const from = VALID_CELLS[c];
      if (!hasBit(from)) continue;
      const list = movesOf[from];
      for (let j = 0; j < list.length; j++) {
        const m = list[j];
        if (!hasBit(m.over) || hasBit(m.to)) continue;
        moved = true;
        // make：清 from/over，置 to（to 必为空，可直接或上）
        lo = (lo & ~(BIT_LO[m.from] | BIT_LO[m.over])) | BIT_LO[m.to];
        hi = (hi & ~(BIT_HI[m.from] | BIT_HI[m.over])) | BIT_HI[m.to];
        solution.push(m);
        const ok = dfs();
        if (ok) return true; // 成功：保留路径上的走法，不再回退
        // 失败：unmake 恢复 from/over，清 to
        solution.pop();
        lo = (lo & ~BIT_LO[m.to]) | BIT_LO[m.from] | BIT_LO[m.over];
        hi = (hi & ~BIT_HI[m.to]) | BIT_HI[m.from] | BIT_HI[m.over];
      }
    }
    if (!moved) {
      return pegCount({ lo, hi }) === 1 && (!endAtCenter || hasBit(CENTER));
    }
    dead.add(key);
    return false;
  };

  try {
    const won = dfs();
    if (!won) return { status: 'unsolvable' };
    return { status: 'solved', moves: [...solution] };
  } catch (e) {
    if (e instanceof SearchTimeout) return { status: 'timeout' };
    throw e;
  }
}
