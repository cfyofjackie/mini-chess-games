// 国际象棋引擎测试：对应 docs/games/chess.md 的测试清单（验收核心）。
// 棋子编码速查：1兵 2马 3象 4车 5后 6王 / 8兵 9马 10象 11车 12后 13王
import { describe, expect, it } from 'vitest';
import {
  algebraic,
  allLegalMoves,
  B_BISHOP,
  B_KING,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  CELLS,
  fromAlgebraic,
  initialState,
  isInsufficientMaterial,
  isInCheck,
  legalTargets,
  makeMove,
  position,
  pseudoTargets,
  undo,
  W_BISHOP,
  W_KING,
  W_KNIGHT,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  type ChessState,
  type Promotion,
} from './chess';

const S = (sq: string) => fromAlgebraic(sq);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
/** 集合相等断言（忽略顺序） */
const expectSet = (actual: number[], expected: number[]) =>
  expect(sorted(actual)).toEqual(sorted(expected));

/** 依次走子（代数坐标） */
function play(state: ChessState, ...moves: Array<[string, string]>): ChessState {
  let s = state;
  for (const [f, t] of moves) s = makeMove(s, S(f), S(t));
  return s;
}

describe('坐标与构造器', () => {
  it('代数坐标互转（a8=0，h1=63）', () => {
    expect(S('a8')).toBe(0);
    expect(S('h1')).toBe(63);
    expect(algebraic(S('e4'))).toBe('e4');
    expect(algebraic(S('a1'))).toBe('a1');
    expect(algebraic(S('h8'))).toBe('h8');
  });

  it('构造器：摆放棋子 / 行棋方 / 易位权利 / 过路兵目标格', () => {
    const s = position([['e1', 'K'], ['d5', 'p']], { current: 2, castling: 'Q', enPassant: 'd6' });
    expect(s.current).toBe(2);
    expect(s.castling).toBe('Q');
    expect(s.enPassant).toBe(S('d6'));
    expect(s.board[S('e1')]).toBe(W_KING);
    expect(s.board[S('d5')]).toBe(B_PAWN);
    expect(s.history).toHaveLength(0);
  });

  it('pseudoTargets 对空位返回空数组', () => {
    expect(pseudoTargets(initialState().board, S('e5'))).toEqual([]);
    expect(pseudoTargets(initialState().board, S('e4'))).toEqual([]);
  });
});

describe('初始局面', () => {
  it('双方各 16 子、白先、易位权利齐全、无将军', () => {
    const s = initialState();
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.check).toBe(false);
    expect(s.castling).toBe('KQkq');
    expect(s.enPassant).toBe(-1);
    expect(s.history).toHaveLength(0);
    expect(s.board[S('e1')]).toBe(W_KING);
    expect(s.board[S('e8')]).toBe(B_KING);
    expect(s.board[S('d1')]).toBe(W_QUEEN);
    expect(s.board[S('a1')]).toBe(W_ROOK);
    expect(s.board[S('h8')]).toBe(B_ROOK);
    let white = 0;
    let black = 0;
    for (let i = 0; i < CELLS; i++) {
      const p = s.board[i];
      if (p >= 1 && p <= 6) white++;
      else if (p >= 8) black++;
    }
    expect(white).toBe(16);
    expect(black).toBe(16);
  });

  it('初始局面每方 20 个合法步（走法生成整体抽查）', () => {
    const s = initialState();
    expect(allLegalMoves(s.board, 1, s.enPassant, s.castling)).toHaveLength(20);
    expect(allLegalMoves(s.board, 2, s.enPassant, s.castling)).toHaveLength(20);
    const s1 = play(s, ['e2', 'e4']);
    expect(allLegalMoves(s1.board, 2, s1.enPassant, s1.castling)).toHaveLength(20);
  });
});

