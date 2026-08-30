import { describe, expect, it } from 'vitest';
import {
  CELLS,
  DRAW_PLIES,
  SIZE,
  KING_1,
  KING_2,
  MAN_1,
  MAN_2,
  type CheckersState,
  type Move,
  type Player,
  at,
  initialState,
  isBareKings,
  isDark,
  isKing,
  legalMoves,
  movesFrom,
  mustCapture,
  pieceCount,
  place,
  rowOf,
  sideOf,
  undo,
} from './checkers';

const sortIdx = (a: number[]) => [...a].sort((x, y) => x - y);
const tos = (moves: Move[]) => sortIdx(moves.map((m) => m.to));

/** 按 (行, 列, 棋子编码) 直接摆子构造任意局面，用于精确控制测试场景 */
function mkState(
  pieces: Array<[number, number, number]>,
  current: Player = 1,
  noProgress = 0,
): CheckersState {
  const board = new Int8Array(CELLS);
  for (const [r, c, v] of pieces) board[at(r, c)] = v;
  return {
    board,
    history: [],
    current,
    status: 'playing',
    winner: 0,
    reason: '',
    noProgress,
    lastFrom: -1,
    lastTo: -1,
  };
}

describe('棋盘与编码', () => {
  it('8×8 深色格交替：每行 4 个深色格，相邻行错开', () => {
    for (let r = 0; r < SIZE; r++) {
      let darks = 0;
      for (let c = 0; c < SIZE; c++) {
        expect(isDark(r, c)).toBe((r + c) % 2 === 1);
        if (isDark(r, c)) darks++;
      }
      expect(darks).toBe(4);
    }
    expect(isDark(0, 0)).toBe(false);
    expect(isDark(0, 1)).toBe(true);
  });

  it('棋子编码与辅助函数', () => {
    expect(sideOf(MAN_1)).toBe(1);
    expect(sideOf(KING_1)).toBe(1);
    expect(sideOf(MAN_2)).toBe(2);
    expect(sideOf(KING_2)).toBe(2);
    expect(sideOf(0)).toBe(0);
    expect(isKing(MAN_1)).toBe(false);
    expect(isKing(KING_2)).toBe(true);
    expect(at(3, 2)).toBe(3 * SIZE + 2);
    expect(rowOf(at(5, 6))).toBe(5);
  });
});

describe('初始局面', () => {
  it('双方各 12 子占满己方前三排深色格，红先行', () => {
    const s = initialState();
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.winner).toBe(0);
    expect(s.reason).toBe('');
    expect(s.noProgress).toBe(0);
    expect(s.history).toHaveLength(0);
    expect(s.lastFrom).toBe(-1);
    expect(pieceCount(s.board, 1)).toBe(12);
    expect(pieceCount(s.board, 2)).toBe(12);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!isDark(r, c)) expect(s.board[at(r, c)]).toBe(0); // 浅色格永远无子
        else if (r <= 2) expect(s.board[at(r, c)]).toBe(MAN_2);
        else if (r >= 5) expect(s.board[at(r, c)]).toBe(MAN_1);
        else expect(s.board[at(r, c)]).toBe(0);
      }
    }
  });

  it('开局无吃子；可行走法集中在第 5 排（共 7 步），后排被己方堵死', () => {
    const s = initialState();
    expect(mustCapture(s)).toBe(false);
    const moves = legalMoves(s);
    expect(moves).toHaveLength(7);
    for (const m of moves) {
      expect(m.captures).toEqual([]);
      expect(rowOf(m.from)).toBe(5);
    }
    expect(tos(movesFrom(s, at(5, 0)))).toEqual([at(4, 1)]); // 边兵只有 1 步
    expect(tos(movesFrom(s, at(5, 4)))).toEqual(sortIdx([at(4, 3), at(4, 5)]));
    expect(movesFrom(s, at(6, 3))).toEqual([]);
    expect(movesFrom(s, at(7, 2))).toEqual([]);
  });

  it('isBareKings：双方各恰剩一王才为真', () => {
    expect(isBareKings(initialState().board)).toBe(false);
    expect(isBareKings(mkState([[3, 2, KING_1], [5, 4, KING_2]]).board)).toBe(true);
    expect(isBareKings(mkState([[3, 2, KING_1], [5, 4, KING_2], [6, 5, KING_2]]).board)).toBe(false);
    expect(isBareKings(mkState([[3, 2, KING_1], [5, 4, MAN_2]]).board)).toBe(false);
    expect(isBareKings(mkState([[3, 2, MAN_1], [5, 4, KING_2]]).board)).toBe(false);
  });
});

