// 选择提示与王邻格解释（规格书第九节）：纯函数 explainSelection / kingNeighborReasons /
// toastText 的单元测试。局面一律用引擎的 position() 构造器搭建。
// 覆盖：初始白王邻格全 own / 牵制 → pinned / 堵死 → blocked / 邻格受攻 attacked /
// 敌子受保护 defended / 有合法步与非法入参 → null / toast 文案定值。
import { describe, expect, it } from 'vitest';
import { fromAlgebraic, initialState, isAttacked, position } from '../engine/chess';
import { explainSelection, kingNeighborReasons, toastText } from './hints';

describe('explainSelection（零合法步原因）', () => {
  it('牵制局面：e4 马被 e8 车沿 e 线牵制（王 e1）→ pinned', () => {
    // 马的任何一步都离开 e 线，走开即车 e8→e1 送将：合法步 0、伪合法步 8
    const s = position(
      [
        ['e1', 'K'],
        ['e4', 'N'],
        ['e8', 'r'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    expect(explainSelection(s, fromAlgebraic('e4'))).toBe('pinned');
  });

  it('有合法落点的棋子 → null（同形局面但车在 h8，不牵制）', () => {
    const s = position(
      [
        ['e1', 'K'],
        ['e4', 'N'],
        ['h8', 'r'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    expect(explainSelection(s, fromAlgebraic('e4'))).toBeNull();
  });

  it('完全被堵局面：c1 象被己方兵（b2/d2）堵死 → blocked', () => {
    const s = position(
      [
        ['e1', 'K'],
        ['c1', 'B'],
        ['b2', 'P'],
        ['d2', 'P'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    expect(explainSelection(s, fromAlgebraic('c1'))).toBe('blocked');
  });

  it('空格 / 对方棋子 / 终局 → null（不解释）', () => {
    const s = position(
      [
        ['e1', 'K'],
        ['d2', 'P'],
        ['e7', 'p'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    expect(explainSelection(s, fromAlgebraic('e4'))).toBeNull(); // 空格
    expect(explainSelection(s, fromAlgebraic('e7'))).toBeNull(); // 对方棋子
    expect(explainSelection({ ...s, status: 'won' }, fromAlgebraic('d2'))).toBeNull(); // 终局静默
  });
});

describe('kingNeighborReasons（王邻格解释）', () => {
  it('初始局面选白王 → 邻格（d1/f1/d2/e2/f2）全部 own', () => {
    // e1 在底线：8 个方向中 5 个在盘内，其余为盘外（无 idx 可标注）
    const reasons = kingNeighborReasons(initialState(), fromAlgebraic('e1'));
    expect(new Set(reasons.map((x) => x.idx))).toEqual(
      new Set(['d1', 'd2', 'e2', 'f1', 'f2'].map(fromAlgebraic)),
    );
    expect(reasons.every((x) => x.reason === 'own')).toBe(true);
  });

  it('盘中央的王 8 邻格全 own（己方棋子围满）', () => {
    const s = position(
      [
        ['e4', 'K'],
        ['d3', 'P'],
        ['e3', 'P'],
        ['f3', 'P'],
        ['d4', 'P'],
        ['f4', 'P'],
        ['d5', 'P'],
        ['e5', 'P'],
        ['f5', 'P'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    const reasons = kingNeighborReasons(s, fromAlgebraic('e4'));
    expect(reasons).toHaveLength(8);
    expect(reasons.every((x) => x.reason === 'own')).toBe(true);
  });

  it('空邻格受攻 → attacked（黑兵 c4 攻 d3，王 e4）', () => {
    const s = position(
      [
        ['e4', 'K'],
        ['c4', 'p'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    const d3 = fromAlgebraic('d3');
    expect(kingNeighborReasons(s, fromAlgebraic('e4'))).toEqual([{ idx: d3, reason: 'attacked' }]);
    // 与引擎攻击检测交叉印证：d3 确被黑方攻击，而 d4 没有
    expect(isAttacked(s.board, 5, 3, 2)).toBe(true);
    expect(isAttacked(s.board, 4, 3, 2)).toBe(false);
  });

  it('邻格敌子受保护 → defended（黑马 e5 有 d6 兵保护，王 e4）', () => {
    // 吃 e5 马会被 d6 兵反吃送将 → 守；马同时攻到空邻格 d3/f3 → 攻；其余邻格均为合法落点
    const s = position(
      [
        ['e4', 'K'],
        ['e5', 'n'],
        ['d6', 'p'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    const reasons = kingNeighborReasons(s, fromAlgebraic('e4'));
    expect(reasons).toHaveLength(3);
    expect(reasons).toEqual(
      expect.arrayContaining([
        { idx: fromAlgebraic('e5'), reason: 'defended' },
        { idx: fromAlgebraic('d3'), reason: 'attacked' },
        { idx: fromAlgebraic('f3'), reason: 'attacked' },
      ]),
    );
    expect(reasons.every((x) => x.reason !== 'own')).toBe(true);
  });

  it('选中格不是行棋方的王（空格 / 黑王 / 终局）→ 空数组', () => {
    const s = position(
      [
        ['e4', 'K'],
        ['a8', 'k'],
      ],
      { current: 1 },
    );
    expect(kingNeighborReasons(s, fromAlgebraic('d5'))).toEqual([]); // 空格
    expect(kingNeighborReasons(s, fromAlgebraic('a8'))).toEqual([]); // 非行棋方的王（黑王）
    expect(kingNeighborReasons({ ...s, current: 2 }, fromAlgebraic('e4'))).toEqual([]); // 轮到黑方
  });
});

describe('toastText（提示文案，规格书定值）', () => {
  it('牵制 / 堵死 / 轮次各有固定文案', () => {
    expect(toastText({ kind: 'hint', reason: 'pinned' })).toBe('这枚棋子被牵制：走开会送将');
    expect(toastText({ kind: 'hint', reason: 'blocked' })).toBe('这枚棋子当前无路可走');
    expect(toastText({ kind: 'turn', side: 1 })).toBe('现在是白方回合');
    expect(toastText({ kind: 'turn', side: 2 })).toBe('现在是黑方回合');
  });
});