describe('兵', () => {
  it('起始位置可走一格或两格；离开起始位后只能一格', () => {
    const s = initialState();
    expectSet(legalTargets(s, S('e2')), [S('e3'), S('e4')]);
    const s2 = play(s, ['e2', 'e3'], ['a7', 'a6']);
    expectSet(legalTargets(s2, S('e3')), [S('e4')]);
  });

  it('前方被挡不可前进，两格路径被挡只剩一格', () => {
    const s = position([['e2', 'P'], ['e3', 'p']]);
    expect(legalTargets(s, S('e2'))).toEqual([]);
    const s2 = position([['e2', 'P'], ['e4', 'p']]);
    expectSet(legalTargets(s2, S('e2')), [S('e3')]); // 单格仍可走，双格被挡
  });

  it('斜吃有子可吃、斜吃无子不可走、不可后退', () => {
    const s = position([['e4', 'P'], ['d5', 'p'], ['h1', 'K'], ['h8', 'k']]);
    expectSet(legalTargets(s, S('e4')), [S('d5'), S('e5')]);
    // 无子可斜吃：只剩前进
    const s2 = position([['e4', 'P'], ['h1', 'K'], ['h8', 'k']]);
    expect(legalTargets(s2, S('e4'))).toEqual([S('e5')]);
    expect(legalTargets(s2, S('e4'))).not.toContain(S('d3'));
  });

  it('黑兵方向对称：向下前进与斜吃', () => {
    const s = position([['e5', 'p'], ['d4', 'P'], ['h1', 'K'], ['h8', 'k']], { current: 2 });
    expectSet(legalTargets(s, S('e5')), [S('d4'), S('e4')]);
    const s2 = position([['e5', 'p'], ['h1', 'K'], ['h8', 'k']], { current: 2 });
    expect(legalTargets(s2, S('e5'))).toEqual([S('e4')]);
  });
});

describe('马', () => {
  it('开阔地 8 个落点', () => {
    const s = position([['d4', 'N']]);
    expect(legalTargets(s, S('d4'))).toHaveLength(8);
  });

  it('可越子（初始 b1 只能 a3/c3）；只吃对方不吃己方', () => {
    const s = initialState();
    expectSet(legalTargets(s, S('b1')), [S('a3'), S('c3')]);
    const s2 = position([['d4', 'N'], ['c6', 'p'], ['e6', 'P']]);
    const t = legalTargets(s2, S('d4'));
    expect(t).toContain(S('c6'));
    expect(t).not.toContain(S('e6'));
  });
});

describe('象', () => {
  it('斜线滑动（空盘 13 格）；遇己方子而止、可吃对方子、不可越子', () => {
    const s = position([['d4', 'B']]);
    expect(legalTargets(s, S('d4'))).toHaveLength(13);
    const s2 = position([['d4', 'B'], ['f6', 'p'], ['b2', 'P']]);
    const t = legalTargets(s2, S('d4'));
    expect(t).toContain(S('f6'));
    expect(t).toContain(S('c3'));
    expect(t).not.toContain(S('g7'));
    expect(t).not.toContain(S('b2'));
    expect(t).not.toContain(S('a1'));
  });
});

describe('车', () => {
  it('直线滑动；遇己方子而止、可吃对方子', () => {
    const s = position([['d4', 'R']]);
    expect(legalTargets(s, S('d4'))).toHaveLength(14);
    const s2 = position([['d4', 'R'], ['d2', 'P'], ['d8', 'r']]);
    expectSet(legalTargets(s2, S('d4')), [
      S('a4'), S('b4'), S('c4'), S('d3'), S('d5'), S('d6'), S('d7'), S('d8'),
      S('e4'), S('f4'), S('g4'), S('h4'),
    ]);
  });
});

describe('后', () => {
  it('直线 + 斜线（空盘 27 格）', () => {
    const s = position([['d4', 'Q']]);
    expect(legalTargets(s, S('d4'))).toHaveLength(27);
  });
});

describe('王', () => {
  it('一格八方（空盘 8 格）', () => {
    const s = position([['d4', 'K']]);
    expect(legalTargets(s, S('d4'))).toHaveLength(8);
  });

  it('不可走入受攻格（车控线）', () => {
    const s = position([['d4', 'K'], ['d8', 'r'], ['a8', 'k']]);
    expectSet(legalTargets(s, S('d4')), [
      S('c3'), S('c4'), S('c5'), S('e3'), S('e4'), S('e5'),
    ]);
  });

  it('不可与对方王相邻（走入其攻击格）', () => {
    const s = position([['d4', 'K'], ['e6', 'k']]);
    expectSet(legalTargets(s, S('d4')), [
      S('c3'), S('c4'), S('c5'), S('d3'), S('e3'), S('e4'),
    ]);
  });

  it('不可吃受保护的子', () => {
    // 黑车 e5 有黑王 e6 贴身保护
    const s = position([['d4', 'K'], ['e5', 'r'], ['e6', 'k']]);
    const t = legalTargets(s, S('d4'));
    expect(t).not.toContain(S('e5'));
    expectSet(t, [S('c3'), S('c4'), S('d3')]);
  });
});

