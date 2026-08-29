import { describe, expect, it } from 'vitest';
import {
  DIR_NEIGHBORS,
  HOLES,
  HOLES_GEO,
  NEIGHBORS,
  type CCState,
  type Player,
  P1_CAMP,
  P2_CAMP,
  campProgress,
  indexOf,
  initialState,
  movesFrom,
  place,
  targetCamp,
  undo,
  winnerOf,
} from './chinese-checkers';

const at = indexOf;
const sortIdx = (a: number[]) => [...a].sort((x, y) => x - y);

/** 按 (x, z) 坐标直接摆子构造任意局面，用于精确控制测试场景 */
function mkState(pieces: Array<[number, number, Player]>, current: Player = 1): CCState {
  const board = new Int8Array(HOLES);
  for (const [x, z, p] of pieces) board[at(x, z)] = p;
  return { board, history: [], current, status: 'playing', winner: 0, lastFrom: -1, lastTo: -1 };
}

/** 1 方距胜利一步的局面：上臂 9 子就位，最后一子在 (1,-4) 可一步进 (1,-5) */
function nearWin1(): CCState {
  return mkState([
    [2, -5, 1],
    [3, -5, 1],
    [4, -5, 1],
    [2, -6, 1],
    [3, -6, 1],
    [4, -6, 1],
    [3, -7, 1],
    [4, -7, 1],
    [4, -8, 1],
    [1, -4, 1],
  ]);
}

describe('棋盘几何（生成函数本身）', () => {
  it('恰 121 孔，axial 坐标互不重复，indexOf 双射且星形外为 -1', () => {
    expect(HOLES_GEO).toHaveLength(121);
    const keys = new Set(HOLES_GEO.map((h) => `${h.x},${h.z}`));
    expect(keys.size).toBe(121);
    HOLES_GEO.forEach((h, i) => expect(indexOf(h.x, h.z)).toBe(i));
    expect(at(0, 0)).toBe(60); // 中心孔
    expect(at(5, -5)).toBe(-1); // 星形凹处的空缺点
    expect(at(9, 0)).toBe(-1);
    expect(at(0, 9)).toBe(-1);
  });

  it('行宽自上而下为 1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1（经典六角星）', () => {
    const rows = new Map<number, number>();
    for (const h of HOLES_GEO) rows.set(h.z, (rows.get(h.z) ?? 0) + 1);
    expect([...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n)).toEqual([
      1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1,
    ]);
  });

  it('邻接：每孔 2–6 个正邻，臂尖恰 2 邻，中心 6 邻，总边数 312，度数分布正确', () => {
    expect(NEIGHBORS).toHaveLength(121);
    for (const ds of DIR_NEIGHBORS) expect(ds).toHaveLength(6); // 方向化邻接表恒 6 列

    const hist: Record<number, number> = {};
    for (const n of NEIGHBORS) {
      expect(n.length).toBeGreaterThanOrEqual(2);
      expect(n.length).toBeLessThanOrEqual(6);
      hist[n.length] = (hist[n.length] ?? 0) + 1;
    }
    expect(hist).toEqual({ 2: 6, 4: 36, 5: 6, 6: 73 });
    const edges = NEIGHBORS.reduce((s, n) => s + n.length, 0) / 2;
    expect(edges).toBe(312);

    // 六个臂尖（|cube 坐标| 最大值 = 8）都恰有 2 个邻居
    const tips = HOLES_GEO.map((h, i) => ({ h, i })).filter(
      ({ h }) => Math.max(Math.abs(h.x), Math.abs(h.x + h.z), Math.abs(h.z)) === 8,
    );
    expect(tips).toHaveLength(6);
    for (const { i } of tips) expect(NEIGHBORS[i]).toHaveLength(2);
    // 上臂尖 (4,-8) 的两个邻居是 (4,-7) 与 (3,-7)（邻接表按 DIRS 序，比较按集合）
    expect(sortIdx(NEIGHBORS[at(4, -8)])).toEqual(sortIdx([at(4, -7), at(3, -7)]));
    expect(NEIGHBORS[at(0, 0)]).toHaveLength(6);
  });

  it('邻接边与百分比坐标构成等边三角形点阵：所有相邻孔间距相等，中心在 (50,50)', () => {
    const unit = (0.94 * 100) / (8 * Math.sqrt(3)); // 一格间距占容器的百分比
    for (let i = 0; i < HOLES; i++) {
      for (const j of NEIGHBORS[i]) {
        const d = Math.hypot(HOLES_GEO[i].px - HOLES_GEO[j].px, HOLES_GEO[i].py - HOLES_GEO[j].py);
        expect(Math.abs(d - unit)).toBeLessThan(1e-9);
      }
    }
    expect(HOLES_GEO[at(0, 0)].px).toBeCloseTo(50, 9);
    expect(HOLES_GEO[at(0, 0)].py).toBeCloseTo(50, 9);
    for (const h of HOLES_GEO) {
      expect(h.px).toBeGreaterThan(0);
      expect(h.px).toBeLessThan(100);
      expect(h.py).toBeGreaterThan(0);
      expect(h.py).toBeLessThan(100);
    }
  });

  it('星形 180° 旋转自同构：邻接关系在 i ↔ 120-i 下保持', () => {
    for (let i = 0; i < HOLES; i++) {
      for (const j of NEIGHBORS[i]) {
        expect(NEIGHBORS[HOLES - 1 - i]).toContain(HOLES - 1 - j);
      }
    }
  });

  it('双方出发臂：各恰 10 孔、互不相交、分居上下对角', () => {
    expect(P1_CAMP).toHaveLength(10);
    expect(P2_CAMP).toHaveLength(10);
    for (const i of P1_CAMP) {
      expect(HOLES_GEO[i].z).toBeGreaterThanOrEqual(5); // 下方臂
      expect(HOLES_GEO[i].py).toBeGreaterThan(50);
    }
    for (const i of P2_CAMP) {
      expect(HOLES_GEO[i].z).toBeLessThanOrEqual(-5); // 上方臂
      expect(HOLES_GEO[i].py).toBeLessThan(50);
    }
    for (const i of P1_CAMP) expect(P2_CAMP).not.toContain(i);
    expect(targetCamp(1)).toEqual(P2_CAMP); // 1 方目标 = 对方出发臂
    expect(targetCamp(2)).toEqual(P1_CAMP);
  });
});

