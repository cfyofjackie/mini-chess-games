// 中国象棋引擎测试：对应 docs/games/xiangqi.md 的测试清单（验收核心）。
// 棋子编码速查：1帅 2仕 3相 4马 5车 6炮 7兵 / 8将 9士 10象 11马 12车 13炮 14卒
import { describe, expect, it } from 'vitest';
import {
  allLegalMoves,
  B_A,
  B_B,
  B_C,
  B_K,
  B_N,
  B_P,
  B_R,
  CELLS,
  COLS,
  initialState,
  isInCheck,
  legalTargets,
  place,
  pseudoTargets,
  R_A,
  R_B,
  R_C,
  R_K,
  R_N,
  R_P,
  R_R,
  undo,
  type Player,
  type XiangqiState,
} from './xiangqi';

const at = (r: number, c: number) => r * COLS + c;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** 构造任意测试局面（默认红先行） */
function mk(pieces: Array<[number, number, number]>, current: Player = 1): XiangqiState {
  const board = new Int8Array(CELLS);
  for (const [r, c, p] of pieces) board[at(r, c)] = p;
  return {
    board,
    history: [],
    current,
    status: 'playing',
    winner: 0,
    reason: '',
    check: false,
    lastFrom: -1,
    lastTo: -1,
  };
}

describe('棋盘与初始局面', () => {
  it('初始局面：红先、红在下黑在上、双方各 16 子', () => {
    const s = initialState();
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.check).toBe(false);
    expect(s.history).toHaveLength(0);
    expect(s.board[at(0, 4)]).toBe(B_K);
    expect(s.board[at(9, 4)]).toBe(R_K);
    expect(s.board[at(0, 0)]).toBe(B_R);
    expect(s.board[at(9, 8)]).toBe(R_R);
    expect(s.board[at(2, 1)]).toBe(B_C);
    expect(s.board[at(7, 7)]).toBe(R_C);
    expect(s.board[at(3, 4)]).toBe(B_P);
    expect(s.board[at(6, 4)]).toBe(R_P);
    let red = 0;
    let black = 0;
    for (let i = 0; i < CELLS; i++) {
      const p = s.board[i];
      if (p >= 1 && p <= 7) red++;
      else if (p >= 8) black++;
    }
    expect(red).toBe(16);
    expect(black).toBe(16);
  });

  it('初始局面双方合法步均为经典的 44 步（走法生成整体抽查）', () => {
    const s = initialState();
    expect(allLegalMoves(s.board, 1)).toHaveLength(44);
    expect(allLegalMoves(s.board, 2)).toHaveLength(44);
  });
});

describe('帅 / 将', () => {
  it('九宫内直行一格（正例）', () => {
    const s = mk([[9, 4, R_K]]);
    expect(sorted(legalTargets(s, at(9, 4)))).toEqual([at(8, 4), at(9, 3), at(9, 5)]);
  });

  it('不能走出九宫，也不能斜走（反例）', () => {
    const b = mk([[0, 3, B_K]], 2);
    // 仅 (0,4) 与 (1,3)；(0,2) 出宫、(1,4) 为斜格
    expect(sorted(legalTargets(b, at(0, 3)))).toEqual([at(0, 4), at(1, 3)]);
  });

  it('宫顶不能再向前出宫', () => {
    const s = mk([[7, 4, R_K]]);
    expect(legalTargets(s, at(7, 4))).not.toContain(at(6, 4));
  });
});

describe('仕 / 士', () => {
  it('九宫内斜一格（正例），不能直行、不能出宫（反例）', () => {
    const s = mk([[9, 3, R_A]]);
    expect(sorted(legalTargets(s, at(9, 3)))).toEqual([at(8, 4)]);
    const b = mk([[0, 3, B_A]], 2);
    expect(sorted(legalTargets(b, at(0, 3)))).toEqual([at(1, 4)]);
  });
});