describe('王车易位', () => {
  it('白方短易位正例：王到 g1、车到 f1、收 K 权', () => {
    const s = play(
      initialState(),
      ['e2', 'e4'], ['e7', 'e5'],
      ['g1', 'f3'], ['b8', 'c6'],
      ['f1', 'c4'], ['f8', 'c5'],
    );
    expect(s.castling).toBe('KQkq');
    const done = play(s, ['e1', 'g1']);
    expect(done.status).toBe('playing');
    expect(done.board[S('g1')]).toBe(W_KING);
    expect(done.board[S('f1')]).toBe(W_ROOK);
    expect(done.board[S('e1')]).toBe(0);
    expect(done.board[S('h1')]).toBe(0);
    expect(done.castling).toBe('kq'); // 王已移动，白方双侧权利均失
    expect(done.current).toBe(2);
  });

  it('白方长易位正例：王到 c1、车到 d1、收 Q 权', () => {
    const s = play(
      initialState(),
      ['d2', 'd4'], ['d7', 'd5'],
      ['c1', 'f4'], ['g8', 'f6'],
      ['b1', 'c3'], ['b8', 'c6'],
      ['d1', 'd2'], ['e7', 'e6'],
    );
    const done = play(s, ['e1', 'c1']);
    expect(done.board[S('c1')]).toBe(W_KING);
    expect(done.board[S('d1')]).toBe(W_ROOK);
    expect(done.board[S('a1')]).toBe(0);
    expect(done.board[S('e1')]).toBe(0);
    expect(done.castling).toBe('kq'); // 王已移动，白方双侧权利均失
  });

  it('黑方短易位正例（构造局面）', () => {
    const s = position([['e8', 'k'], ['h8', 'r'], ['a8', 'r'], ['e1', 'K']], {
      current: 2,
      castling: 'kq',
    });
    const done = play(s, ['e8', 'g8']);
    expect(done.board[S('g8')]).toBe(B_KING);
    expect(done.board[S('f8')]).toBe(B_ROOK);
    expect(done.board[S('e8')]).toBe(0);
    expect(done.board[S('h8')]).toBe(0);
    expect(done.castling).toBe('');
    expect(done.current).toBe(1);
  });

  it('黑方长易位正例（构造局面）', () => {
    const s = position([['e8', 'k'], ['h8', 'r'], ['a8', 'r'], ['e1', 'K']], {
      current: 2,
      castling: 'kq',
    });
    const done = play(s, ['e8', 'c8']);
    expect(done.board[S('c8')]).toBe(B_KING);
    expect(done.board[S('d8')]).toBe(B_ROOK);
    expect(done.board[S('a8')]).toBe(0);
  });

  it('反例：王移动过再回位，权利已失不可易位', () => {
    const s = position(
      [['e1', 'K'], ['a1', 'R'], ['h1', 'R'], ['e8', 'k'], ['a8', 'r'], ['h8', 'r'], ['a7', 'p']],
    );
    const s1 = play(s, ['e1', 'e2'], ['a7', 'a6'], ['e2', 'e1'], ['a6', 'a5']);
    expect(s1.castling).toBe('kq'); // 白方双侧权利已失
    expect(s1.current).toBe(1);
    expect(legalTargets(s1, S('e1'))).not.toContain(S('g1'));
    expect(legalTargets(s1, S('e1'))).not.toContain(S('c1'));
  });

  it('反例：车移动过（即使回位）单侧权利即失', () => {
    const s = position(
      [['e1', 'K'], ['a1', 'R'], ['h1', 'R'], ['e8', 'k'], ['a8', 'r'], ['h8', 'r'], ['a7', 'p']],
    );
    const s1 = play(s, ['h1', 'h2'], ['a7', 'a6'], ['h2', 'h1'], ['a6', 'a5']);
    expect(s1.castling).toBe('Qkq');
    expect(s1.current).toBe(1);
    expect(legalTargets(s1, S('e1'))).not.toContain(S('g1'));
    expect(legalTargets(s1, S('e1'))).toContain(S('c1'));
  });

  it('反例：路径有子不可易位（f1 / b1 / d1 分别被挡）', () => {
    const s = position([['e1', 'K'], ['h1', 'R'], ['f1', 'B'], ['e8', 'k']]);
    expect(legalTargets(s, S('e1'))).not.toContain(S('g1'));
    const s2 = position([['e1', 'K'], ['a1', 'R'], ['b1', 'N'], ['e8', 'k']]);
    expect(legalTargets(s2, S('e1'))).not.toContain(S('c1'));
    const s3 = position([['e1', 'K'], ['a1', 'R'], ['d1', 'Q'], ['e8', 'k']]);
    expect(legalTargets(s3, S('e1'))).not.toContain(S('c1'));
  });

  it('反例：王正被将军时不可易位', () => {
    const s = position([['e1', 'K'], ['h1', 'R'], ['e8', 'r'], ['h8', 'k']]);
    expect(isInCheck(s.board, 1)).toBe(true);
    const t = legalTargets(s, S('e1'));
    expect(t).not.toContain(S('g1'));
    expect(t).toContain(S('f1')); // 常规出将仍可（f1 不在线上）
    expect(t).toContain(S('d1'));
  });

  it('反例：经过格受攻不可易位（f1 受攻 → 短易位；d1 受攻 → 长易位）', () => {
    const s = position([['e1', 'K'], ['h1', 'R'], ['f8', 'r'], ['h8', 'k']]);
    const t = legalTargets(s, S('e1'));
    expect(t).not.toContain(S('g1'));
    expect(t).not.toContain(S('f1'));
    expect(t).toContain(S('e2'));
    const s2 = position([['e1', 'K'], ['a1', 'R'], ['d8', 'r'], ['h8', 'k']]);
    const t2 = legalTargets(s2, S('e1'));
    expect(t2).not.toContain(S('c1'));
    expect(t2).not.toContain(S('d1'));
    expect(t2).toContain(S('e2'));
  });

  it('反例：目的地受攻不可易位（g1 / c1 受攻）', () => {
    const s = position([['e1', 'K'], ['h1', 'R'], ['g8', 'r'], ['a8', 'k']]);
    const t = legalTargets(s, S('e1'));
    expect(t).not.toContain(S('g1'));
    expect(t).toContain(S('f1')); // 经过格未受攻，但目的地受攻仍不可易位
    const s2 = position([['e1', 'K'], ['a1', 'R'], ['c8', 'r'], ['h8', 'k']]);
    const t2 = legalTargets(s2, S('e1'));
    expect(t2).not.toContain(S('c1'));
    expect(t2).toContain(S('d1'));
  });

  it('长易位时 b1 受攻仍可易位（b1 仅须无子，不必不受攻）', () => {
    // 先证明 b8 车对 b 线无遮挡（可直下吃 b2 兵）
    const probe = position([['b8', 'r'], ['b2', 'P'], ['e1', 'K'], ['e8', 'k']], { current: 2 });
    expect(makeMove(probe, S('b8'), S('b2')).board[S('b2')]).toBe(B_ROOK);
    const s = position([['e1', 'K'], ['a1', 'R'], ['b8', 'r'], ['h8', 'k']]);
    expect(legalTargets(s, S('e1'))).toContain(S('c1'));
  });

  it('车在原位被吃 → 对应易位权即失', () => {
    const s = position([['e1', 'K'], ['a1', 'R'], ['h1', 'R'], ['e8', 'k'], ['d5', 'b']], {
      current: 2,
    });
    const s1 = play(s, ['d5', 'h1']);
    expect(s1.board[S('h1')]).toBe(B_BISHOP);
    expect(s1.castling).toBe('Qkq');
    expect(legalTargets(s1, S('e1'))).not.toContain(S('g1'));
  });
});