describe('普通走子（兵只能斜前）', () => {
  it('兵斜前走一格，不能后退', () => {
    const s = mkState([[4, 3, MAN_1]]);
    expect(tos(movesFrom(s, at(4, 3)))).toEqual(sortIdx([at(3, 2), at(3, 4)]));
    expect(tos(movesFrom(s, at(4, 3)))).not.toContain(at(5, 2));
    expect(tos(movesFrom(s, at(4, 3)))).not.toContain(at(5, 4));
    // 白兵向下
    const w = mkState([[3, 4, MAN_2]], 2);
    expect(tos(movesFrom(w, at(3, 4)))).toEqual(sortIdx([at(4, 3), at(4, 5)]));
  });

  it('边角兵方向受限；被己方堵死且无法跳时无路', () => {
    // (7,0) 只能斜前右上 (6,1)，该格被己方占住 → 无路（浅色格与出界方向本就不存在）
    const s = mkState([[7, 0, MAN_1], [6, 1, MAN_1]]);
    expect(tos(movesFrom(s, at(7, 0)))).toEqual([]);
    expect(tos(movesFrom(s, at(6, 1)))).toEqual(sortIdx([at(5, 0), at(5, 2)]));
  });

  it('普通一步：换手、记录最后一手、快照入栈', () => {
    const s0 = initialState();
    const s1 = place(s0, at(5, 4), at(4, 3));
    expect(s1).not.toBe(s0);
    expect(s1.board[at(5, 4)]).toBe(0);
    expect(s1.board[at(4, 3)]).toBe(MAN_1);
    expect(s1.current).toBe(2);
    expect(s1.lastFrom).toBe(at(5, 4));
    expect(s1.lastTo).toBe(at(4, 3));
    expect(s1.history).toEqual([s0]);
    expect(s1.status).toBe('playing');
  });
});

describe('吃子与强制吃子过滤', () => {
  it('跳过相邻敌子落到其后空格', () => {
    const s = mkState([[4, 3, MAN_1], [3, 4, MAN_2]]);
    expect(mustCapture(s)).toBe(true);
    const ms = movesFrom(s, at(4, 3));
    expect(ms).toHaveLength(1);
    expect(ms[0].to).toBe(at(2, 5));
    expect(ms[0].captures).toEqual([at(3, 4)]);
    // 强制吃子时普通步被过滤：(3,2) 不再是终点
    expect(tos(ms)).not.toContain(at(3, 2));
    // 强制吃子下，无吃子的己方棋子不可动
    const s2 = mkState([[4, 3, MAN_1], [3, 4, MAN_2], [6, 1, MAN_1]]);
    expect(movesFrom(s2, at(6, 1))).toEqual([]);
    expect(place(s2, at(6, 1), at(5, 0))).toBe(s2);
    expect(place(s2, at(4, 3), at(3, 2))).toBe(s2);
  });

  it('不能跳己方棋子；落点被占则跳不成', () => {
    const own = mkState([[4, 3, MAN_1], [3, 4, MAN_1]]);
    expect(mustCapture(own)).toBe(false);
    expect(tos(movesFrom(own, at(4, 3)))).toEqual([at(3, 2)]); // (3,4) 被己方占

    const blocked = mkState([[4, 3, MAN_1], [3, 4, MAN_2], [2, 5, MAN_2]]);
    expect(mustCapture(blocked)).toBe(false); // 落点被占 → 跳不成
    // (3,4) 被白兵占住既不可走也不可跳过（跳过它的落点 (2,5) 也被占）
    expect(tos(movesFrom(blocked, at(4, 3)))).toEqual([at(3, 2)]);
  });

  it('兵不能向后跳吃', () => {
    const s = mkState([[4, 3, MAN_1], [5, 2, MAN_2]]);
    expect(mustCapture(s)).toBe(false);
    expect(tos(movesFrom(s, at(4, 3)))).toEqual(sortIdx([at(3, 2), at(3, 4)]));
  });
});

