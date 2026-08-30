// AI 引擎测试：直接测 engine/ai.ts（docs/games/gomoku.md 第一节测试清单）
// 覆盖：合法空点、成五必落（三档）、成五必堵（三档）、困难档堵活三成四点、
// 空盘首步近天元、确定性（同局面两次求解同结果）。
import { describe, expect, it } from 'vitest';
import { CELLS, SIZE, GomokuState, Player, initialState, place } from './gomoku';
import { chooseMove, type Difficulty } from './ai';

const idx = (r: number, c: number) => r * SIZE + c;
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/** 按棋盘字符画（B 黑 / W 白 / . 空）构造任意局面（默认白方行棋 = AI 视角） */
function fromBoard(rows: string[], current: Player = 2): GomokuState {
  const board = new Int8Array(CELLS);
  rows.forEach((row, r) => {
    for (let c = 0; c < SIZE; c++) {
      const ch = row.charAt(c);
      board[idx(r, c)] = ch === 'B' ? 1 : ch === 'W' ? 2 : 0;
    }
  });
  return { board, history: [], current, status: 'playing', winner: 0, line: [] };
}

/** 黑白交替落子（黑先）构造真实对局局面 */
function play(...cells: Array<[number, number]>): GomokuState {
  let s = initialState();
  for (const [r, c] of cells) s = place(s, idx(r, c));
  return s;
}

describe('gomoku AI', () => {
  it('AI 落子必为空点且合法；终局时返回 -1', () => {
    // 开局（黑白各一子）与中盘局面，白方行棋：三档输出都必须是合法空点
    const positions: GomokuState[] = [
      fromBoard([
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '.......B.W.....',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
      ]),
      fromBoard([
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
        '......W........',
        '...............',
        '.......BW......',
        '........W.B....',
        '.........B.....',
        '...............',
        '...............',
        '...............',
        '...............',
        '...............',
      ]),
    ];
    for (const s of positions) {
      for (const d of DIFFICULTIES) {
        const { move } = chooseMove(s, d);
        expect(move).toBeGreaterThanOrEqual(0);
        expect(move).toBeLessThan(CELLS);
        expect(s.board[move]).toBe(0); // 空点
        const after = place(s, move); // 引擎接受 = 合法
        expect(after.history).toHaveLength(1);
        expect(after.status).toBe('playing');
      }
    }

    // 终局（白已五连获胜）后不再求解
    const won = play([8, 3], [7, 3], [8, 4], [7, 4], [8, 5], [7, 5], [8, 6], [7, 6], [9, 9], [7, 7]);
    expect(won.status).toBe('won');
    expect(won.winner).toBe(2);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(won, d).move).toBe(-1);
    }
  });

  it('己方四连成五点必落（三档难度）', () => {
    // 白四连 (7,4..7)，两端皆空 → 成五点 (7,3)/(7,8)；黑子远离、无威胁
    const bothEnds = fromBoard([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '....WWWW.......',
      '...............',
      '..B.....B......',
      '.......B.......',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    const fivePoints = [idx(7, 3), idx(7, 8)];
    for (const d of DIFFICULTIES) {
      expect(fivePoints).toContain(chooseMove(bothEnds, d).move);
    }

    // 左端 (7,3) 已被黑堵死 → 唯一成五点 (7,8)，三档都必须精确落在那里
    const oneEnd = fromBoard([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...BWWWW.......',
      '...............',
      '..B.....B......',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(oneEnd, d).move).toBe(idx(7, 8));
    }
  });

  it('对方四连成五点必堵（三档难度）', () => {
    // 黑四连 (7,4..7)，白方行棋必堵 (7,3)/(7,8)（白子远离、无更高优先级目标）
    const bothEnds = fromBoard([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '....BBBB.......',
      '...............',
      '...WWW.........',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    const defenses = [idx(7, 3), idx(7, 8)];
    for (const d of DIFFICULTIES) {
      expect(defenses).toContain(chooseMove(bothEnds, d).move);
    }

    // 右端 (7,8) 已被白占 → 黑唯一成五点 (7,3)，三档都必须精确堵住
    const oneEnd = fromBoard([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '....BBBBW......',
      '...............',
      '...WWW.........',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(oneEnd, d).move).toBe(idx(7, 3));
    }
  });

  it('对方活三存在且无更高优先级目标时，困难档必堵其成四点', () => {
    // 黑活三 (7,6..8)，两端开阔；白子远离且无四/活四机会
    // 黑的成四点 = 两端延伸 (7,5)/(7,9)（延伸后成活四）
    const s = fromBoard([
      '...............',
      '...............',
      '...............',
      '..W............',
      '...............',
      '...............',
      '...............',
      '......BBB......',
      '...............',
      '...............',
      '...............',
      '...........W...',
      '...............',
      '...............',
      '...............',
    ]);
    const fourPoints = [idx(7, 5), idx(7, 9)];
    expect(fourPoints).toContain(chooseMove(s, 'hard').move);
  });

  it('空盘开局 AI 首步落在天元附近（切比雪夫距离 ≤2）', () => {
    const empty = fromBoard(
      Array.from({ length: SIZE }, () => '.'.repeat(SIZE)),
    );
    for (const d of DIFFICULTIES) {
      const { move } = chooseMove(empty, d);
      expect(move).toBeGreaterThanOrEqual(0);
      const r = Math.floor(move / SIZE);
      const c = move % SIZE;
      expect(Math.max(Math.abs(r - 7), Math.abs(c - 7))).toBeLessThanOrEqual(2);
    }
  });

  it('确定性：同一局面两次求解步与节点数完全一致', () => {
    // 中盘局面（黑白各三子交错，白方行棋）
    const s = fromBoard([
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
      '.....W.........',
      '.......BW......',
      '......W.B......',
      '........B......',
      '...............',
      '...............',
      '...............',
      '...............',
      '...............',
    ]);
    for (const d of DIFFICULTIES) {
      const a = chooseMove(s, d);
      const b = chooseMove(s, d);
      expect(a.move).toBe(b.move);
      expect(a.nodes).toBe(b.nodes); // 节点数一致 ⇒ 搜索过程完全可复现
      expect(a.move).toBeGreaterThanOrEqual(0);
      expect(s.board[a.move]).toBe(0);
    }
  });
});
