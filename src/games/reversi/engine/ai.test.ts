// AI 引擎测试：直接测 engine/ai.ts（规格书第四节测试清单）
// 覆盖：合法步、有角必占、回避 X 位、开局不送角、必胜残局精确穷举、三档强弱行为、确定性。
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
} from './reversi';
import { ENDGAME_EMPTY_THRESHOLD, chooseMove, solveEndgame, type Difficulty } from './ai';

const idx = (r: number, c: number) => r * SIZE + c;
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
const CORNERS = [idx(0, 0), idx(0, 7), idx(7, 0), idx(7, 7)];
const X_SQUARES = [idx(1, 1), idx(1, 6), idx(6, 1), idx(6, 6)];
/** X 位与其斜邻角的对应关系：己方已占邻角时 X 位不再危险 */
const X_ADJACENT_CORNER: Record<number, number> = {
  [idx(1, 1)]: idx(0, 0),
  [idx(1, 6)]: idx(0, 7),
  [idx(6, 1)]: idx(7, 0),
  [idx(6, 6)]: idx(7, 7),
};

/** 按棋盘字符画（B 黑 / W 白 / . 空）构造任意局面 */
function fromBoard(rows: string[], current: Player = 2): ReversiState {
  const board = new Int8Array(CELLS);
  rows.forEach((row, r) => {
    for (let c = 0; c < SIZE; c++) {
      const ch = row.charAt(c);
      board[idx(r, c)] = ch === 'B' ? 1 : ch === 'W' ? 2 : 0;
    }
  });
  return { board, history: [], current, status: 'playing', winner: 0, lastMove: -1, flipped: [], passedBy: 0 };
}

/** 确定性自对弈（AI 引擎无随机，因此同参数必然走出同一条对局） */
function selfPlay(difficulty: Difficulty, maxPlies: number): ReversiState[] {
  const line: ReversiState[] = [initialState()];
  for (let ply = 0; ply < maxPlies && line[line.length - 1].status === 'playing'; ply++) {
    const s = line[line.length - 1];
    const { move } = chooseMove(s, difficulty);
    if (move < 0) break;
    line.push(place(s, move));
  }
  return line;
}

/**
 * 交叉验证 oracle（独立于 ai.ts）：只依赖阶段一引擎的 place/legalMoves，
 * 返回"白子数 − 黑子数"在双方最优下法下的精确终局值。
 */
function oracleValue(state: ReversiState): number {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    const opp: Player = state.current === 1 ? 2 : 1;
    const oppState = { ...state, current: opp };
    if (legalMoves(oppState).length === 0) {
      const { black, white } = discCounts(state.board);
      return white - black;
    }
    return oracleValue(oppState);
  }
  const values = moves.map((m) => oracleValue(place(state, m)));
  return state.current === 2 ? Math.max(...values) : Math.min(...values);
}