describe('相 / 象', () => {
  it('田字斜走两格（正例）', () => {
    const s = mk([[9, 2, R_B]]);
    expect(sorted(legalTargets(s, at(9, 2)))).toEqual([at(7, 0), at(7, 4)]);
    const b = mk([[2, 2, B_B]], 2);
    expect(sorted(legalTargets(b, at(2, 2)))).toEqual([at(0, 0), at(0, 4), at(4, 0), at(4, 4)]);
  });

  it('塞象眼：田字中心有子不可走该方向（正例+反例）', () => {
    const s = mk([
      [9, 2, R_B],
      [8, 1, R_P], // 堵住去 (7,0) 的象眼 (8,1)
    ]);
    const t = legalTargets(s, at(9, 2));
    expect(t).not.toContain(at(7, 0));
    expect(t).toContain(at(7, 4)); // 另一方向象眼 (8,3) 为空
  });

  it('不可过河（反例）', () => {
    const s = mk([[5, 4, R_B]]); // 红相在河沿，(3,*) 均为过河点
    expect(sorted(legalTargets(s, at(5, 4)))).toEqual([at(7, 2), at(7, 6)]);
    const b = mk([[4, 4, B_B]], 2);
    expect(sorted(legalTargets(b, at(4, 4)))).toEqual([at(2, 2), at(2, 6)]);
  });
});

describe('马', () => {
  it('日字八向（空盘正例）', () => {
    const s = mk([[4, 4, R_N]]);
    expect(sorted(legalTargets(s, at(4, 4)))).toEqual([
      at(2, 3),
      at(2, 5),
      at(3, 2),
      at(3, 6),
      at(5, 2),
      at(5, 6),
      at(6, 3),
      at(6, 5),
    ]);
  });

  it('蹩马腿：先直后斜那一格有子不可走该方向（正例+反例）', () => {
    // (8,1) 有子：向 (7,0)/(7,2) 的两个方向被蹩，只剩 (8,3)
    const s = mk([
      [9, 1, R_N],
      [8, 1, R_P],
    ]);
    expect(sorted(legalTargets(s, at(9, 1)))).toEqual([at(8, 3)]);
    // 再蹩 (9,2)（去 (8,3) 的马腿）→ 无处可走
    const s2 = mk([
      [9, 1, R_N],
      [8, 1, R_P],
      [9, 2, R_P],
    ]);
    expect(legalTargets(s2, at(9, 1))).toEqual([]);
  });
});

describe('车', () => {
  it('直线任意距离，遇子而止（初始局面正例）', () => {
    const s = initialState();
    // 纵向到 (7,0) 为止（(6,0) 有己方兵），横向被 (9,1) 马挡住
    expect(sorted(legalTargets(s, at(9, 0)))).toEqual([at(7, 0), at(8, 0)]);
  });

  it('空盘横竖全开放（17 个落点）', () => {
    const s = mk([[5, 4, R_R]]);
    expect(legalTargets(s, at(5, 4))).toHaveLength(17);
  });

  it('不可越子：己方不可吃、越子不可及，对方可吃且止于对方（反例）', () => {
    const s = mk([
      [5, 4, R_R],
      [5, 2, R_P],
      [5, 6, B_P],
    ]);
    const t = legalTargets(s, at(5, 4));
    expect(t).toContain(at(5, 3));
    expect(t).toContain(at(5, 5));
    expect(t).toContain(at(5, 6)); // 吃卒
    expect(t).not.toContain(at(5, 2)); // 己方子不可吃
    expect(t).not.toContain(at(5, 1)); // 不可越过己方兵
    expect(t).not.toContain(at(5, 7)); // 不可越过被吃的卒
  });
});

