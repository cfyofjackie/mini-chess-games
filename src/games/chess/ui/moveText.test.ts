// A5 上一手文案：纯函数 moveText / lastMoveInfo 的单元测试（规格书第七节）。
// 覆盖：非吃子 / 吃子 / 升变（含升变子名）/ 吃过路兵 / 易位显示 / 初始局面无一手。
import { describe, expect, it } from 'vitest';
import {
  B_KNIGHT,
  B_PAWN,
  W_KING,
  W_PAWN,
  W_QUEEN,
  fromAlgebraic,
  initialState,
  makeMove,
  position,
} from '../engine/chess';
import { lastMoveInfo, moveText } from './moveText';

describe('moveText（着法 → 中文文案）', () => {
  it('非吃子：黑兵 e7-e5', () => {
    const text = moveText(
      { from: fromAlgebraic('e7'), to: fromAlgebraic('e5'), piece: B_PAWN, capture: false },
      2,
    );
    expect(text).toBe('黑兵 e7-e5');
  });

  it('吃子：白后 d1×h5（吃子用 ×）', () => {
    const text = moveText(
      { from: fromAlgebraic('d1'), to: fromAlgebraic('h5'), piece: W_QUEEN, capture: true },
      1,
    );
    expect(text).toBe('白后 d1×h5');
  });

  it('升变：白兵 e7-e8=后（含升变子名）', () => {
    const text = moveText(
      {
        from: fromAlgebraic('e7'),
        to: fromAlgebraic('e8'),
        piece: W_PAWN,
        capture: false,
        promotion: 'q',
      },
      1,
    );
    expect(text).toBe('白兵 e7-e8=后');
  });

  it('升变兼吃子：黑兵 g2×h1=马', () => {
    const text = moveText(
      {
        from: fromAlgebraic('g2'),
        to: fromAlgebraic('h1'),
        piece: B_PAWN,
        capture: true,
        promotion: 'n',
      },
      2,
    );
    expect(text).toBe('黑兵 g2×h1=马');
  });

  it('黑马 g8-f6（棋子名覆盖：马）', () => {
    const text = moveText(
      { from: fromAlgebraic('g8'), to: fromAlgebraic('f6'), piece: B_KNIGHT, capture: false },
      2,
    );
    expect(text).toBe('黑马 g8-f6');
  });

  it('王车易位按普通王步显示：白王 e1-g1', () => {
    const text = moveText(
      { from: fromAlgebraic('e1'), to: fromAlgebraic('g1'), piece: W_KING, capture: false },
      1,
    );
    expect(text).toBe('白王 e1-g1');
  });
});

describe('lastMoveInfo（从走子后状态反推最近一手）', () => {
  it('初始局面无一手 → null', () => {
    expect(lastMoveInfo(initialState())).toBeNull();
  });

  it('普通步：开局 e2-e4 → 白兵 e2-e4，无被吃子', () => {
    const s = makeMove(initialState(), fromAlgebraic('e2'), fromAlgebraic('e4'));
    const info = lastMoveInfo(s);
    expect(info).not.toBeNull();
    expect(info!.piece).toBe(W_PAWN);
    expect(info!.capture).toBe(false);
    expect(info!.promotion).toBeUndefined();
    expect(info!.captured).toBeNull();
    expect(moveText(info!, 1)).toBe('白兵 e2-e4');
  });

  it('正常吃子：白后 d1×d5，被吃黑兵在落点格', () => {
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
    const info = lastMoveInfo(s1);
    expect(info).not.toBeNull();
    expect(info!.piece).toBe(W_QUEEN);
    expect(info!.capture).toBe(true);
    expect(info!.captured).toEqual({ idx: fromAlgebraic('d5'), piece: B_PAWN });
    expect(moveText(info!, 1)).toBe('白后 d1×d5');
  });

  it('吃过路兵：白兵 e5×d6，被吃黑兵在旁格 d5', () => {
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
    expect(s1.enPassant).toBe(fromAlgebraic('d6'));
    const s2 = makeMove(s1, fromAlgebraic('e5'), fromAlgebraic('d6'));
    const info = lastMoveInfo(s2);
    expect(info).not.toBeNull();
    expect(info!.piece).toBe(W_PAWN);
    expect(info!.capture).toBe(true);
    expect(info!.captured).toEqual({ idx: fromAlgebraic('d5'), piece: B_PAWN });
    expect(info!.promotion).toBeUndefined();
    expect(moveText(info!, 1)).toBe('白兵 e5×d6');
  });

  it('升变：白兵 g7-g8=后（升变子反查自落点棋子）', () => {
    const s0 = position(
      [
        ['e1', 'K'],
        ['a8', 'k'],
        ['g7', 'P'],
      ],
      { current: 1 },
    );
    const s1 = makeMove(s0, fromAlgebraic('g7'), fromAlgebraic('g8'), 'q');
    const info = lastMoveInfo(s1);
    expect(info).not.toBeNull();
    expect(info!.piece).toBe(W_PAWN);
    expect(info!.capture).toBe(false);
    expect(info!.promotion).toBe('q');
    expect(info!.captured).toBeNull();
    expect(moveText(info!, 1)).toBe('白兵 g7-g8=后');
  });
});
