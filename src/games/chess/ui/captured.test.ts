// 吃子托盘数据提取（规格书第十二节）：capturedPieces / trayGroups 纯函数单元测试。
// 覆盖：正常吃 / 吃过路兵（含悔棋回退）/ 多手混合吃子的归属与被吃顺序 / 升变不误记为吃子 /
// 初始局面为空 / 多子按价值降序排列 + 同型合并 ×N。
import { describe, expect, it } from 'vitest';
import {
  B_BISHOP,
  B_KNIGHT,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  W_PAWN,
  fromAlgebraic,
  initialState,
  makeMove,
  position,
  undo,
} from '../engine/chess';
import { capturedPieces, trayGroups } from './captured';

describe('capturedPieces（从 history 快照序列提取被吃子）', () => {
  it('正常吃：白后吃黑兵 → 白方托盘 [黑兵]，黑方托盘为空', () => {
    const s0 = position(
      [
        ['e1', 'K'],
        ['e8', 'k'],
        ['d1', 'Q'],
        ['d5', 'p'],
      ],
      { current: 1 },
    );
    const s1 = makeMove(s0, fromAlgebraic('d1'), fromAlgebraic('d5'));
    expect(s1).not.toBe(s0);
    const { byWhite, byBlack } = capturedPieces(s1);
    expect(byWhite).toEqual([B_PAWN]);
    expect(byBlack).toEqual([]);
  });

  it('吃过路兵：白兵 e5×d6 → 黑兵进白方托盘；悔棋一步后两个托盘均回空', () => {
    // 黑先 d7-d5（两格），下一手白兵 e5 过路吃 d6
    const s0 = position(
      [
        ['e1', 'K'],
        ['c8', 'k'],
        ['e5', 'P'],
        ['d7', 'p'],
      ],
      { current: 2 },
    );
    const s1 = makeMove(s0, fromAlgebraic('d7'), fromAlgebraic('d5'));
    const s2 = makeMove(s1, fromAlgebraic('e5'), fromAlgebraic('d6'));
    expect(capturedPieces(s2)).toEqual({ byWhite: [B_PAWN], byBlack: [] });
    // 悔棋：弹出过路吃那一手，托盘实时回退
    expect(capturedPieces(undo(s2))).toEqual({ byWhite: [], byBlack: [] });
  });

  it('多手混合吃子：归属与被吃顺序正确（1.e4 d5 2.exd5 Qxd5 3.Nc3 Qxg2）', () => {
    const plies: Array<[string, string]> = [
      ['e2', 'e4'],
      ['d7', 'd5'],
      ['e4', 'd5'],
      ['d8', 'd5'],
      ['b1', 'c3'],
      ['d5', 'g2'],
    ];
    let s = initialState();
    for (const [from, to] of plies) {
      const next = makeMove(s, fromAlgebraic(from), fromAlgebraic(to));
      expect(next).not.toBe(s); // 每步都必须合法（顺带守卫测试序列本身）
      s = next;
    }
    const { byWhite, byBlack } = capturedPieces(s);
    expect(byWhite).toEqual([B_PAWN]); // 白吃：d5 黑兵
    expect(byBlack).toEqual([W_PAWN, W_PAWN]); // 黑吃（按顺序）：d5 白兵、g2 白兵
  });

  it('升变不是吃子：白兵 g7-g8=后 后两个托盘均为空', () => {
    const s0 = position(
      [
        ['e1', 'K'],
        ['a8', 'k'],
        ['g7', 'P'],
      ],
      { current: 1 },
    );
    const s1 = makeMove(s0, fromAlgebraic('g7'), fromAlgebraic('g8'), 'q');
    expect(s1).not.toBe(s0);
    expect(capturedPieces(s1)).toEqual({ byWhite: [], byBlack: [] });
  });

  it('初始局面：两个托盘均为空', () => {
    expect(capturedPieces(initialState())).toEqual({ byWhite: [], byBlack: [] });
  });
});

describe('trayGroups（托盘分组：价值降序 + 同型 ×N）', () => {
  it('乱序被吃列表按 后 > 车 > 象 > 马 > 兵 排列，同型合并计数', () => {
    const groups = trayGroups([B_PAWN, B_QUEEN, B_ROOK, B_QUEEN, B_KNIGHT, B_BISHOP]);
    expect(groups).toEqual([
      { piece: B_QUEEN, count: 2 },
      { piece: B_ROOK, count: 1 },
      { piece: B_BISHOP, count: 1 },
      { piece: B_KNIGHT, count: 1 },
      { piece: B_PAWN, count: 1 },
    ]);
  });

  it('空列表 → 空分组', () => {
    expect(trayGroups([])).toEqual([]);
  });
});