describe('初始局面', () => {
  it('双方各 10 子占满对角两臂、其余全空，先行方先手', () => {
    const s = initialState();
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.winner).toBe(0);
    expect(s.history).toHaveLength(0);
    expect(s.lastFrom).toBe(-1);
    expect(s.lastTo).toBe(-1);
    let ones = 0;
    let twos = 0;
    for (let i = 0; i < HOLES; i++) {
      if (s.board[i] === 1) ones++;
      if (s.board[i] === 2) twos++;
    }
    expect(ones).toBe(10);
    expect(twos).toBe(10);
    for (const i of P1_CAMP) expect(s.board[i]).toBe(1);
    for (const i of P2_CAMP) expect(s.board[i]).toBe(2);
    expect(s.board[at(0, 0)]).toBe(0); // 中心为空
    expect(campProgress(s.board, 1)).toBe(0);
    expect(campProgress(s.board, 2)).toBe(0);
  });

  it('开局走法：营区深处无路可走，臂根可走进中盘或跳出友军', () => {
    const s = initialState();
    // 下臂尖 (-4,8) 及二、三排 (-3,7)(-4,7)：邻位皆己方子、跳点也落在己方营区 → 无路可走
    expect(movesFrom(s, at(-4, 8))).toEqual([]);
    expect(movesFrom(s, at(-3, 7))).toEqual([]);
    expect(movesFrom(s, at(-4, 7))).toEqual([]);
    // 上臂尖 (4,-8) 同理；且开局轮到 1 方，守卫同样返回空
    expect(movesFrom(s, at(4, -8))).toEqual([]);
    // 臂根 (-4,5)：走进中盘两步
    expect(movesFrom(s, at(-4, 5))).toEqual(sortIdx([at(-4, 4), at(-3, 4)]));
    // (-1,5)：走进 (0,4)、(-1,4) 两步
    expect(movesFrom(s, at(-1, 5))).toEqual(sortIdx([at(0, 4), at(-1, 4)]));
    // (-4,6)：无相邻空位，但可连跳两处（跳过 (-4,5) 落 (-4,4)；跳过 (-3,5) 落 (-2,4)）
    expect(movesFrom(s, at(-4, 6))).toEqual(sortIdx([at(-4, 4), at(-2, 4)]));
  });
});