describe('多跳链必须走完；变向合法', () => {
  it('直线两连跳：只提供链尾终点，中途停跳被拒', () => {
    const s = mkState([[5, 0, MAN_1], [4, 1, MAN_2], [2, 3, MAN_2], [0, 1, MAN_2]]);
    const ms = movesFrom(s, at(5, 0));
    expect(ms).toHaveLength(1);
    expect(ms[0].to).toBe(at(1, 4));
    expect(ms[0].captures).toEqual([at(4, 1), at(2, 3)]);
    expect(ms[0].landings).toEqual([at(3, 2), at(1, 4)]);
    expect(tos(ms)).not.toContain(at(3, 2)); // 链中落点不是终点——必须走完
    expect(place(s, at(5, 0), at(3, 2))).toBe(s); // 中途停跳被拒
    const done = place(s, at(5, 0), at(1, 4));
    expect(done.status).toBe('playing'); // 白方尚剩 (0,1)
    expect(done.board[at(5, 0)]).toBe(0);
    expect(done.board[at(4, 1)]).toBe(0);
    expect(done.board[at(2, 3)]).toBe(0);
    expect(done.board[at(1, 4)]).toBe(MAN_1); // 未到升变行，仍是兵
    expect(done.history).toEqual([s]); // 整条链只产生一个快照
    expect(done.current).toBe(2);
  });

  it('连跳链中变向合法（先右上再左上）', () => {
    const s = mkState([[5, 4, MAN_1], [4, 5, MAN_2], [2, 5, MAN_2]]);
    const ms = movesFrom(s, at(5, 4));
    expect(ms).toHaveLength(1);
    expect(ms[0].to).toBe(at(1, 4));
    expect(ms[0].captures).toEqual([at(4, 5), at(2, 5)]);
    expect(ms[0].landings).toEqual([at(3, 6), at(1, 4)]);
    const done = place(s, at(5, 4), at(1, 4));
    expect(done.board[at(1, 4)]).toBe(MAN_1);
    expect(done.board[at(4, 5)]).toBe(0);
    expect(done.board[at(2, 5)]).toBe(0);
  });

  it('同一终点存在两条不同吃链时全部列出，place 取吃子并列时的生成序首条', () => {
    // (5,2) 先左跳 (4,1)→(3,0) 再右跳 (2,1)→(1,2)；或先右跳 (4,3)→(3,4) 再左跳 (2,3)→(1,2)
    const s = mkState([
      [5, 2, MAN_1],
      [4, 1, MAN_2],
      [4, 3, MAN_2],
      [2, 1, MAN_2],
      [2, 3, MAN_2],
    ]);
    const ms = movesFrom(s, at(5, 2));
    expect(ms).toHaveLength(2);
    expect(tos(ms)).toEqual([at(1, 2), at(1, 2)]);
    expect(ms[0].captures).toEqual([at(4, 1), at(2, 1)]); // 生成序：方向序先左
    expect(ms[1].captures).toEqual([at(4, 3), at(2, 3)]);
    const done = place(s, at(5, 2), at(1, 2)); // 吃子数并列 → 取生成序首条
    expect(done.board[at(4, 1)]).toBe(0);
    expect(done.board[at(2, 1)]).toBe(0);
    expect(done.board[at(4, 3)]).toBe(MAN_2);
    expect(done.board[at(2, 3)]).toBe(MAN_2);
    expect(done.board[at(1, 2)]).toBe(MAN_1);
  });

  it('王三连跳（含向后跳与变向）：中途点均非终点', () => {
    const s = mkState([
      [4, 3, KING_1],
      [3, 4, MAN_2],
      [3, 6, MAN_2],
      [5, 6, MAN_2],
      [5, 4, MAN_2],
    ]);
    const ms = movesFrom(s, at(4, 3));
    expect(ms).toHaveLength(2);
    // 链 A：(4,3)→(2,5)→(4,7)→(6,5)，绕圈跳回起点被禁止后收链
    expect(ms[0].to).toBe(at(6, 5));
    expect(ms[0].captures).toEqual([at(3, 4), at(3, 6), at(5, 6)]);
    // 链 B：(4,3)→(6,5)→(4,7)→(2,5)
    expect(ms[1].to).toBe(at(2, 5));
    expect(ms[1].captures).toEqual([at(5, 4), at(5, 6), at(3, 6)]);
    expect(tos(ms)).not.toContain(at(4, 7)); // 链中落点不是终点
    expect(place(s, at(4, 3), at(4, 7))).toBe(s); // 中途停跳被拒
    const done = place(s, at(4, 3), at(6, 5));
    expect(done.board[at(6, 5)]).toBe(KING_1);
    expect(done.board[at(5, 4)]).toBe(MAN_2); // 链 A 未吃的子保留
    for (const [r, c] of [[3, 4], [3, 6], [5, 6]] as const) {
      expect(done.board[at(r, c)]).toBe(0);
    }
    // 反向走链 B 同样成立
    const doneB = place(s, at(4, 3), at(2, 5));
    expect(doneB.board[at(2, 5)]).toBe(KING_1);
    expect(doneB.board[at(3, 4)]).toBe(MAN_2);
  });

  it('不能落回走过的格子（含起点）：绕圈跳回起点被禁止', () => {
    // 王 (4,3) 理论上可绕四颗白子一圈；允许落回起点将产生一条吃光四子的绕圈链
    const s = mkState([
      [4, 3, KING_1],
      [3, 4, MAN_2],
      [3, 6, MAN_2],
      [5, 6, MAN_2],
      [5, 4, MAN_2],
    ]);
    const ms = movesFrom(s, at(4, 3));
    expect(tos(ms)).not.toContain(at(4, 3)); // 起点不可作为落点
    expect(ms.every((m) => m.captures.length < 4)).toBe(true); // 不存在吃光四子的绕圈链
    // 绕圈路径本身成立：两条完整链各吃三子（详见"王三连跳"测试）
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.captures.length === 3)).toBe(true);
  });
});

