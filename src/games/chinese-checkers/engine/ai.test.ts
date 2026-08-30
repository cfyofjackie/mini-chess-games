// 中国跳棋 AI 测试：直接测 engine/ai.ts（规格书第四节测试清单逐条）。
// 覆盖：落子必合法、简单档贪心必选推进步、长跳链选中链式大步、临门入营必取胜、
// 确定性，以及"已入营子移出目标营"的等效禁止（出营问题）。
import { describe, expect, it } from 'vitest';
import {
  HOLES,
  HOLES_GEO,
  NEIGHBORS,
  type CCState,
  type Player,
  campProgress,
  indexOf,
  initialState,
  movesFrom,
  place,
} from './chinese-checkers';
import { chooseMove, type Difficulty } from './ai';

const at = indexOf;
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/** 按 (x, z) 坐标直接摆子构造任意局面，用于精确控制测试场景 */
function mkState(pieces: Array<[number, number, Player]>, current: Player = 1): CCState {
  const board = new Int8Array(HOLES);
  for (const [x, z, p] of pieces) board[at(x, z)] = p;
  return { board, history: [], current, status: 'playing', winner: 0, lastFrom: -1, lastTo: -1 };
}

// ---- 独立距离 oracle（不依赖 ai.ts 内部表）：到目标角尖的六角距离（cube 曼哈顿 / 2） ----
const TIP: Record<Player, { x: number; z: number }> = { 1: { x: 4, z: -8 }, 2: { x: -4, z: 8 } };

function hexDist(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  const dy = -dx - dz;
  return (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) / 2;
}

/** p 方全部棋子到目标角的距离总和（评估的目标量，下降 = 推进） */
function totalDist(board: Int8Array, p: Player): number {
  const tip = TIP[p];
  let sum = 0;
  for (let i = 0; i < HOLES; i++) {
    if (board[i] === p) sum += hexDist(HOLES_GEO[i].x, HOLES_GEO[i].z, tip.x, tip.z);
  }
  return sum;
}

/** AI 自对弈若干手得到中盘局面（同一难度必然走出同一对局） */
function selfPlay(difficulty: Difficulty, plies: number): CCState {
  let s = initialState();
  for (let i = 0; i < plies && s.status === 'playing'; i++) {
    const r = chooseMove(s, difficulty);
    if (r.from < 0) break;
    s = place(s, r.from, r.to);
  }
  return s;
}

/** 2 方距胜利一步的局面：下臂 9 子就位，最后一子在 (-1,4) 可一步进 (-1,5) */
function nearWin2(): CCState {
  return mkState(
    [
      [-2, 5, 2],
      [-3, 5, 2],
      [-4, 5, 2],
      [-2, 6, 2],
      [-3, 6, 2],
      [-4, 6, 2],
      [-3, 7, 2],
      [-4, 7, 2],
      [-4, 8, 2],
      [-1, 4, 2],
    ],
    2,
  );
}