describe('走法生成', () => {
  it('相邻走一步：孤立在中心的子恰有 6 个一步终点', () => {
    const s = mkState([[0, 0, 1]]);
    expect(movesFrom(s, at(0, 0))).toEqual(
      sortIdx([at(1, -1), at(1, 0), at(0, 1), at(-1, 1), at(-1, 0), at(0, -1)]),
    );
  });

  it('单跳：跳过紧邻棋子（任意颜色）落到正后方空孔', () => {
    // 跳过对方子
    const overEnemy = mkState([
      [0, 0, 1],
      [1, 0, 2],
    ]);
    const te = movesFrom(overEnemy, at(0, 0));
    expect(te).toContain(at(2, 0)); // 跳过 (1,0) 落 (2,0)
    expect(te).toContain(at(1, -1)); // 其余 5 个空邻仍是一步终点
    expect(te).not.toContain(at(0, 0));
    expect(te).not.toContain(at(1, 0)); // 被跳的子本身不是终点
    // 跳过己方子
    const overOwn = mkState([
      [0, 0, 1],
      [1, 0, 1],
    ]);
    expect(movesFrom(overOwn, at(0, 0))).toContain(at(2, 0));
  });

  it('直线两连跳', () => {
    const s = mkState([
      [0, 0, 1],
      [1, 0, 2],
      [3, 0, 2],
    ]);
    const t = movesFrom(s, at(0, 0));
    expect(t).toContain(at(2, 0));
    expect(t).toContain(at(4, 0)); // (0,0)→(2,0)→(4,0)
    expect(t).not.toContain(at(3, 0)); // 跳板不是终点
  });

  it('连跳且链中变向：一步操作可达全部链上终点', () => {
    // (0,0) 跳 (1,0)→(2,0)，变向跳 (3,-1)→(4,-2)，再变向跳 (5,-2)→(6,-2)
    const s = mkState([
      [0, 0, 1],
      [1, 0, 2],
      [3, -1, 1],
      [5, -2, 2],
    ]);
    const t = movesFrom(s, at(0, 0));
    expect(t).toEqual(
      sortIdx([
        at(1, -1),
        at(0, 1),
        at(-1, 1),
        at(-1, 0),
        at(0, -1), // 5 个一步终点（(1,0) 被占）
        at(2, 0), // 第一跳
        at(4, -2), // 第二跳（变向）
        at(6, -2), // 第三跳（再变向）
      ]),
    );
    // 所有终点都是空孔
    for (const i of t) expect(s.board[i]).toBe(0);
  });

  it('跳链不可穿越两子、不可落在非空孔', () => {
    // (1,0)(2,0) 连续两子：跳过 (1,0) 的落点 (2,0) 被占 → (2,0)(3,0)(4,0) 均不可达
    const s = mkState([
      [0, 0, 1],
      [1, 0, 2],
      [2, 0, 2],
    ]);
    const t = movesFrom(s, at(0, 0));
    expect(t).toEqual(
      sortIdx([at(1, -1), at(0, 1), at(-1, 1), at(-1, 0), at(0, -1)]),
    );
    expect(t).not.toContain(at(2, 0));
    expect(t).not.toContain(at(3, 0));
    expect(t).not.toContain(at(4, 0));
  });

  it('紧邻是空孔则不能跳', () => {
    const s = mkState([[0, 0, 1]]);
    const t = movesFrom(s, at(0, 0));
    expect(t).not.toContain(at(2, 0));
    expect(t).not.toContain(at(0, -2));
    expect(t).toHaveLength(6); // 只有 6 个一步终点
  });

  it('不能落回起跳原孔', () => {
    // (0,0) 跳到 (2,0) 后，若允许落回原孔则 (0,0) 会出现在终点里
    const s = mkState([
      [0, 0, 1],
      [1, 0, 2],
    ]);
    expect(movesFrom(s, at(0, 0))).not.toContain(at(0, 0));
  });

  it('movesFrom 守卫：非己方棋子 / 空孔 / 终局均返回空', () => {
    const s = initialState();
    expect(movesFrom(s, at(4, -8))).toEqual([]); // 对方棋子
    expect(movesFrom(s, at(0, 0))).toEqual([]); // 空孔
    expect(movesFrom(s, -1)).toEqual([]);
    expect(movesFrom(s, HOLES)).toEqual([]);
    const won = place(nearWin1(), at(1, -4), at(1, -5)); // 补进最后一子获胜
    expect(won.status).toBe('won');
    expect(movesFrom(won, at(0, 0))).toEqual([]);
  });
});