describe('成王（升变）', () => {
  it('普通兵走到对方底线升变为王', () => {
    const s0 = mkState([[1, 2, MAN_1], [5, 4, MAN_2]]);
    expect(mustCapture(s0)).toBe(false);
    expect(tos(movesFrom(s0, at(1, 2)))).toEqual(sortIdx([at(0, 1), at(0, 3)]));
    const s1 = place(s0, at(1, 2), at(0, 3));
    expect(s1.board[at(0, 3)]).toBe(KING_1);
    expect(s1.status).toBe('playing'); // 白方尚有子有步
    // 白兵到第 7 行升变为白王
    const t0 = mkState([[6, 5, MAN_2], [0, 1, MAN_1]], 2);
    const t1 = place(t0, at(6, 5), at(7, 4));
    expect(t1.board[at(7, 4)]).toBe(KING_2);
    expect(t1.current).toBe(1);
  });

  it('跳吃入底线同样升变', () => {
    // (2,1) 右上跳吃 (1,2) 落 (0,3) 成王
    const s = mkState([[2, 1, MAN_1], [1, 2, MAN_2], [5, 6, MAN_2]]);
    const ms = movesFrom(s, at(2, 1));
    expect(ms).toHaveLength(1);
    expect(ms[0].to).toBe(at(0, 3));
    expect(ms[0].captures).toEqual([at(1, 2)]);
    const done = place(s, at(2, 1), at(0, 3));
    expect(done.board[at(0, 3)]).toBe(KING_1);
    expect(done.board[at(1, 2)]).toBe(0);
    expect(done.status).toBe('playing'); // 白方 (5,6) 尚有步
  });

  it('英式规则：普通兵跳入底线即成王收步，即使还能继续跳', () => {
    // (2,3) 跳吃 (1,4) 落 (0,5) 成王；若允许续跳本可再吃 (1,6) 落 (2,7)，但升变即收步
    const s = mkState([[2, 3, MAN_1], [1, 4, MAN_2], [1, 6, MAN_2]]);
    const ms = movesFrom(s, at(2, 3));
    expect(ms).toHaveLength(1);
    expect(ms[0].to).toBe(at(0, 5));
    expect(ms[0].captures).toEqual([at(1, 4)]);
    expect(tos(ms)).not.toContain(at(2, 7));
    const done = place(s, at(2, 3), at(0, 5));
    expect(done.board[at(0, 5)]).toBe(KING_1);
    expect(done.board[at(1, 6)]).toBe(MAN_2); // 后面的敌子没被吃
    expect(done.status).toBe('playing');
    expect(done.current).toBe(2);
  });
});

