import { describe, expect, it } from 'vitest';
import {
  CELLS,
  SIZE,
  type Player,
  type ReversiState,
  discCounts,
  initialState,
  legalMoves,
  place,
  undo,
} from './reversi';

const idx = (r: number, c: number) => r * SIZE + c;
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

/** 按棋盘字符画（B 黑 / W 白 / . 空）构造任意局面，用于精确控制测试场景 */
function fromBoard(rows: string[], current: Player = 1): ReversiState {
  const board = new Int8Array(CELLS);
  rows.forEach((row, r) => {
    for (let c = 0; c < SIZE; c++) {
      const ch = row.charAt(c);
      board[idx(r, c)] = ch === 'B' ? 1 : ch === 'W' ? 2 : 0;
    }
  });
  return {
    board,
    history: [],
    current,
    status: 'playing',
    winner: 0,
    lastMove: -1,
    flipped: [],
    passedBy: 0,
  };
}

describe('reversi rules', () => {
  it('初始局面：恰好 4 子、颜色与位置正确、黑先、合法步恰为 4 个', () => {
    const s = initialState();
    expect(discCounts(s.board)).toEqual({ black: 2, white: 2 });
    expect(s.board[idx(3, 3)]).toBe(2); // 白
    expect(s.board[idx(4, 4)]).toBe(2); // 白
    expect(s.board[idx(3, 4)]).toBe(1); // 黑
    expect(s.board[idx(4, 3)]).toBe(1); // 黑
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.history).toHaveLength(0);
    // 开局黑方仅有的四个合法点
    expect(legalMoves(s)).toEqual([idx(2, 3), idx(3, 2), idx(4, 5), idx(5, 4)]);
  });

  it('黑白轮流落子，翻转与计数正确', () => {
    let s = initialState();
    // 黑 (2,3)：向下夹住白 (3,3)
    s = place(s, idx(2, 3));
    expect(s.current).toBe(2);
    expect(s.lastMove).toBe(idx(2, 3));
    expect(s.flipped).toEqual([idx(3, 3)]);
    expect(s.board[idx(3, 3)]).toBe(1);
    expect(discCounts(s.board)).toEqual({ black: 4, white: 1 }); // 初始 2 黑 + 新子 + 翻转 1 白
    // 白 (2,4)：向下夹住黑 (3,4)（远端白 (4,4)）
    s = place(s, idx(2, 4));
    expect(s.current).toBe(1);
    expect(s.flipped).toEqual([idx(3, 4)]);
    expect(s.board[idx(3, 4)]).toBe(2);
    expect(discCounts(s.board)).toEqual({ black: 3, white: 3 }); // 黑 3 = (4,3)(2,3)(3,3)
  });

  it('八方向同时翻转：一条落子夹住 8 条线', () => {
    // 白子从 (3,3) 向 8 个方向辐射，每个方向外端一枚黑子锚定
    const s0 = fromBoard([
      '........',
      '.B.B.B..',
      '..WWW...',
      '.BW.WB..',
      '..WWW...',
      '.B.B.B..',
      '........',
      '.....BWW',
    ]);
    const s = place(s0, idx(3, 3));
    expect(sorted(s.flipped)).toEqual([
      idx(2, 2),
      idx(2, 3),
      idx(2, 4),
      idx(3, 2),
      idx(3, 4),
      idx(4, 2),
      idx(4, 3),
      idx(4, 4),
    ]);
    // 新子与 8 枚被翻子全变黑，锚定黑子不变，远端两枚白子不受影响
    expect(s.board[idx(3, 3)]).toBe(1);
    for (const [r, c] of [
      [2, 2],
      [2, 3],
      [2, 4],
      [3, 2],
      [3, 4],
      [4, 2],
      [4, 3],
      [4, 4],
    ]) {
      expect(s.board[idx(r, c)]).toBe(1);
    }
    for (const [r, c] of [
      [1, 1],
      [1, 3],
      [1, 5],
      [3, 1],
      [3, 5],
      [5, 1],
      [5, 3],
      [5, 5],
    ]) {
      expect(s.board[idx(r, c)]).toBe(1);
    }
    expect(s.board[idx(7, 6)]).toBe(2);
    expect(s.board[idx(7, 7)]).toBe(2);
    expect(discCounts(s.board)).toEqual({ black: 18, white: 2 }); // 9 锚定黑子 + 新子 + 8 枚翻转
  });

  it('一条落子同时翻转多条线（横两条 + 竖一条 = 3 线）', () => {
    const s0 = fromBoard([
      '........',
      '........',
      '........',
      '.BW.WB..',
      '...W....',
      '...B....',
      '........',
      '........',
    ]);
    const s = place(s0, idx(3, 3));
    expect(sorted(s.flipped)).toEqual([idx(3, 2), idx(3, 4), idx(4, 3)]);
    // 锚定黑子保持不变
    expect(s.board[idx(3, 1)]).toBe(1);
    expect(s.board[idx(3, 5)]).toBe(1);
    expect(s.board[idx(5, 3)]).toBe(1);
  });

  it('边界与角落落子：正确翻转且绝不越界', () => {
    // 左上角 (0,0)：横、竖、斜三条线同时夹住
    const corner = fromBoard([
      '.WWB....',
      'WW......',
      'B.B.....',
      '........',
      '........',
      '........',
      '........',
      '........',
    ]);
    const s1 = place(corner, idx(0, 0));
    expect(sorted(s1.flipped)).toEqual([idx(0, 1), idx(0, 2), idx(1, 0), idx(1, 1)]);
    expect(s1.board[idx(0, 0)]).toBe(1);
    // 锚定黑子与界外方向不受影响
    expect(s1.board[idx(0, 3)]).toBe(1);
    expect(s1.board[idx(2, 0)]).toBe(1);
    expect(s1.board[idx(2, 2)]).toBe(1);
    expect(s1.board[idx(0, 4)]).toBe(0);
    expect(s1.board[idx(3, 3)]).toBe(0);

    // 右上角旁的边界点 (0,7)：只向左翻转
    const edge = fromBoard(['....BWW.', '........', '........', '........', '........', '........', '........', '........']);
    const s2 = place(edge, idx(0, 7));
    expect(sorted(s2.flipped)).toEqual([idx(0, 5), idx(0, 6)]);
    expect(s2.board[idx(0, 7)]).toBe(1);
    expect(s2.board[idx(0, 4)]).toBe(1);
  });

  it('无合法步 → 自动 pass：轮次不变方连续行动，pass 不占用快照', () => {
    // 黑 (0,4) 翻转 (0,3) 后，白方虽仍有子但无任何合法步
    const s0 = fromBoard([
      'BBBW.WW.',
      '........',
      '........',
      '...W....',
      '...B....',
      '...B....',
      '...B....',
      '...B....',
    ]);
    expect(legalMoves(s0)).toEqual([idx(0, 4), idx(2, 3)]);
    const s1 = place(s0, idx(0, 4));
    expect(s1.flipped).toEqual([idx(0, 3)]);
    expect(s1.board[idx(0, 3)]).toBe(1);
    expect(s1.board[idx(0, 4)]).toBe(1);
    // 白方被跳过：轮次仍是黑方，给出 passedBy 标记，且未终局
    expect(s1.current).toBe(1);
    expect(s1.passedBy).toBe(2);
    expect(s1.status).toBe('playing');
    // pass 不产生快照，只记录了这一手落子
    expect(s1.history).toHaveLength(1);
    // 黑方连续行动：仍可正常落子
    expect(legalMoves(s1)).toEqual([idx(0, 7), idx(2, 3)]);
    const s2 = place(s1, idx(2, 3));
    expect(s2.current).toBe(1);
    expect(s2.passedBy).toBe(2);
    expect(s2.board[idx(3, 3)]).toBe(1);
  });

  it('双方均无合法步 → 终局判定：黑胜（含连续两次 pass 后清空白方）', () => {
    const s0 = fromBoard([
      'BBBW.WW.',
      '........',
      '........',
      '...W....',
      '...B....',
      '...B....',
      '...B....',
      '...B....',
    ]);
    const s1 = place(s0, idx(0, 4)); // 白被 pass
    const s2 = place(s1, idx(2, 3)); // 白再次被 pass
    expect(s2.passedBy).toBe(2);
    const s3 = place(s2, idx(0, 7)); // 清空最后一枚白子 → 双方均无步
    expect(s3.status).toBe('won');
    expect(s3.winner).toBe(1);
    expect(discCounts(s3.board)).toEqual({ black: 14, white: 0 });
    expect(legalMoves(s3)).toEqual([]);
  });

  it('棋盘下满：子多者胜', () => {
    // 63 子满盘差一格，黑收最后一格：向左翻 3 子、向上翻 1 子 → 37:27
    const full = fromBoard([
      'BWBWBWBW',
      'WBWBWBWB',
      'BWBWBWBW',
      'WBWBWBWB',
      'BWBWBWBW',
      'WBWBWBWB',
      'BWBWBWBW',
      'BBBBWWW.',
    ]);
    const s = place(full, idx(7, 7));
    expect(s.status).toBe('won');
    expect(s.winner).toBe(1);
    expect(discCounts(s.board)).toEqual({ black: 37, white: 27 });
    expect(legalMoves(s)).toEqual([]);
  });

  it('棋盘下满且等数 → 和棋', () => {
    const full = fromBoard([
      'WBBBWWWW',
      'BWBBWWWW',
      'BBWBWWWW',
      'BBBWBWWW',
      'BBBWWBWW',
      'BBBWBWWW',
      'BBBWWWWW',
      'BBBBWWW.',
    ]);
    expect(discCounts(full.board)).toEqual({ black: 28, white: 35 });
    const s = place(full, idx(7, 7));
    expect(s.status).toBe('draw');
    expect(s.winner).toBe(0);
    expect(discCounts(s.board)).toEqual({ black: 32, white: 32 });
  });

  it('悔棋：弹出快照精确恢复上一手之前的状态', () => {
    const s0 = initialState();
    expect(undo(s0)).toBe(s0); // 空历史悔棋是空操作
    const s1 = place(s0, idx(2, 3));
    expect(discCounts(s1.board)).toEqual({ black: 4, white: 1 });
    expect(undo(s1)).toBe(s0); // 快照即原状态对象
    expect(discCounts(undo(s1).board)).toEqual({ black: 2, white: 2 });
    expect(undo(s1).current).toBe(1);
    expect(undo(s1).status).toBe('playing');
    // 多步悔棋逐级回退
    const s2 = place(s1, idx(2, 4));
    expect(undo(s2)).toBe(s1);
  });

  it('悔棋跨越 pass：恢复到 pass 发生前/后的正确快照', () => {
    const s0 = fromBoard([
      'BBBW.WW.',
      '........',
      '........',
      '...W....',
      '...B....',
      '...B....',
      '...B....',
      '...B....',
    ]);
    const s1 = place(s0, idx(0, 4)); // 引发白方 pass
    const s2 = place(s1, idx(2, 3)); // 再次 pass
    const s3 = place(s2, idx(0, 7)); // 终局
    expect(s3.status).toBe('won');
    // 快照栈逐级弹回，pass 不产生额外层级
    expect(undo(s3)).toBe(s2);
    expect(undo(s2)).toBe(s1);
    expect(undo(s1)).toBe(s0);
    // 终局悔棋恢复可下状态，且轮次正确
    const resumed = undo(s3);
    expect(resumed.status).toBe('playing');
    expect(resumed.current).toBe(1);
    expect(resumed.passedBy).toBe(2);
  });

  it('拒绝非法落子：不夹子 / 占用已有棋子 / 越界 / 终局后落子', () => {
    const s0 = initialState();
    // 空位但不夹子
    expect(place(s0, idx(0, 0))).toBe(s0);
    expect(place(s0, idx(2, 2))).toBe(s0);
    // 占用白子 / 己方黑子
    expect(place(s0, idx(3, 3))).toBe(s0);
    expect(place(s0, idx(3, 4))).toBe(s0);
    // 越界
    expect(place(s0, -1)).toBe(s0);
    expect(place(s0, CELLS)).toBe(s0);
    // 白方回合下的非法点
    const s1 = place(s0, idx(2, 3));
    expect(place(s1, idx(0, 0))).toBe(s1);
    // 终局后拒绝一切落子
    const p0 = fromBoard([
      'BBBW.WW.',
      '........',
      '........',
      '...W....',
      '...B....',
      '...B....',
      '...B....',
      '...B....',
    ]);
    const over = place(place(place(p0, idx(0, 4)), idx(2, 3)), idx(0, 7));
    expect(over.status).toBe('won');
    expect(place(over, idx(0, 0))).toBe(over);
  });

  it('discCounts 直接统计棋盘双方子数', () => {
    expect(discCounts(initialState().board)).toEqual({ black: 2, white: 2 });
    const board = new Int8Array(CELLS);
    board[idx(0, 0)] = 1;
    board[idx(7, 7)] = 2;
    board[idx(3, 4)] = 1;
    expect(discCounts(board)).toEqual({ black: 2, white: 1 });
  });
});