describe('吃过路兵', () => {
  it('正例：白兵吃过路兵，被吃兵从原格移除', () => {
    const s = play(initialState(), ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
    expect(s.enPassant).toBe(S('d6'));
    expect(legalTargets(s, S('e5'))).toContain(S('d6'));
    const done = play(s, ['e5', 'd6']);
    expect(done.board[S('d6')]).toBe(W_PAWN);
    expect(done.board[S('d5')]).toBe(0);
    expect(done.board[S('e5')]).toBe(0);
  });

  it('正例：黑兵吃过路兵', () => {
    const s = play(
      initialState(),
      ['e2', 'e4'], ['f7', 'f5'],
      ['e4', 'e5'], ['f5', 'f4'],
      ['g2', 'g4'],
    );
    expect(s.enPassant).toBe(S('g3'));
    const done = play(s, ['f4', 'g3']);
    expect(done.board[S('g3')]).toBe(B_PAWN);
    expect(done.board[S('g4')]).toBe(0);
    expect(done.board[S('f4')]).toBe(0);
  });

  it('机会窗口过期：间隔一手后过路兵目标格清空，不可再吃', () => {
    const s = play(initialState(), ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
    expect(s.enPassant).toBe(S('d6'));
    const s2 = play(s, ['g1', 'f3']); // 白方未抓住机会
    expect(s2.enPassant).toBe(-1);
    const s3 = play(s2, ['e7', 'e6']);
    expect(s3.enPassant).toBe(-1);
  });

  it('吃过路兵后若己王暴露于横线攻击则非法（横线闪击）', () => {
    const s = position(
      [['h5', 'K'], ['e5', 'P'], ['a5', 'r'], ['d5', 'p'], ['h8', 'k']],
      { current: 1, enPassant: 'd6' },
    );
    expect(legalTargets(s, S('e5'))).not.toContain(S('d6'));
    expect(makeMove(s, S('e5'), S('d6'))).toBe(s);
    expect(legalTargets(s, S('e5'))).toEqual([S('e6')]); // 前进不受影响
  });

  it('只有兵能吃过路兵：其他子到达目标格不移除被吃兵', () => {
    const s = position([['e5', 'Q'], ['d5', 'p'], ['h1', 'K'], ['h8', 'k']], {
      current: 1,
      enPassant: 'd6',
    });
    const done = play(s, ['e5', 'd6']); // 后至 d6 是普通走法
    expect(done.board[S('d6')]).toBe(W_QUEEN);
    expect(done.board[S('d5')]).toBe(B_PAWN);
  });
});

describe('升变自选', () => {
  it('升变步落点照常出现在合法落点中（UI 落点高亮依据）', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    expectSet(legalTargets(s, S('e7')), [S('e8')]);
    // 吃子升变同样显示（长腿斜吃抵达底线）：d7 前进 d8、斜吃 c8
    const cap = position([['d7', 'P'], ['c8', 'r'], ['h1', 'K'], ['a5', 'k']]);
    expectSet(legalTargets(cap, S('d7')), [S('c8'), S('d8')]);
  });

  it('升变为后：升变后按后的走法行动', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    const s1 = makeMove(s, S('e7'), S('e8'), 'q');
    expect(s1.board[S('e8')]).toBe(W_QUEEN);
    expect(s1.board[S('e7')]).toBe(0);
    expect(s1.status).toBe('playing');
    const s2 = play(s1, ['a5', 'a6'], ['e8', 'h5']); // 黑让一手后，后斜线机动
    expect(s2.board[S('h5')]).toBe(W_QUEEN);
    expect(s2.board[S('e8')]).toBe(0);
  });

  it('升变为车：直线机动，不能斜走', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    const s1 = makeMove(s, S('e7'), S('e8'), 'r');
    expect(s1.board[S('e8')]).toBe(W_ROOK);
    const s2 = play(s1, ['a5', 'a6'], ['e8', 'e1']);
    expect(s2.board[S('e1')]).toBe(W_ROOK);
    expect(makeMove(s2, S('e1'), S('h4'))).toBe(s2); // 车不可斜走（e1-h4 为斜线）
  });

  it('升变为象：斜线机动，不能直走', () => {
    // 黑方多一枚兵，避免 K+B vs K 直接触发子力不足判和而无法续走
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k'], ['a7', 'p']]);
    const s1 = makeMove(s, S('e7'), S('e8'), 'b');
    expect(s1.board[S('e8')]).toBe(W_BISHOP);
    expect(s1.status).toBe('playing');
    const s2 = play(s1, ['a5', 'a6'], ['e8', 'h5']);
    expect(s2.board[S('h5')]).toBe(W_BISHOP);
    expect(makeMove(s2, S('h5'), S('h7'))).toBe(s2); // 象不可直走
  });

  it('升变为马：日字机动，不能滑行', () => {
    // 黑方多一枚兵，避免 K+N vs K 直接触发子力不足判和而无法续走
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k'], ['a7', 'p']]);
    const s1 = makeMove(s, S('e7'), S('e8'), 'n');
    expect(s1.board[S('e8')]).toBe(W_KNIGHT);
    expect(s1.status).toBe('playing');
    const s2 = play(s1, ['a5', 'a6'], ['e8', 'f6']);
    expect(s2.board[S('f6')]).toBe(W_KNIGHT);
    expect(makeMove(s2, S('f6'), S('f4'))).toBe(s2); // 马不可滑行
  });

  it('升变可通过吃子完成（吃底角车），须显式传升变子', () => {
    const s = position([['d7', 'P'], ['c8', 'r'], ['h1', 'K'], ['a5', 'k']]);
    expect(makeMove(s, S('d7'), S('c8'))).toBe(s); // 吃子升变同样必须显式传参
    const done = makeMove(s, S('d7'), S('c8'), 'q');
    expect(done.board[S('c8')]).toBe(W_QUEEN);
    expect(done.board[S('d7')]).toBe(0);
    expect(done.status).toBe('playing');
  });

  it('黑兵升变须显式传参（自动变后已移除）', () => {
    const s = position([['d2', 'p'], ['h1', 'K'], ['a8', 'k']], { current: 2 });
    expect(makeMove(s, S('d2'), S('d1'))).toBe(s); // 未传 → 拒绝，棋盘保持原样
    expect(s.board[S('d2')]).toBe(B_PAWN); // 兵未动
    const done = makeMove(s, S('d2'), S('d1'), 'q');
    expect(done.board[S('d1')]).toBe(B_QUEEN);
  });

  it('升变步未传升变参数 → 拒绝（同引用返回）', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    expect(makeMove(s, S('e7'), S('e8'))).toBe(s);
    expect(s.board[S('e7')]).toBe(W_PAWN);
    expect(s.board[S('e8')]).toBe(0);
  });

  it('升变参数非法值 → 拒绝（王/兵/大写/未知值/null 均不合法）', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    const bad = (v: unknown) => v as unknown as Promotion;
    expect(makeMove(s, S('e7'), S('e8'), bad('k'))).toBe(s); // 王不可选
    expect(makeMove(s, S('e7'), S('e8'), bad('p'))).toBe(s); // 兵不可选
    expect(makeMove(s, S('e7'), S('e8'), bad('Q'))).toBe(s); // 大写非法（区分大小写）
    expect(makeMove(s, S('e7'), S('e8'), bad('x'))).toBe(s); // 未知值
    expect(makeMove(s, S('e7'), S('e8'), bad(''))).toBe(s);
    expect(makeMove(s, S('e7'), S('e8'), bad(null))).toBe(s);
  });

  it('非升变步传入升变参数被忽略', () => {
    const s = position([['e4', 'P'], ['h1', 'K'], ['a5', 'k']]);
    const done = makeMove(s, S('e4'), S('e5'), 'q');
    expect(done.board[S('e5')]).toBe(W_PAWN);
  });

  it('升变后悔棋：复原为升变前的兵', () => {
    const s = position([['e7', 'P'], ['h1', 'K'], ['a5', 'k']]);
    const s1 = makeMove(s, S('e7'), S('e8'), 'n');
    expect(undo(s1)).toBe(s);
    expect(s.board[S('e7')]).toBe(W_PAWN);
  });
});

