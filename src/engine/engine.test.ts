import { describe, expect, it } from 'vitest';
import {
  CENTER,
  NO_PEGS,
  START,
  canonicalKey,
  hasPeg,
  pegCount,
  transform,
  VALID_CELLS,
  withPeg,
} from './board';
import { applyMove, isGameOver, isLegal, legalMoves } from './rules';
import { grade } from './score';
import { solve } from '../solver/solver';

describe('board', () => {
  it('有效格恰为 33 个，开局 32 子且中心为空', () => {
    expect(VALID_CELLS).toHaveLength(33);
    expect(pegCount(START)).toBe(32);
    expect(hasPeg(START, CENTER)).toBe(false);
  });

  it('标准开局恰有 4 种走法（全部跳入中心）', () => {
    const moves = legalMoves(START);
    expect(moves).toHaveLength(4);
    for (const m of moves) expect(m.to).toBe(CENTER);
  });
});

describe('rules', () => {
  it('执行走法后：起子与被跳子移除，落点有子，总子数 -1', () => {
    const m = legalMoves(START)[0];
    const next = applyMove(START, m);
    expect(pegCount(next)).toBe(31);
    expect(hasPeg(next, m.from)).toBe(false);
    expect(hasPeg(next, m.over)).toBe(false);
    expect(hasPeg(next, m.to)).toBe(true);
  });

  it('拒绝非法走法（起点无子 / 落点被占）', () => {
    const [m] = legalMoves(START);
    expect(isLegal(START, m)).toBe(true);
    // 起点为空的中心
    expect(isLegal(START, { from: CENTER, over: m.over, to: m.to })).toBe(false);
    // 落点被占：中心摆上棋子后，跳入中心的走法不合法
    const blocked = withPeg(START, m.to, true);
    expect(isLegal(blocked, m)).toBe(false);
  });

  it('两子相隔一空位且无处可落 → 终局', () => {
    // (3,2) 与 (3,4) 有子，(3,3) 为空，双向都落不进（落点方向无延伸）
    let b = NO_PEGS;
    b = withPeg(b, 3 * 7 + 2, true);
    b = withPeg(b, 3 * 7 + 4, true);
    expect(isGameOver(b)).toBe(true);
    expect(grade(b).label).toBe('高手');
  });
});

describe('score', () => {
  it('按剩余子数评级，中心收官为天才', () => {
    expect(grade(withPeg(NO_PEGS, CENTER, true))).toEqual({
      label: '天才',
      perfect: true,
    });
    expect(grade(withPeg(NO_PEGS, 0, true)).label).toBe('大师');
    expect(grade(withPeg(withPeg(NO_PEGS, 0, true), 1, true)).label).toBe('高手');
    expect(grade(withPeg(withPeg(withPeg(NO_PEGS, 0, true), 1, true), 2, true)).label).toBe('优秀');
    expect(grade(withPeg(withPeg(withPeg(withPeg(NO_PEGS, 0, true), 1, true), 2, true), 3, true)).label).toBe('良好');
    expect(grade(withPeg(withPeg(withPeg(withPeg(withPeg(NO_PEGS, 0, true), 1, true), 2, true), 3, true), 4, true)).label).toBe('还不错');
    expect(grade(START).label).toBe('继续努力');
  });
});

describe('solver', () => {
  it(
    '对标准开局求出 31 步完整解，回放后恰剩 1 子',
    { timeout: 120_000 },
    () => {
      const r = solve(START, { nodeBudget: 40_000_000 });
      expect(r.status).toBe('solved');
      if (r.status !== 'solved') return;
      expect(r.moves).toHaveLength(31);
      let b = START;
      for (const m of r.moves) {
        expect(isLegal(b, m)).toBe(true);
        b = applyMove(b, m);
      }
      expect(pegCount(b)).toBe(1);
    },
  );

  it('终局无走法且非 1 子 → 不可解', () => {
    let b = NO_PEGS;
    b = withPeg(b, 3 * 7 + 2, true);
    b = withPeg(b, 3 * 7 + 4, true);
    expect(solve(b)).toEqual({ status: 'unsolvable' });
  });
});

describe('symmetry', () => {
  it('对称变换后的归一化键不变', () => {
    const base = canonicalKey(START);
    for (let k = 0; k < 8; k++) {
      expect(canonicalKey(transform(START, k))).toBe(base);
    }
  });
});