describe('王四向走/跳', () => {
  it('空阔处的王恰有 4 个斜向一步终点（含向后）', () => {
    const s = mkState([[4, 3, KING_1]]);
    expect(tos(movesFrom(s, at(4, 3)))).toEqual(
      sortIdx([at(3, 2), at(3, 4), at(5, 2), at(5, 4)]),
    );
  });

  it('王向后跳吃', () => {
    const s = mkState([[4, 3, KING_1], [5, 2, MAN_2], [5, 6, MAN_2]]);
    const ms = movesFrom(s, at(4, 3));
    expect(ms).toHaveLength(1); // 有吃必吃：只有这一条吃链
    expect(ms[0].to).toBe(at(6, 1));
    expect(ms[0].captures).toEqual([at(5, 2)]);
    const done = place(s, at(4, 3), at(6, 1));
    expect(done.board[at(6, 1)]).toBe(KING_1);
    expect(done.board[at(5, 2)]).toBe(0);
    expect(done.status).toBe('playing'); // 白方 (5,6) 尚有步
  });
});

describe('终局判定', () => {
  it('吃光对方全部棋子判胜（cleared）', () => {
    const s = mkState([[4, 3, MAN_1], [3, 4, MAN_2]]);
    const won = place(s, at(4, 3), at(2, 5));
    expect(won.status).toBe('won');
    expect(won.winner).toBe(1);
    expect(won.reason).toBe('cleared');
    expect(pieceCount(won.board, 2)).toBe(0);
    expect(movesFrom(won, at(2, 5))).toEqual([]); // 终局后无走法
    expect(place(won, at(2, 5), at(3, 4))).toBe(won); // 终局后拒绝一切操作
  });

  it('对方无合法步判胜（blocked：困毙）', () => {
    // 白兵 (0,1)：前进两格被红兵占住，跳吃落点 (2,3) 也被占 → 白方无步
    const preBlock = mkState([
      [1, 0, MAN_1],
      [1, 2, MAN_1],
      [2, 3, MAN_1],
      [7, 2, MAN_1],
      [0, 1, MAN_2],
    ]);
    const blocked = place(preBlock, at(7, 2), at(6, 1));
    expect(blocked.status).toBe('won');
    expect(blocked.winner).toBe(1);
    expect(blocked.reason).toBe('blocked');
    expect(pieceCount(blocked.board, 2)).toBe(1); // 还有子，只是无步

    // 直接构造困毙局面：legalMoves 为空
    const stuck = mkState(
      [[1, 0, MAN_1], [1, 2, MAN_1], [2, 3, MAN_1], [6, 1, MAN_1], [0, 1, MAN_2]],
      2,
    );
    expect(legalMoves(stuck)).toEqual([]);
  });

  it('和棋：双方各剩一王且无进展达阈值', () => {
    const kings = (noProgress: number) => mkState([[3, 2, KING_1], [5, 4, KING_2]], 1, noProgress);
    // 阈值边缘的安静步 → 判和
    const drawn = place(kings(DRAW_PLIES - 1), at(3, 2), at(2, 3));
    expect(drawn.status).toBe('draw');
    expect(drawn.winner).toBe(0);
    expect(drawn.reason).toBe('no-progress');
    // 未达阈值 → 继续，计数累加
    const playing = place(kings(0), at(3, 2), at(2, 3));
    expect(playing.status).toBe('playing');
    expect(playing.noProgress).toBe(1);
    // 阈值边缘但这一手有吃子 → 计数清零，走向胜负而非和棋
    // （(3,2) 跳吃 (4,3) 落 (5,4) 后无跳可续，链止于 (5,4)；白王 (5,6) 幸存）
    const capNear = mkState([[3, 2, KING_1], [4, 3, KING_2], [5, 6, KING_2]], 1, DRAW_PLIES - 1);
    const captured = place(capNear, at(3, 2), at(5, 4));
    expect(captured.status).toBe('playing');
    expect(captured.noProgress).toBe(0);
    expect(pieceCount(captured.board, 2)).toBe(1);
    // 未进入双王残局：安静步把计数清零
    const notBare = mkState([[3, 2, KING_1], [5, 2, MAN_1], [5, 4, KING_2]], 1, DRAW_PLIES - 1);
    const quiet = place(notBare, at(5, 2), at(4, 1));
    expect(quiet.status).toBe('playing');
    expect(quiet.noProgress).toBe(0);
  });
});

