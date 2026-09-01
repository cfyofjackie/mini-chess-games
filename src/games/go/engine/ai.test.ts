// 围棋吃子教学 AI 测试（docs/games/go.md 第三节 + 第四节 AI 项）：
// 合法落点、1 气群必提必救、打吃、避免自填眼、确定性、AI 自弈 / 对随机对局强度。
import { describe, expect, it } from 'vitest';
import {
  CELLS,
  SIZE,
  type GoState,
  type Player,
  confirmScoring,
  groupAt,
  groupsOf,
  initialState,
  legalMoves,
  pass,
  place,
  undo,
} from './go';
import { chooseMove } from './ai';

const idx = (r: number, c: number) => r * SIZE + c;

/** 按字符画（B 黑 / W 白 / . 空）构造任意局面 */
function fromBoard(rows: string[], current: Player = 1): GoState {
  if (rows.length !== SIZE || rows.some((row) => row.length !== SIZE)) throw new Error('bad rows');
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
    lastMove: -1,
    koPoint: -1,
    captures: [0, 0],
    passes: 0,
    dead: [],
    result: null,
  };
}

const EMPTY_ROWS = Array.from({ length: SIZE }, () => '.'.repeat(SIZE));

/** AI 策略适配：chooseMove 返回对象，playout 需要"步数或 -1" */
const aiMove = (s: GoState): number => chooseMove(s).move;

/** 可播种的确定性伪随机（mulberry32），保证随机对局测试完全可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 白方随机策略：15% 概率虚着，否则均匀随机选合法点 */
function randomWhite(rand: () => number) {
  return (s: GoState): number => {
    const ms = legalMoves(s);
    if (ms.length === 0) return -1;
    if (rand() < 0.15) return -1;
    return ms[Math.floor(rand() * ms.length)];
  };
}

/** 双方各按策略走到标记模式为止；任何被引擎拒绝的着法直接抛错 */
function playout(black: (s: GoState) => number, white: (s: GoState) => number, maxPlies = 300) {
  let s = initialState();
  const moves: number[] = [];
  while (s.status === 'playing') {
    if (moves.length >= maxPlies) throw new Error('playout did not terminate');
    const mv = s.current === 1 ? black(s) : white(s);
    if (mv < 0) s = pass(s);
    else {
      const next = place(s, mv);
      if (next === s) throw new Error(`illegal move proposed: ${mv}`);
      s = next;
    }
    moves.push(mv);
  }
  return { final: s, plies: moves.length, moves };
}

describe('go AI 落点合法性与开局取向', () => {
  it('AI 落子必为合法点（空盘 / 中盘局面），终局返回 -1', () => {
    const positions: GoState[] = [
      fromBoard(EMPTY_ROWS, 2),
      fromBoard(
        [
          '.........',
          '.........',
          '.........',
          '...B.....',
          '....BW...',
          '.....W...',
          '.........',
          '.........',
          '.........',
        ],
        2,
      ),
    ];
    for (const s of positions) {
      const { move } = chooseMove(s);
      expect(move).toBeGreaterThanOrEqual(0);
      expect(legalMoves(s)).toContain(move);
      const after = place(s, move);
      expect(after).not.toBe(s);
    }
    // 终局后不再求解
    const over = pass(pass(initialState()));
    expect(over.status).toBe('marking');
    expect(chooseMove(over).move).toBe(-1);
  });

  it('空盘首步取向三四线（到边线路数 ≥2），不占一二线', () => {
    const { move } = chooseMove(fromBoard(EMPTY_ROWS, 1));
    const r = Math.floor(move / SIZE);
    const c = move % SIZE;
    const edgeDist = Math.min(r, c, SIZE - 1 - r, SIZE - 1 - c);
    expect(edgeDist).toBeGreaterThanOrEqual(2);
  });
});

describe('go AI 抓吃与救子（教学优先级）', () => {
  it('对方 1 气单子必提（精确落在提点上）', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....B....',
        '....WB...',
        '....B....',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 3)]);
    expect(chooseMove(s).move).toBe(idx(4, 3));
  });

  it('对方 1 气多子群必提（整群提点）', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....BB...',
        '....WWB..',
        '....BB...',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 3)]);
    expect(chooseMove(s).move).toBe(idx(4, 3));
  });

  it('己方 1 气群必救：无子可提时精确长出（延到 ≥2 气）', () => {
    // 黑 (4,4)(4,5) 仅剩气 (4,6)；向 (4,6) 长出后得 3 气
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....WW...',
        '...WBB...',
        '....WW...',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 6)]);
    const { move } = chooseMove(s);
    expect(move).toBe(idx(4, 6));
    const after = place(s, move);
    expect(groupAt(after.board, idx(4, 4)).liberties.length).toBeGreaterThanOrEqual(2);
  });

  it('救大优先于提小：3 子 1 气群的救回优先于提对方 1 子', () => {
    // 黑三子 (4,4)(4,5)(4,6) 仅剩气 (4,7)（救 = 40k×3）；白孤子 (0,1) 仅剩气 (0,0)（提 = 100k）
    const s = fromBoard(
      [
        '.WB......',
        '.B.......',
        '.........',
        '....WWW..',
        '...WBBB..',
        '....WWW..',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 5)).liberties).toEqual([idx(4, 7)]);
    expect(groupAt(s.board, idx(0, 1)).liberties).toEqual([idx(0, 0)]);
    expect(chooseMove(s).move).toBe(idx(4, 7));
  });

  it('无抓吃无救子时会对对方 2 气群打吃（落子后其气数 = 1）', () => {
    // 白孤子 (4,4) 恰两口气 (4,3)(5,4)，黑从任一口打吃
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....B....',
        '....WB...',
        '.........',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 4)).liberties.length).toBe(2);
    const { move } = chooseMove(s);
    const after = place(s, move);
    expect(groupAt(after.board, idx(4, 4)).liberties.length).toBe(1);
  });
});