describe('将军与应将', () => {
  it('isInCheck 正反例：车同线无遮挡被将，有遮挡不被将', () => {
    const open = position([['e1', 'K'], ['e8', 'r'], ['h8', 'k']]);
    expect(isInCheck(open.board, 1)).toBe(true);
    const blocked = position([['e1', 'K'], ['e8', 'r'], ['e4', 'P'], ['h8', 'k']]);
    expect(isInCheck(blocked.board, 1)).toBe(false);
  });

  it('被将军时只保留应将步：王不能留在车控线上，且无其他解将子', () => {
    const s = position([['a1', 'K'], ['e1', 'R'], ['e8', 'k']], { current: 2 });
    expect(isInCheck(s.board, 2)).toBe(true);
    expectSet(legalTargets(s, S('e8')), [S('d7'), S('d8'), S('f7'), S('f8')]);
    expect(allLegalMoves(s.board, 2, s.enPassant, s.castling)).toHaveLength(4);
  });
});

describe('将死（学者将杀）', () => {
  it('四步 Qxf7# 判定终局：将死、白胜、无合法步', () => {
    const s = play(
      initialState(),
      ['e2', 'e4'], ['e7', 'e5'],
      ['f1', 'c4'], ['b8', 'c6'],
      ['d1', 'h5'], ['g8', 'f6'],
    );
    expect(s.status).toBe('playing');
    expect(s.check).toBe(false); // 轮到白方，白未被将军
    const mate = play(s, ['h5', 'f7']);
    expect(mate.status).toBe('won');
    expect(mate.winner).toBe(1);
    expect(mate.reason).toBe('checkmate');
    expect(mate.check).toBe(true);
    expect(mate.board[S('f7')]).toBe(W_QUEEN);
    expect(allLegalMoves(mate.board, 2, mate.enPassant, mate.castling)).toHaveLength(0);
    // 终局后拒绝继续走子
    expect(makeMove(mate, S('d8'), S('e7'))).toBe(mate);
  });
});