describe('炮', () => {
  it('无炮架时平移同车但不能吃（正例+反例）', () => {
    const s = mk([
      [7, 1, R_C],
      [5, 1, B_P],
    ]);
    const t = legalTargets(s, at(7, 1));
    expect(t).toContain(at(6, 1)); // 平移
    expect(t).not.toContain(at(5, 1)); // 无炮架不可吃
    expect(t).not.toContain(at(4, 1)); // 更不可越子
  });

  it('隔恰好一个炮架才能吃（正例：初始炮打马）', () => {
    const s = initialState();
    const t = legalTargets(s, at(7, 1));
    expect(t).toContain(at(0, 1)); // 隔黑炮(2,1)炮架吃黑马(0,1)
    expect(t).not.toContain(at(2, 1)); // 炮架本身不可吃
    expect(t).toContain(at(3, 1)); // 炮架前的空点可平移
    expect(t).toContain(at(4, 1));
  });

  it('隔恰好一个炮架：两个隔子之后不可再吃，炮架后不可平移（反例）', () => {
    const s = mk([
      [7, 1, R_C],
      [5, 1, R_P], // 炮架
      [3, 1, B_P], // 可吃
      [1, 1, B_P], // 第二个隔子，够不着
    ]);
    const t = legalTargets(s, at(7, 1));
    expect(t).toContain(at(3, 1)); // 越过炮架(5,1)吃(3,1)
    expect(t).not.toContain(at(1, 1));
    expect(t).not.toContain(at(4, 1)); // 炮架之后不能平移
    expect(t).not.toContain(at(2, 1));
  });
});

describe('兵 / 卒', () => {
  it('过河前只能前进（正例+反例）', () => {
    const s = mk([[6, 4, R_P]]);
    expect(sorted(legalTargets(s, at(6, 4)))).toEqual([at(5, 4)]);
    const edge = mk([[5, 4, R_P]]); // 河沿红兵：尚未过河
    expect(sorted(legalTargets(edge, at(5, 4)))).toEqual([at(4, 4)]);
    const b = mk([[3, 4, B_P]], 2);
    expect(sorted(legalTargets(b, at(3, 4)))).toEqual([at(4, 4)]);
    const bEdge = mk([[4, 4, B_P]], 2); // 河沿黑卒：尚未过河
    expect(sorted(legalTargets(bEdge, at(4, 4)))).toEqual([at(5, 4)]);
  });

  it('过河后可进可平移，永不后退（正例+反例）', () => {
    const s = mk([[4, 4, R_P]]);
    expect(sorted(legalTargets(s, at(4, 4)))).toEqual([at(3, 4), at(4, 3), at(4, 5)]);
    expect(legalTargets(s, at(4, 4))).not.toContain(at(5, 4));
  });

  it('底线兵只能横走', () => {
    const s = mk([[0, 4, R_P]]);
    expect(sorted(legalTargets(s, at(0, 4)))).toEqual([at(0, 3), at(0, 5)]);
  });

  it('黑卒过河后方向对称', () => {
    const after = mk([[5, 4, B_P]], 2);
    expect(sorted(legalTargets(after, at(5, 4)))).toEqual([at(5, 3), at(5, 5), at(6, 4)]);
  });
});

describe('飞将（将帅照面）', () => {
  it('同列无遮挡构成双方均"被将"的非法局面', () => {
    const s = mk([
      [9, 4, R_K],
      [0, 4, B_K],
    ]);
    expect(isInCheck(s.board, 1)).toBe(true);
    expect(isInCheck(s.board, 2)).toBe(true);
  });

  it('同列有遮挡则不构成照面', () => {
    const s = mk([
      [9, 4, R_K],
      [0, 4, B_K],
      [5, 4, R_P], // 挡在两将之间的红兵（且不攻击任一将）
    ]);
    expect(isInCheck(s.board, 1)).toBe(false);
    expect(isInCheck(s.board, 2)).toBe(false);
  });

  it('走子不得拆开遮挡造成照面（走法被排除），亦不可吃将', () => {
    const s = mk(
      [
        [9, 4, R_K],
        [0, 4, B_K],
        [5, 4, R_P],
      ],
      1,
    );
    // 遮挡兵：横移出该列 → 照面，非法；沿该列前进仍遮挡 → 合法
    const pawn = legalTargets(s, at(5, 4));
    expect(pawn).not.toContain(at(5, 3));
    expect(pawn).not.toContain(at(5, 5));
    expect(pawn).toContain(at(4, 4));
    expect(pawn).not.toContain(at(0, 4)); // 不可吃将
    // 帅：横移后两将不再同列（不构成照面），沿该列退一步仍被兵遮挡，均合法
    const king = legalTargets(s, at(9, 4));
    expect(sorted(king)).toEqual([at(8, 4), at(9, 3), at(9, 5)]);
  });
});