describe('非法走子拒绝', () => {
  it('越界 / 非己方棋子 / 空格 / 不可达终点 / 被占落点', () => {
    const s = mkState([[4, 3, MAN_1], [3, 4, MAN_2], [0, 1, MAN_2]]);
    expect(place(s, at(4, 3), at(3, 2))).toBe(s); // 有吃必吃：普通步被过滤
    expect(place(s, at(4, 3), at(3, 4))).toBe(s); // 落点被占（被跳的中继格）
    expect(place(s, at(0, 1), at(1, 0))).toBe(s); // 对方棋子
    expect(place(s, at(2, 5), at(3, 4))).toBe(s); // 空格无子
    expect(place(s, at(4, 3), -1)).toBe(s);
    expect(place(s, at(4, 3), CELLS)).toBe(s);
    expect(place(s, at(4, 3), at(0, 3))).toBe(s); // 不可达
    expect(movesFrom(s, -1)).toEqual([]);
    expect(movesFrom(s, CELLS)).toEqual([]);
    expect(movesFrom(s, at(0, 1))).toEqual([]); // 对方棋子
    expect(movesFrom(s, at(2, 5))).toEqual([]); // 空格
    expect(movesFrom(initialState(), CELLS + 5)).toEqual([]);
  });
});

describe('悔棋（快照数组）', () => {
  it('空历史悔棋是空操作', () => {
    const s = initialState();
    expect(undo(s)).toBe(s);
  });

  it('普通步悔棋：快照与上一手之前的状态全同，可逐级回退', () => {
    const s0 = mkState([[4, 3, MAN_1], [0, 1, MAN_2]]);
    const s1 = place(s0, at(4, 3), at(3, 2)); // 红走 → 轮白
    const s2 = place(s1, at(0, 1), at(1, 0)); // 白走 → 轮红
    expect(s1.current).toBe(2);
    expect(s2.current).toBe(1);
    expect(s2.history).toEqual([s0, s1]);
    expect(undo(s2)).toBe(s1);
    expect(undo(s2).board[at(1, 0)]).toBe(0);
    expect(undo(undo(s2))).toBe(s0);
  });

  it('跳链整链只产生一个快照，悔棋整体回退', () => {
    const s = mkState([[5, 0, MAN_1], [4, 1, MAN_2], [2, 3, MAN_2], [0, 1, MAN_2]]);
    const jumped = place(s, at(5, 0), at(1, 4));
    expect(jumped.history).toEqual([s]);
    expect(undo(jumped)).toBe(s);
    expect(undo(jumped).board[at(4, 1)]).toBe(MAN_2);
    expect(undo(jumped).board[at(2, 3)]).toBe(MAN_2);
  });

  it('胜局悔棋：恢复到获胜手之前的可下状态', () => {
    const s = mkState([[4, 3, MAN_1], [3, 4, MAN_2]]);
    const won = place(s, at(4, 3), at(2, 5));
    expect(won.status).toBe('won');
    const resumed = undo(won);
    expect(resumed).toBe(s);
    expect(resumed.status).toBe('playing');
    expect(resumed.current).toBe(1);
    expect(resumed.board[at(2, 5)]).toBe(0);
    expect(resumed.board[at(3, 4)]).toBe(MAN_2);
  });

  it('升变悔棋：王还原为兵', () => {
    const s = mkState([[1, 2, MAN_1], [5, 4, MAN_2]]);
    const promoted = place(s, at(1, 2), at(0, 3));
    expect(promoted.board[at(0, 3)]).toBe(KING_1);
    const back = undo(promoted);
    expect(back).toBe(s);
    expect(back.board[at(1, 2)]).toBe(MAN_1);
    expect(back.board[at(0, 3)]).toBe(0);
  });
});