describe('go AI 避免恶手', () => {
  it('不填自己的眼（有其他选择时绕开眼位）', () => {
    // 黑围绕 (4,4) 做成一眼；右侧与下方另有白子，AI 应扩张而不填眼
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....B....',
        '...BBBW..',
        '....B....',
        '.........',
        '......WW.',
        '.........',
      ],
      1,
    );
    const { move } = chooseMove(s);
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).not.toBe(idx(4, 4));
    expect(s.board[move]).toBe(0);
  });

  it('剩余着法全是填眼 / 自撞气时宁可直接虚着', () => {
    // 满盘黑棋仅留三个互不相邻的眼位空点：任何落子都是填眼 → 虚着
    const rows: string[] = [];
    for (let r = 0; r < SIZE; r++) {
      let row = '';
      for (let c = 0; c < SIZE; c++) {
        row += (r === 2 && c === 2) || (r === 4 && c === 4) || (r === 6 && c === 6) ? '.' : 'B';
      }
      rows.push(row);
    }
    const s = fromBoard(rows, 1);
    expect(legalMoves(s).length).toBeGreaterThan(0);
    expect(chooseMove(s).move).toBe(-1);
  });

  it('不做无补偿的自撞一气（有安全着法时不选 1 气孤子点）', () => {
    // 边线 (4,0)：上邻 (3,0)、右邻 (4,1) 皆白，下邻 (5,0) 空——落子即成 1 气孤子
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        'W........',
        '.W.......',
        '.........',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    const { move } = chooseMove(s);
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).not.toBe(idx(4, 0));
    // 落子后确认该点确为 1 气位（测试前提自检：合法但属恶手）
    const probe = place(s, idx(4, 0));
    expect(groupAt(probe.board, idx(4, 0)).liberties).toEqual([idx(5, 0)]);
  });
});

describe('go AI 确定性与对局能力', () => {
  it('确定性：同一局面两次求解结果一致（含对方已虚着的局面）', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '...W.....',
        '...BW....',
        '....B....',
        '.....W...',
        '.........',
        '.........',
        '.........',
      ],
      2,
    );
    expect(chooseMove(s)).toEqual(chooseMove(s));
    const passed = pass(s);
    expect(chooseMove(passed)).toEqual(chooseMove(passed));
  });

  it('AI 自弈：整局合法、300 手内双虚着进入标记模式，过程完全可复现', () => {
    const a = playout(aiMove, aiMove);
    const b = playout(aiMove, aiMove);
    expect(a.final.status).toBe('marking');
    expect(a.plies).toBeLessThanOrEqual(300);
    expect(a.moves).toEqual(b.moves);
    expect(a.final.board).toEqual(b.final.board);
    // 数子闭环：确认后出结果
    const done = confirmScoring(a.final);
    expect(done.status).toBe('done');
    expect(done.result).not.toBeNull();
    // 悔棋穿透验证：从终局连悔到底回到空盘
    let s: GoState = done;
    while (s.history.length > 0) s = undo(s);
    expect(s.history).toHaveLength(0);
    expect(s.board.every((v) => v === 0)).toBe(true);
    expect(groupsOf(s.board, 1)).toHaveLength(0);
  });

  it('AI（黑）对随机（白）：每手合法、提子更多，标记死棋后计分获胜（5 个种子）', () => {
    let aiWins = 0;
    let aiCaptures = 0;
    let randomCaptures = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { final } = playout(aiMove, randomWhite(mulberry32(seed)));
      expect(final.status).toBe('marking');
      aiCaptures += final.captures[0];
      randomCaptures += final.captures[1];
      // 收官口径：终局时仅剩 ≤1 气的白群判死（随机方无力做活的残子大多如此）
      let marking = final;
      for (const g of groupsOf(marking.board, 2)) {
        if (g.liberties.length <= 1) {
          marking = { ...marking, dead: [...marking.dead, ...g.stones] };
        }
      }
      const done = confirmScoring(marking);
      if (done.result && done.result.winner === 1) aiWins++;
    }
    expect(aiWins).toBeGreaterThanOrEqual(4); // 5 局至少胜 4
    expect(aiCaptures).toBeGreaterThan(randomCaptures); // 抓吃能力显著优于随机
  });
});
