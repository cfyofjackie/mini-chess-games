// 复盘分析器测试（docs/games/chess.md 第八节测试清单，验收核心）：
// 1. 一步杀对局：制胜手标 🟢 最佳，曲线终局达将死分；
// 2. 送后陷阱：送后手标 🔴 大错，原因含"丢后"；
// 3. 平稳开局序列（意大利开局前 6 步）：无 🔴，多为 🟢/⚪；
// 4. 曲线数据点数 = 手数 + 1；
// 5. 被吃子原因文案正确（丢马 / 丢兵）。
// 附加：extractMoves 与 analyzeGame 的往返（Game 页复盘入口的生产路径）、非法着法拒绝。
// 棋子编码速查：1兵 2马 3象 4车 5后 6王 / 8兵 9马 10象 11车 12后 13王
import { describe, expect, it } from 'vitest';
import { MATE_SCORE } from './ai';
import {
  analyzeGame,
  extractMoves,
  GRADE_THRESHOLDS,
  type AnalysisMoveInput,
} from './analysis';
import { fromAlgebraic, initialState, makeMove, position } from './chess';

const S = (sq: string) => fromAlgebraic(sq);
const mv = (f: string, t: string, promotion?: 'q' | 'r' | 'b' | 'n'): AnalysisMoveInput => ({
  from: S(f),
  to: S(t),
  ...(promotion ? { promotion } : {}),
});

describe('chess analysis（复盘报告 v1）', () => {
  it('1. 一步杀对局：制胜手标 🟢 最佳，曲线终局达到将死分', () => {
    // 底线将杀局面（黑先）：黑车 a8→a1#（同 ai.test.ts 场景 A）
    const seed = position(
      [['g1', 'K'], ['f2', 'P'], ['g2', 'P'], ['h2', 'P'], ['a8', 'r'], ['g8', 'k']],
      { current: 2 },
    );
    const report = analyzeGame(seed, [mv('a8', 'a1')]);
    expect(report.moves).toHaveLength(1);
    expect(report.moves[0].grade).toBe('best');
    expect(report.moves[0].reason).toContain('将死');
    // 曲线：白方视角，终局为黑胜将死分；走前白方也已在搜索视野内必败
    expect(report.curve).toHaveLength(2);
    expect(report.curve[1]).toBe(-MATE_SCORE);
    expect(report.curve[0]).toBeLessThanOrEqual(-MATE_SCORE + 256);
  });

  it('2. 送后陷阱对局：送后那手被标 🔴 大错，原因含"丢后"', () => {
    // 黑后 d6 吃 e5 兵，但该兵有 d4 兵保护：Qxe5?? dxe5 白送整个后（同 ai.test.ts 测试 4 局面）
    const seed = position(
      [['e1', 'K'], ['e5', 'P'], ['d4', 'P'], ['e2', 'P'], ['g1', 'N'], ['e8', 'k'], ['d6', 'q']],
      { current: 2 },
    );
    const report = analyzeGame(seed, [mv('d6', 'e5')]);
    expect(report.moves[0].grade).toBe('blunder');
    expect(report.moves[0].reason).toContain('丢后');
    expect(report.moves[0].reason).toContain('白兵'); // 被谁吃
    expect(report.moves[0].loss).toBeGreaterThanOrEqual(GRADE_THRESHOLDS.mistake);
  });

  it('3. 平稳开局序列（意大利开局前 6 步）：无 🔴，多为 🟢/⚪', () => {
    const report = analyzeGame(
      initialState(),
      [mv('e2', 'e4'), mv('e7', 'e5'), mv('g1', 'f3'), mv('b8', 'c6'), mv('f1', 'c4'), mv('g8', 'f6')],
    );
    expect(report.moves.every((m) => m.grade !== 'blunder')).toBe(true);
    const calm = report.moves.filter((m) => m.grade === 'best' || m.grade === 'good').length;
    expect(calm).toBeGreaterThanOrEqual(4);
  });

  it('4. Report 曲线数据点数 = 手数 + 1', () => {
    const report = analyzeGame(initialState(), [mv('e2', 'e4'), mv('e7', 'e5')]);
    expect(report.moves).toHaveLength(2);
    expect(report.curve).toHaveLength(3);
  });

  it('5. 被吃子原因文案正确：丢马 / 丢兵', () => {
    // 丢马：白马 d4→c6?? 直入黑兵 b7 口（bxc6 吃马）—— 大子级损失 🔴
    const horse = position([['e1', 'K'], ['d4', 'N'], ['e8', 'k'], ['b7', 'p'], ['c7', 'p']], {
      current: 1,
    });
    const r1 = analyzeGame(horse, [mv('d4', 'c6')]);
    expect(r1.moves[0].grade).toBe('blunder');
    expect(r1.moves[0].reason).toContain('丢马');

    // 丢兵：白 d5 兵受黑 e6 兵攻击且无保护，白却走 h2-h3 无视—— exd5 吃兵，兵级损失 🟡
    const pawn = position([['e1', 'K'], ['d5', 'P'], ['h2', 'P'], ['e8', 'k'], ['e6', 'p'], ['a7', 'p']], {
      current: 1,
    });
    const r2 = analyzeGame(pawn, [mv('h2', 'h3')]);
    expect(r2.moves[0].grade).toBe('mistake');
    expect(r2.moves[0].reason).toContain('丢兵');
  });

  it('6. extractMoves 往返：真实对局（含升变）提取的着法可直接重放分析', () => {
    // 普通着法提取与手工列表一致
    let s = initialState();
    for (const [f, t] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']] as const) {
      s = makeMove(s, S(f), S(t));
    }
    expect(extractMoves(s)).toEqual([
      mv('e2', 'e4'),
      mv('e7', 'e5'),
      mv('g1', 'f3'),
      mv('b8', 'c6'),
    ]);

    // 升变局：b7-b8 必须显式升变，提取反查升变子 = 'q'
    const promoSeed = position([['f1', 'K'], ['b7', 'P'], ['h8', 'k'], ['h7', 'p']], { current: 1 });
    const promoted = makeMove(promoSeed, S('b7'), S('b8'), 'q');
    expect(promoted).not.toBe(promoSeed);
    expect(extractMoves(promoted)).toEqual([mv('b7', 'b8', 'q')]);
    // 往返：提取的着法可被 analyzeGame 重放（不抛错，手数一致）
    const report = analyzeGame(promoSeed, extractMoves(promoted));
    expect(report.moves).toHaveLength(1);
  });

  it('7. 非法着法拒绝：analyzeGame 抛错（复盘输入只应来自真实对局）', () => {
    expect(() => analyzeGame(initialState(), [mv('e2', 'e5')])).toThrow();
  });
});