describe('逼和', () => {
  it('典型僵局：白 Kb6+Qc7，黑 Ka8 无子可动且未被将军', () => {
    const s = position([['b6', 'K'], ['c7', 'Q'], ['a8', 'k']], { current: 2 });
    expect(s.check).toBe(false);
    expect(allLegalMoves(s.board, 2, s.enPassant, s.castling)).toHaveLength(0);
  });

  it('通过走子形成逼和：Qd7-c7 后判和', () => {
    const s = position([['b6', 'K'], ['d7', 'Q'], ['a8', 'k']]);
    const done = play(s, ['d7', 'c7']);
    expect(done.status).toBe('draw');
    expect(done.winner).toBe(0);
    expect(done.reason).toBe('stalemate');
    expect(done.check).toBe(false);
  });
});

describe('子力不足判和', () => {
  it('isInsufficientMaterial：三组合正例与保持战斗力的反例', () => {
    expect(isInsufficientMaterial(position([['e1', 'K'], ['e8', 'k']]).board)).toBe(true);
    expect(isInsufficientMaterial(position([['e1', 'K'], ['c4', 'B'], ['e8', 'k']]).board)).toBe(true);
    expect(isInsufficientMaterial(position([['e1', 'K'], ['c4', 'N'], ['e8', 'k']]).board)).toBe(true);
    // K+B vs K+B 同色象（f1 与 c4 均为浅格）
    expect(
      isInsufficientMaterial(position([['g1', 'K'], ['f1', 'B'], ['g8', 'k'], ['c4', 'b']]).board),
    ).toBe(true);
    // 反例：异色象 / 双马 / 象马 / 存在兵 / 同侧双象
    expect(
      isInsufficientMaterial(position([['g1', 'K'], ['f1', 'B'], ['g8', 'k'], ['g7', 'b']]).board),
    ).toBe(false);
    expect(
      isInsufficientMaterial(position([['e1', 'K'], ['c4', 'N'], ['e8', 'k'], ['f5', 'n']]).board),
    ).toBe(false);
    expect(
      isInsufficientMaterial(position([['e1', 'K'], ['c4', 'B'], ['e8', 'k'], ['f5', 'n']]).board),
    ).toBe(false);
    expect(isInsufficientMaterial(position([['e1', 'K'], ['e2', 'P'], ['e8', 'k']]).board)).toBe(false);
    expect(
      isInsufficientMaterial(position([['e1', 'K'], ['c4', 'B'], ['f1', 'B'], ['e8', 'k']]).board),
    ).toBe(false);
  });

  it('走子触发：K vs K、K+B vs K 立即判和', () => {
    const done = play(position([['e1', 'K'], ['e8', 'k']]), ['e1', 'e2']);
    expect(done.status).toBe('draw');
    expect(done.reason).toBe('insufficient');
    expect(done.winner).toBe(0);
    const done2 = play(position([['e1', 'K'], ['c4', 'B'], ['e8', 'k']]), ['e1', 'e2']);
    expect(done2.status).toBe('draw');
    expect(done2.reason).toBe('insufficient');
  });

  it('走子触发：同色象 K+B vs K+B 判和，异色象不判', () => {
    const done = play(position([['g1', 'K'], ['f1', 'B'], ['g8', 'k'], ['c4', 'b']]), ['g1', 'h1']);
    expect(done.status).toBe('draw');
    expect(done.reason).toBe('insufficient');
    const done2 = play(position([['g1', 'K'], ['f1', 'B'], ['g8', 'k'], ['g7', 'b']]), ['g1', 'h1']);
    expect(done2.status).toBe('playing');
  });
});