describe('chinese-checkers AI（规格书第四节测试清单）', () => {
  it('清单 1：AI 落子必合法——起点是己方棋子且终点 ∈ 该子 movesFrom 集合；无着法 / 终局返回 -1', () => {
    // AI 执 2 方：开局（2 方回合）、中盘（自对弈第 7 手后）、临门（差一步入营）
    const states: CCState[] = [
      { ...initialState(), current: 2 },
      selfPlay('medium', 7),
      nearWin2(),
    ];
    for (const s of states) {
      expect(s.status).toBe('playing');
      for (const d of DIFFICULTIES) {
        const r = chooseMove(s, d);
        expect(r.from).toBeGreaterThanOrEqual(0);
        expect(s.board[r.from]).toBe(s.current); // 动的是己方棋子
        expect(movesFrom(s, r.from)).toContain(r.to); // 终点 ∈ 引擎 movesFrom 集合
      }
    }

    // 2 方棋子被完全封死（中心子被两圈对方子围死，无步可走亦无跳可跳）→ 返回 -1 而非非法着法
    const center = at(0, 0);
    const ring1 = NEIGHBORS[center];
    const ring2 = new Set<number>();
    for (const n of ring1) {
      for (const m of NEIGHBORS[n]) {
        if (m !== center && !ring1.includes(m)) ring2.add(m);
      }
    }
    expect(ring2.size).toBe(12);
    const sealed = mkState(
      [
        ...[...ring1, ...ring2].map((i) => [HOLES_GEO[i].x, HOLES_GEO[i].z, 1] as [number, number, Player]),
        [0, 0, 2],
      ],
      2,
    );
    expect(movesFrom(sealed, center)).toEqual([]);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(sealed, d)).toEqual({ from: -1, to: -1, nodes: expect.any(Number) });
    }

    // 终局后不再求解
    const won = place(nearWin2(), at(-1, 4), at(-1, 5));
    expect(won.status).toBe('won');
    for (const d of DIFFICULTIES) {
      expect(chooseMove(won, d).from).toBe(-1);
    }
  });

  it('清单 2：简单档贪心必选前进推进步（距离总和严格下降）', () => {
    // 2 方子 (0,-2) 跳过对方子 (0,-1) 直达 (0,0)：距离 10 → 8（降幅 2），
    // 而 (4,-8) 的所有走步降幅仅 1 → 唯一最大降幅
    const s = mkState([
      [0, -2, 2],
      [0, -1, 1],
      [4, -8, 2],
    ], 2);
    const before = totalDist(s.board, 2);
    expect(before).toBe(26); // d(0,-2)=10 + d(4,-8)=16

    const r = chooseMove(s, 'easy');
    expect(r.from).toBe(at(0, -2));
    expect(r.to).toBe(at(0, 0));
    expect(movesFrom(s, r.from)).toContain(r.to); // 合法（跳过 (0,-1) 的跳链）

    const after = totalDist(place(s, r.from, r.to).board, 2);
    expect(after).toBeLessThan(before); // 距离总和下降 = 推进
    expect(before - after).toBe(2); // 且恰为全部一次操作中的最大降幅
  });

  it('清单 3：长跳链局面——简单 / 困难档能选中链式大步（降幅显著大于相邻一步）', () => {
    // 2 方子 (2,-6) 沿左下方连跳三段：(2,-6)→(0,-4)→(-2,-2)→(-4,0)，
    // 距离 14 → 8（降幅 6）；其余着法（相邻一步 / 营内跳）降幅 ≤ 2，唯一最大
    const s = mkState(
      [
        [2, -6, 2],
        [1, -5, 1], // 跳板
        [-1, -3, 1], // 跳板
        [-3, -1, 1], // 跳板
        [2, -5, 2],
        [3, -5, 2],
        [4, -5, 2],
        [3, -6, 2],
        [4, -6, 2],
        [3, -7, 2],
        [4, -7, 2],
        [4, -8, 2],
      ],
      2,
    );
    const before = totalDist(s.board, 2);
    for (const d of ['easy', 'hard'] as const) {
      const r = chooseMove(s, d);
      expect(r.from).toBe(at(2, -6));
      expect(r.to).toBe(at(-4, 0)); // 链尾一步直达
      const after = totalDist(place(s, r.from, r.to).board, 2);
      expect(before - after).toBe(6); // 降幅 6，显著大于任何相邻一步（≤1）与其余跳链（≤4）
    }
  });

  it('清单 4：只差一步即全员入营——三档难度必完成入营取胜', () => {
    const s = nearWin2();
    expect(campProgress(s.board, 2)).toBe(9);
    for (const d of DIFFICULTIES) {
      const r = chooseMove(s, d);
      expect(r.from).toBe(at(-1, 4));
      expect(r.to).toBe(at(-1, 5));
      const won = place(s, r.from, r.to);
      expect(won.status).toBe('won');
      expect(won.winner).toBe(2);
      expect(campProgress(won.board, 2)).toBe(10);
    }
  });

  it('清单 5：确定性——同一局面两次求解，步与节点数完全一致', () => {
    const s = selfPlay('hard', 8); // 中盘局面（自对弈本身确定）
    expect(s.status).toBe('playing');
    for (const d of DIFFICULTIES) {
      const a = chooseMove(s, d);
      const b = chooseMove(s, d);
      expect(a.from).toBe(b.from);
      expect(a.to).toBe(b.to);
      expect(a.nodes).toBe(b.nodes); // 节点数一致 ⇒ 搜索过程完全可复现
      expect(a.from).toBeGreaterThanOrEqual(0);
      expect(a.nodes).toBeGreaterThan(0);
    }
  });

  it('出营问题：已入目标营的子移出营的动作被等效禁止，三档均不选（引擎规则不变）', () => {
    // 2 方 8 子已入下臂目标营，(-1,5) 一子的全部着法都是"移出目标营"（(0,4) / (-1,4)）；
    // 营内子与 (0,-2) 的推进子均有不出营的着法 → 三档都必须选后者而非出营
    const s = mkState(
      [
        [-1, 5, 2],
        [-2, 5, 2],
        [-3, 5, 2],
        [-4, 5, 2],
        [-2, 6, 2],
        [-3, 6, 2],
        [-4, 6, 2],
        [-3, 7, 2],
        [0, -2, 2],
      ],
      2,
    );
    expect(campProgress(s.board, 2)).toBe(8); // 未全员入营 → 不算胜
    const exits = movesFrom(s, at(-1, 5));
    expect(exits).toEqual([at(-1, 4), at(0, 4)]); // 该子确实只有出营着法
    expect(s.board[at(-1, 5)]).toBe(2); // 引擎规则不变：出营着法本身仍合法

    for (const d of DIFFICULTIES) {
      const r = chooseMove(s, d);
      expect(r.from).not.toBe(at(-1, 5)); // 绝不出营
      expect(s.board[r.from]).toBe(2);
      expect(movesFrom(s, r.from)).toContain(r.to);
    }
  });
});
