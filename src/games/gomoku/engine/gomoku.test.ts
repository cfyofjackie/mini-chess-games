import { describe, expect, it } from 'vitest';
import {
  CELLS,
  SIZE,
  GomokuState,
  initialState,
  place,
  undo,
} from './gomoku';

const idx = (r: number, c: number) => r * SIZE + c;

// 按 黑/白 交替落子（黑先），cells 交替展开
function play(...cells: Array<[number, number]>): GomokuState {
  let s = initialState();
  for (const [r, c] of cells) s = place(s, idx(r, c));
  return s;
}

describe('gomoku rules', () => {
  it('黑白轮流，黑先行', () => {
    let s = initialState();
    expect(s.current).toBe(1);
    s = place(s, idx(7, 7));
    expect(s.current).toBe(2);
    s = place(s, idx(7, 8));
    expect(s.current).toBe(1);
  });

  it('四个方向五连均获胜，并返回连珠格子', () => {
    // 横向：黑 (7,3..7)，白穿插 (8,3..6) 不成五
    const h = play(
      [7, 3], [8, 3], [7, 4], [8, 4], [7, 5], [8, 5], [7, 6], [8, 6], [7, 7],
    );
    expect(h.status).toBe('won');
    expect(h.winner).toBe(1);
    expect(h.line).toHaveLength(5);

    // 纵向：黑 (3..7,5)，白穿插 (1,14..11) 只有四连
    const v = play(
      [3, 5], [1, 14], [4, 5], [1, 13], [5, 5], [1, 12], [6, 5], [1, 11], [7, 5],
    );
    expect(v.status).toBe('won');
    expect(v.winner).toBe(1);
    expect(v.line).toHaveLength(5);

    // 主对角 ↘
    const d1 = play(
      [3, 3], [0, 14], [4, 4], [0, 13], [5, 5], [0, 12], [6, 6], [0, 11], [7, 7],
    );
    expect(d1.status).toBe('won');
    expect(d1.winner).toBe(1);

    // 副对角 ↗
    const d2 = play(
      [7, 3], [0, 0], [6, 4], [0, 1], [5, 5], [0, 2], [4, 6], [0, 3], [3, 7],
    );
    expect(d2.status).toBe('won');
    expect(d2.winner).toBe(1);
  });

  it('长连（≥5）同样获胜，胜利后拒绝继续落子', () => {
    // 黑第 5 子成五连即胜，第 6 颗不会再落下
    let s = play([7, 3], [8, 3], [7, 4], [8, 4], [7, 5], [8, 5], [7, 6], [8, 6], [7, 7]);
    expect(s.status).toBe('won');
    const frozen = place(s, idx(7, 8));
    expect(frozen).toBe(s);
    expect(s.board[idx(7, 8)]).toBe(0);
  });

  it('拒绝占用已落子的交叉点', () => {
    let s = place(initialState(), idx(7, 7));
    const again = place(s, idx(7, 7));
    expect(again).toBe(s);
  });

  it('悔棋：撤销上一手并恢复轮次与状态', () => {
    let s = play([7, 7], [7, 8], [8, 7]);
    expect(s.history).toHaveLength(3);
    expect(s.current).toBe(2); // 黑先白后，3 手后轮白
    const s2 = undo(s);
    expect(s2.history).toHaveLength(2);
    expect(s2.board[idx(8, 7)]).toBe(0);
    expect(s2.current).toBe(1);
    expect(s2.status).toBe('playing');
    // 胜局悔棋：轮到刚获胜的一方重下
    const won = play([7, 3], [8, 3], [7, 4], [8, 4], [7, 5], [8, 5], [7, 6], [8, 6], [7, 7]);
    const resumed = undo(won);
    expect(resumed.status).toBe('playing');
    expect(resumed.current).toBe(1);
    expect(resumed.board[idx(7, 7)]).toBe(0);
    // 空历史悔棋是空操作（同一引用原样返回）
    const fresh = initialState();
    expect(undo(fresh)).toBe(fresh);
  });

  it('满盘无五连为和棋（模 4 双色构造，任意方向连珠 ≤2）', () => {
    // 构造棋盘：色 = (r + 2c) mod 4 < 2 ? 黑 : 白，可证明四方向最长连珠为 2
    const board = new Int8Array(CELLS);
    const history: number[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (r === SIZE - 1 && c === SIZE - 1) continue; // 留最后一手真实落下
        const i = idx(r, c);
        board[i] = (r + 2 * c) % 4 < 2 ? 1 : 2;
        history.push(i);
      }
    }
    const almostFull: GomokuState = {
      board, history, current: 1, status: 'playing', winner: 0, line: [],
    };
    const full = place(almostFull, idx(SIZE - 1, SIZE - 1));
    expect(full.status).toBe('draw');
    expect(full.winner).toBe(0);
    expect(full.history).toHaveLength(CELLS);
  });
});