describe('非法走子拒绝', () => {
  it('各类非法走子原样返回同一状态', () => {
    const s = initialState();
    expect(makeMove(s, S('e4'), S('e6'))).toBe(s); // 空起点
    expect(makeMove(s, S('e7'), S('e5'))).toBe(s); // 轮到白方走黑子
    expect(makeMove(s, S('e2'), S('d3'))).toBe(s); // 兵斜走无子
    expect(makeMove(s, S('a1'), S('a3'))).toBe(s); // 车越兵
    expect(makeMove(s, S('d1'), S('d2'))).toBe(s); // 吃己方子
    expect(makeMove(s, S('e2'), S('e2'))).toBe(s); // from === to
    expect(makeMove(s, S('e2'), S('e5'))).toBe(s); // 兵走三格
    expect(makeMove(s, -1, S('e4'))).toBe(s); // 起点越界
    expect(makeMove(s, S('e2'), CELLS)).toBe(s); // 终点越界
  });

  it('走后己王送将（牵制子移动 / 王入攻格）被拒绝', () => {
    const s = position([['e1', 'K'], ['e4', 'N'], ['e8', 'r'], ['a8', 'k']]);
    // e4 马被 e8 车牵制：任何马步都暴露 e 线
    expect(legalTargets(s, S('e4'))).toEqual([]);
    expect(makeMove(s, S('e4'), S('d6'))).toBe(s);
    expect(makeMove(s, S('e4'), S('g5'))).toBe(s);
    // 马仍在 e4 挡线时，王可沿同线退到 e2（马继续遮挡）；离开 e 线的格也可走
    expectSet(legalTargets(s, S('e1')), [S('d1'), S('d2'), S('e2'), S('f1'), S('f2')]);
    const s2 = position([['d4', 'K'], ['d8', 'r'], ['a8', 'k']]);
    expect(makeMove(s2, S('d4'), S('d5'))).toBe(s2);
  });
});