describe('reversi AI', () => {
  it('AI 输出必为当前合法步；无合法步 / 终局时返回 -1', () => {
    // 黑先初始局面、白方回合、中盘白方回合：三档难度的输出都必须在合法步集合内
    const states: ReversiState[] = [
      initialState(),
      place(initialState(), idx(2, 3)), // 白方回合
      selfPlay('medium', 9)[9], // 中盘（黑白双方各若干手）
    ];
    for (const s of states) {
      const legal = legalMoves(s);
      expect(legal.length).toBeGreaterThan(0);
      for (const d of DIFFICULTIES) {
        const { move } = chooseMove(s, d);
        expect(legal).toContain(move);
      }
    }

    // 棋盘上只有黑子：白方无任何合法步 → 三档都返回 -1 而不是非法步
    const noMoves = fromBoard(['........', '........', '........', '..BBB...', '........', '........', '........', '........']);
    expect(legalMoves(noMoves)).toEqual([]);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(noMoves, d).move).toBe(-1);
    }

    // 终局后不再求解
    const p0 = fromBoard(
      ['BBBW.WW.', '........', '........', '...W....', '...B....', '...B....', '...B....', '...B....'],
      1,
    );
    const over = place(place(place(p0, idx(0, 4)), idx(2, 3)), idx(0, 7));
    expect(over.status).toBe('won');
    for (const d of DIFFICULTIES) {
      expect(chooseMove(over, d).move).toBe(-1);
    }
  });

  it('可吃角时必选角：三档难度都占 (0,0)（且该角同时是贪心翻子最多步）', () => {
    // 存在安静替代步（(3,2)/(5,2) 各翻 1 子）的情况下，占角翻 3 子 + 角 +100
    // 对三档难度（含困难档深度 4 搜索）都仍是明确最优
    const s = fromBoard([
      '.BWWWBW.',
      'B.....WW',
      'B.W.....',
      'W.......',
      'BB......',
      'W.......',
      '........',
      '........',
    ]);
    const legal = legalMoves(s);
    expect(legal).toContain(idx(0, 0));
    // 占角是翻子最多步（3 子），简单档的贪心策略也必然选它
    const flipsOf = (m: number) => place(s, m).flipped.length;
    expect(flipsOf(idx(0, 0))).toBe(3);
    expect(flipsOf(idx(3, 2))).toBe(1);
    expect(flipsOf(idx(5, 2))).toBe(1);
    for (const d of DIFFICULTIES) {
      expect(chooseMove(s, d).move).toBe(idx(0, 0));
    }
  });

  it('存在其他选择时不落 X 位：三档难度都回避 (1,1)', () => {
    // X 位 (1,1)（角斜邻）可下但只翻 1 子；(5,3) 可下且翻 2 子
    const s = fromBoard([
      '........',
      '..BW....',
      '........',
      '........',
      '........',
      '....BBW.',
      '........',
      '........',
    ]);
    const legal = legalMoves(s);
    expect(legal).toContain(idx(1, 1)); // X 位确实是可选步之一
    expect(legal.length).toBeGreaterThan(1); // 且存在其他选择
    for (const d of DIFFICULTIES) {
      const { move } = chooseMove(s, d);
      expect(legal).toContain(move);
      expect(move).not.toBe(idx(1, 1));
    }
  });

  it('三档强弱行为：简单档贪心翻子会踩 X 位陷阱，中等/困难档凭位置权重避开', () => {
    // X 位 (1,1) 翻 2 子（贪心最优），(4,4) 只翻 1 子但不吃 X 位
    const s = fromBoard([
      '........',
      '..BBW...',
      '........',
      '........',
      '........',
      '....B...',
      '....W...',
      '........',
    ]);
    expect(legalMoves(s)).toEqual([idx(1, 1), idx(4, 4)]);
    expect(chooseMove(s, 'easy').move).toBe(idx(1, 1)); // 贪心：翻子最多
    expect(chooseMove(s, 'medium').move).toBe(idx(4, 4)); // 位置权重：X 位 -25
    expect(chooseMove(s, 'hard').move).toBe(idx(4, 4));
  });

  it('中等/困难档在标准开局序列（自对弈前 20 手）内：有角必占、无角可用时不落 X 位', () => {
    for (const d of ['medium', 'hard'] as const) {
      let s = initialState();
      for (let ply = 0; ply < 20 && s.status === 'playing'; ply++) {
        const legal = legalMoves(s);
        expect(legal.length).toBeGreaterThan(0);
        const { move } = chooseMove(s, d);
        expect(legal).toContain(move);
        // 有角必占：只要有角可下就必须占（无论轮到哪一方）
        const corners = legal.filter((m) => CORNERS.includes(m));
        if (corners.length > 0) expect(corners).toContain(move);
        // 回避 X 位：除非 X 位是唯一合法步，或其邻角已被己方占据（此时 X 位无害）
        if (X_SQUARES.includes(move) && legal.length > 1) {
          expect(s.board[X_ADJACENT_CORNER[move]]).toBe(s.current);
        }
        s = place(s, move);
      }
    }
  });

  it('必胜残局：困难档精确穷举找到唯一制胜手（与独立 oracle 交叉验证）', () => {
    // 7 空格残局：白先手，最优终局子差 +4（白胜），且唯一制胜首步是 idx(0,2)
    const s7 = fromBoard([
      '.B.WWWWB',
      '..BBBWB.',
      'WWBBWBWB',
      'WWWWBBWW',
      'WWWWWBBW',
      'WWBWWWBW',
      'W.WWWWWW',
      '.WWWWWBW',
    ]);
    const empties7 = s7.board.filter((v) => v === 0).length;
    expect(empties7).toBeLessThanOrEqual(ENDGAME_EMPTY_THRESHOLD);
    const value7 = oracleValue(s7);
    expect(value7).toBeGreaterThan(0); // 前提：白方必胜
    const winning7 = legalMoves(s7).filter((m) => oracleValue(place(s7, m)) === value7);
    expect(winning7).toEqual([idx(0, 2)]); // 唯一制胜手
    // 困难档精确穷举：既选中制胜手，求解值与 oracle 一致
    expect(chooseMove(s7, 'hard').move).toBe(idx(0, 2));
    expect(solveEndgame(s7)).toEqual({ move: idx(0, 2), value: value7, exact: true, nodes: expect.any(Number) });

    // 5 空格残局：白先手必胜 +4，唯一制胜首步是 idx(6,1)
    const s5 = fromBoard([
      '.BWWWWWB',
      '..WWBWBB',
      'WWWBWBBB',
      'WWWWBBWW',
      'WWWWWBBW',
      'WWBWWWBW',
      'W.WWWWWW',
      '.WWWWWBW',
    ]);
    const value5 = oracleValue(s5);
    expect(value5).toBeGreaterThan(0);
    const winning5 = legalMoves(s5).filter((m) => oracleValue(place(s5, m)) === value5);
    expect(winning5).toEqual([idx(6, 1)]);
    expect(chooseMove(s5, 'hard').move).toBe(idx(6, 1));
    expect(solveEndgame(s5)).toEqual({ move: idx(6, 1), value: value5, exact: true, nodes: expect.any(Number) });
  });

  it('确定性：同一局面重复求解，三档难度的步与节点数完全一致', () => {
    const s = selfPlay('hard', 8)[8]; // 中盘局面（自对弈本身也是确定的）
    for (const d of DIFFICULTIES) {
      const a = chooseMove(s, d);
      const b = chooseMove(s, d);
      expect(a.move).toBe(b.move);
      expect(a.nodes).toBe(b.nodes); // 节点数一致 ⇒ 搜索过程完全可复现
      expect(a.move).toBeGreaterThanOrEqual(0);
    }
  });
});