describe('将军检测', () => {
  it('车将军：同线无遮挡（正例+反例）', () => {
    const blocked = mk([
      [9, 4, R_K],
      [0, 4, B_R],
      [7, 4, R_P],
    ]);
    expect(isInCheck(blocked.board, 1)).toBe(false);
    const open = mk([
      [9, 4, R_K],
      [0, 4, B_R],
    ]);
    expect(isInCheck(open.board, 1)).toBe(true);
  });

  it('炮将军：必须隔恰好一个炮架（正例+反例）', () => {
    const one = mk([
      [9, 0, R_K],
      [9, 4, B_C],
      [9, 2, B_P], // 恰一个炮架
    ]);
    expect(isInCheck(one.board, 1)).toBe(true);
    const none = mk([
      [9, 0, R_K],
      [9, 4, B_C],
    ]);
    expect(isInCheck(none.board, 1)).toBe(false);
    const two = mk([
      [9, 0, R_K],
      [9, 4, B_C],
      [9, 2, B_P],
      [9, 3, B_P], // 双炮架
    ]);
    expect(isInCheck(two.board, 1)).toBe(false);
  });

  it('马将军：马腿为空才构成（正例+反例）', () => {
    const open = mk([
      [9, 4, R_K],
      [7, 3, B_N], // 马腿 (8,3) 为空
    ]);
    expect(isInCheck(open.board, 1)).toBe(true);
    const blocked = mk([
      [9, 4, R_K],
      [7, 3, B_N],
      [8, 3, R_P], // 马腿被蹩
    ]);
    expect(isInCheck(blocked.board, 1)).toBe(false);
  });

  it('卒将军：正面一格，过河后可横吃（正例+反例）', () => {
    const front = mk([
      [9, 4, R_K],
      [8, 4, B_P],
    ]);
    expect(isInCheck(front.board, 1)).toBe(true);
    const side = mk([
      [9, 4, R_K],
      [9, 3, B_P], // 过河卒横吃
    ]);
    expect(isInCheck(side.board, 1)).toBe(true);
    const diag = mk([
      [9, 4, R_K],
      [8, 3, B_P], // 斜邻不吃
    ]);
    expect(isInCheck(diag.board, 1)).toBe(false);
  });
});

describe('应将过滤', () => {
  it('被将军时只保留应将步：垫将 / 出帅，不能留在将路线上', () => {
    const s = mk(
      [
        [9, 4, R_K],
        [5, 0, R_R],
        [0, 4, B_R],
      ],
      1,
    );
    expect(isInCheck(s.board, 1)).toBe(true);
    // 红车只能垫到将路线上（(5,4)），其余动作均不解将
    expect(sorted(legalTargets(s, at(5, 0)))).toEqual([at(5, 4)]);
    // 帅可平移出将路线，但不能迎着车留在该列
    const king = legalTargets(s, at(9, 4));
    expect(sorted(king)).toEqual([at(9, 3), at(9, 5)]);
    expect(king).not.toContain(at(8, 4));
  });
});