describe('悔棋（快照数组）', () => {
  it('逐手撤销恢复到历史快照（同引用），空历史为空操作', () => {
    const s0 = initialState();
    const s1 = play(s0, ['e2', 'e4']);
    const s2 = play(s1, ['e7', 'e5']);
    const s3 = play(s2, ['g1', 'f3']);
    expect(s3.history).toHaveLength(3);
    expect(undo(s3)).toBe(s2);
    expect(undo(undo(s3))).toBe(s1);
    expect(undo(undo(undo(s3)))).toBe(s0);
    expect(undo(s0)).toBe(s0);
    // 快照内容正确：过路兵目标格与轮次随局面恢复
    expect(s1.current).toBe(2);
    expect(s1.enPassant).toBe(S('e3'));
    expect(s2.enPassant).toBe(S('e6'));
    expect(s3.enPassant).toBe(-1);
    expect(s1.board[S('e4')]).toBe(W_PAWN);
    expect(s1.board[S('e2')]).toBe(0);
  });

  it('易位后悔棋：权利与王车位置一并复原', () => {
    const s = play(
      initialState(),
      ['e2', 'e4'], ['e7', 'e5'],
      ['g1', 'f3'], ['b8', 'c6'],
      ['f1', 'c4'], ['f8', 'c5'],
    );
    const castled = play(s, ['e1', 'g1']);
    expect(castled.castling).toBe('kq'); // 易位后王已动，白方双侧权利均失
    const back = undo(castled);
    expect(back).toBe(s);
    expect(back.castling).toBe('KQkq');
    expect(back.board[S('e1')]).toBe(W_KING);
    expect(back.board[S('h1')]).toBe(W_ROOK);
    expect(back.board[S('g1')]).toBe(0);
    expect(back.board[S('f1')]).toBe(0);
  });

  it('将死局悔棋：复原被吃子与行棋方，并可重走同一终局', () => {
    const pre = play(
      initialState(),
      ['e2', 'e4'], ['e7', 'e5'],
      ['f1', 'c4'], ['b8', 'c6'],
      ['d1', 'h5'], ['g8', 'f6'],
    );
    const mate = play(pre, ['h5', 'f7']);
    expect(mate.status).toBe('won');
    const back = undo(mate);
    expect(back).toBe(pre);
    expect(back.status).toBe('playing');
    expect(back.current).toBe(1);
    expect(back.board[S('f7')]).toBe(B_PAWN);
    expect(back.board[S('h5')]).toBe(W_QUEEN);
    const again = play(back, ['h5', 'f7']);
    expect(again.status).toBe('won');
    expect(again.reason).toBe('checkmate');
  });

  it('吃过路兵后悔棋：被吃兵复原、过路兵窗口恢复', () => {
    const s = play(initialState(), ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
    const captured = play(s, ['e5', 'd6']);
    expect(captured.board[S('d5')]).toBe(0);
    const back = undo(captured);
    expect(back).toBe(s);
    expect(back.board[S('d5')]).toBe(B_PAWN);
    expect(back.enPassant).toBe(S('d6'));
  });
});