describe('place 与胜负', () => {
  it('走一步：换手、记录最后一手、快照入栈', () => {
    const s0 = initialState();
    const s1 = place(s0, at(-4, 5), at(-4, 4));
    expect(s1).not.toBe(s0);
    expect(s1.board[at(-4, 5)]).toBe(0);
    expect(s1.board[at(-4, 4)]).toBe(1);
    expect(s1.current).toBe(2);
    expect(s1.lastFrom).toBe(at(-4, 5));
    expect(s1.lastTo).toBe(at(-4, 4));
    expect(s1.history).toEqual([s0]);
  });

  it('整条跳链一次 place 完成：棋子直达链尾', () => {
    const s0 = mkState([
      [0, 0, 1],
      [1, 0, 2],
      [3, -1, 1],
      [5, -2, 2],
    ]);
    const s1 = place(s0, at(0, 0), at(6, -2));
    expect(s1.board[at(0, 0)]).toBe(0);
    expect(s1.board[at(6, -2)]).toBe(1);
    expect(s1.board[at(2, 0)]).toBe(0); // 中途点不残留棋子
    expect(s1.history).toEqual([s0]); // 一条链只产生一个快照
    expect(s1.current).toBe(2);
  });

  it('非法目标拒绝：不可达孔 / 越界 / 原地', () => {
    const s = initialState();
    expect(place(s, at(-4, 8), at(0, 0))).toBe(s); // 远处不可达
    expect(place(s, at(-4, 8), at(-4, 4))).toBe(s); // 跳不到那么远
    expect(place(s, at(-4, 8), -1)).toBe(s);
    expect(place(s, at(-4, 8), HOLES)).toBe(s);
    expect(place(s, at(-4, 8), at(-4, 8))).toBe(s); // 原地
  });

  it('占用孔拒绝（含落回己方/对方棋子上）', () => {
    const s = initialState();
    expect(place(s, at(-4, 5), at(-3, 5))).toBe(s); // 己方棋子
    expect(place(s, at(-4, 5), at(-4, 6))).toBe(s); // 己方棋子
    expect(place(s, at(-4, 8), at(-4, 7))).toBe(s); // 跳板孔被占
  });

  it('只能动己方棋子；终局后拒绝一切操作', () => {
    const s = initialState();
    expect(place(s, at(4, -8), at(4, -6))).toBe(s); // 对方棋子
    expect(place(s, at(0, 0), at(0, -1))).toBe(s); // 空孔
    const won = place(nearWin1(), at(1, -4), at(1, -5));
    expect(won.status).toBe('won');
    expect(place(won, at(1, -5), at(1, -4))).toBe(won); // 终局后拒绝
    expect(place(won, at(0, 0), at(0, -1))).toBe(won);
  });

  it('胜利判定：10 子全部进入对臂才算胜', () => {
    // 1 方：上臂 9 子就位 + (1,-4) 一子补位 → 胜
    const near = mkState([
      [2, -5, 1],
      [3, -5, 1],
      [4, -5, 1],
      [2, -6, 1],
      [3, -6, 1],
      [4, -6, 1],
      [3, -7, 1],
      [4, -7, 1],
      [4, -8, 1],
      [1, -4, 1],
    ]);
    expect(winnerOf(near.board)).toBe(0);
    expect(campProgress(near.board, 1)).toBe(9);
    const won = place(near, at(1, -4), at(1, -5));
    expect(won.status).toBe('won');
    expect(won.winner).toBe(1);
    expect(won.current).toBe(1); // 胜利时轮次停在胜方
    expect(campProgress(won.board, 1)).toBe(10);
    expect(winnerOf(won.board)).toBe(1);

    // 差一子不算胜：只进 9 子（(1,-5) 仍空着，另有 (1,-4) 一颗场外子）
    const nine = mkState([
      [3, -5, 1],
      [4, -5, 1],
      [2, -6, 1],
      [3, -6, 1],
      [4, -6, 1],
      [3, -7, 1],
      [4, -7, 1],
      [4, -8, 1],
      [2, -4, 1],
      [1, -4, 1],
    ]);
    expect(campProgress(nine.board, 1)).toBe(8);
    const notYet = place(nine, at(2, -4), at(2, -5));
    expect(notYet.status).toBe('playing');
    expect(notYet.winner).toBe(0);
    expect(notYet.current).toBe(2);
    expect(campProgress(notYet.board, 1)).toBe(9); // 距胜利还差 (1,-5) 一子
  });

  it('2 方同样以占满下臂获胜', () => {
    // 下臂 9 子就位（(-1,5) 空着），最后一子在 (-1,4) 待进
    const near = mkState(
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
    expect(winnerOf(near.board)).toBe(0);
    const won = place(near, at(-1, 4), at(-1, 5));
    expect(won.status).toBe('won');
    expect(won.winner).toBe(2);
  });

  it('campProgress 与 winnerOf 直接判定', () => {
    const board = new Int8Array(HOLES);
    for (const i of P2_CAMP) board[i] = 1;
    expect(winnerOf(board)).toBe(1);
    const board2 = new Int8Array(HOLES);
    for (const i of P1_CAMP) board2[i] = 2;
    expect(winnerOf(board2)).toBe(2);
    const mixed = new Int8Array(HOLES);
    mixed[P2_CAMP[0]] = 1;
    expect(winnerOf(mixed)).toBe(0);
    expect(campProgress(board, 1)).toBe(10);
    expect(campProgress(board, 2)).toBe(0);
  });
});

describe('悔棋（快照数组）', () => {
  it('空历史悔棋是空操作', () => {
    const s = initialState();
    expect(undo(s)).toBe(s);
  });

  it('悔棋弹出的快照与上一手之前的状态全同（含单跳）', () => {
    const s0 = initialState();
    const s1 = place(s0, at(-4, 5), at(-4, 4)); // 1 方走一步 → 轮到 2
    const s2 = place(s1, at(4, -5), at(4, -4)); // 2 方镜像走一步 → 轮到 1
    expect(undo(s1)).toBe(s0);
    expect(undo(s2)).toBe(s1);
    expect(s2.board[at(4, -4)]).toBe(2);
    expect(undo(s2).board[at(4, -4)]).toBe(0);
    expect(undo(s2).current).toBe(2);
    // 快照一致性：连续悔棋逐级回退
    const s3 = place(s2, at(-3, 5), at(-3, 4));
    expect(undo(s3)).toBe(s2);
    expect(undo(undo(undo(s3)))).toBe(s0);
  });

  it('跳链一步只产生一个快照，悔棋整体回退', () => {
    const s0 = mkState([
      [0, 0, 1],
      [1, 0, 2],
      [3, -1, 1],
      [5, -2, 2],
    ]);
    const s1 = place(s0, at(0, 0), at(6, -2));
    expect(s1.history).toHaveLength(1);
    const back = undo(s1);
    expect(back).toBe(s0);
    expect(back.board[at(0, 0)]).toBe(1);
    expect(back.board[at(6, -2)]).toBe(0);
    expect(back.current).toBe(1);
  });

  it('胜局悔棋：恢复到获胜手之前的可下状态', () => {
    const near = mkState([
      [2, -5, 1],
      [3, -5, 1],
      [4, -5, 1],
      [2, -6, 1],
      [3, -6, 1],
      [4, -6, 1],
      [3, -7, 1],
      [4, -7, 1],
      [4, -8, 1],
      [1, -4, 1],
    ]);
    const won = place(near, at(1, -4), at(1, -5));
    expect(won.status).toBe('won');
    const resumed = undo(won);
    expect(resumed).toBe(near);
    expect(resumed.status).toBe('playing');
    expect(resumed.current).toBe(1);
    expect(resumed.board[at(1, -5)]).toBe(0);
  });
});