describe('终局判定', () => {
  it('最小双车杀：将死', () => {
    const s = mk(
      [
        [9, 0, R_K],
        [1, 0, R_R], // 封锁黑将的逃逸横线
        [5, 8, R_R],
        [0, 4, B_K],
      ],
      1,
    );
    const done = place(s, at(5, 8), at(0, 8)); // 车沉底叫杀
    expect(done.status).toBe('won');
    expect(done.winner).toBe(1);
    expect(done.reason).toBe('checkmate');
    expect(done.check).toBe(true);
    expect(allLegalMoves(done.board, 2)).toHaveLength(0);
    expect(isInCheck(done.board, 2)).toBe(true);
  });

  it('困毙：未被将军但无合法步，同样判负（无逼和）', () => {
    const s = mk(
      [
        [9, 0, R_K],
        [2, 4, R_P],
        [0, 3, B_K],
      ],
      1,
    );
    const done = place(s, at(2, 4), at(1, 4)); // 兵进一步，封死黑将
    expect(done.status).toBe('won');
    expect(done.winner).toBe(1);
    expect(done.reason).toBe('stalemate');
    expect(done.check).toBe(false);
    expect(allLegalMoves(done.board, 2)).toHaveLength(0);
    expect(isInCheck(done.board, 2)).toBe(false);
  });
});

describe('非法走子拒绝', () => {
  it('各类非法走子原样返回同一状态', () => {
    const s = initialState();
    expect(place(s, at(6, 4), at(4, 4))).toBe(s); // 兵连跳两格
    expect(place(s, at(9, 0), at(5, 0))).toBe(s); // 车越子
    expect(place(s, at(3, 0), at(4, 0))).toBe(s); // 轮到红方走黑子
    expect(place(s, at(5, 0), at(4, 0))).toBe(s); // 起点为空
    expect(place(s, at(9, 4), at(9, 4))).toBe(s); // from === to
    expect(place(s, -1, 0)).toBe(s); // 越界
    expect(place(s, 0, CELLS)).toBe(s);
  });

  it('终局后拒绝继续走子', () => {
    const s = mk(
      [
        [9, 0, R_K],
        [1, 0, R_R],
        [5, 8, R_R],
        [0, 4, B_K],
      ],
      1,
    );
    const done = place(s, at(5, 8), at(0, 8));
    expect(done.status).toBe('won');
    expect(place(done, at(1, 0), at(0, 0))).toBe(done);
  });
});

describe('悔棋（快照数组）', () => {
  it('逐手撤销恢复到历史快照（同引用），空历史为空操作', () => {
    const s0 = initialState();
    const s1 = place(s0, at(7, 7), at(7, 4)); // 炮二平五
    const s2 = place(s1, at(2, 7), at(2, 4)); // 炮 8 平 5
    expect(s2.history).toHaveLength(2);
    expect(s2.current).toBe(1);
    expect(undo(s2)).toBe(s1);
    expect(undo(undo(s2))).toBe(s0);
    expect(undo(s0)).toBe(s0);
    // 快照内容正确
    expect(s1.current).toBe(2);
    expect(s1.board[at(7, 7)]).toBe(0);
    expect(s1.board[at(7, 4)]).toBe(R_C);
    expect(s1.lastFrom).toBe(at(7, 7));
    expect(s1.lastTo).toBe(at(7, 4));
  });

  it('悔棋后可重新走子，轮次与状态一致', () => {
    const s0 = initialState();
    const s1 = place(s0, at(6, 2), at(5, 2));
    const back = undo(s1);
    expect(back.status).toBe('playing');
    expect(back.current).toBe(1);
    expect(back.board[at(6, 2)]).toBe(R_P);
    expect(back.board[at(5, 2)]).toBe(0);
    const again = place(back, at(7, 1), at(7, 4));
    expect(again.board[at(7, 4)]).toBe(R_C);
    expect(again.current).toBe(2);
  });

  it('pseudoTargets 对空位返回空数组', () => {
    expect(pseudoTargets(initialState().board, at(5, 4))).toEqual([]);
  });
});
