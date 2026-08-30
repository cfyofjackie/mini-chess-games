// 教练模式 v1 引擎测试（docs/games/chess.md 第十节测试清单第 1 条，验收核心）：
// gradeMove 纯函数分级 —— 送后局面 → ❌+丢后；一步杀局面走出杀 → 🌟；有一步杀不走 →
// ❌ 错过绝杀；平稳开局 → ✅。附：拦截预评估预算（≤1.5s 墙钟，与 COACH_EVAL_TIMEOUT_MS 对齐）、
// 提示阶梯文字与高亮、拦截卡文案、确定性。
// 棋子编码速查：1兵 2马 3象 4车 5后 6王 / 8兵 9马 10象 11车 12后 13王
import { describe, expect, it } from 'vitest';
import { fromAlgebraic, initialState, makeMove, position } from './chess';
import { MATE_WIN } from './ai';
import {
  COACH_EVAL_TIMEOUT_MS,
  gradeMove,
  hintHighlight,
  hintText,
  interceptMessage,
} from './coach';
import { GRADE_THRESHOLDS } from './judge';

const S = (sq: string) => fromAlgebraic(sq);

describe('chess coach gradeMove（教练分级，规格书第十节清单 1）', () => {
  it('1. 送后局面 → ❌ 大错 + 原因含"丢后"', () => {
    // 白后 d3 吃 e4 兵，但该兵有 d5 兵保护：Qxe4?? dxe4 白送整个后（analysis 测试 2 的镜像局面）
    const seed = position(
      [['e1', 'K'], ['d3', 'Q'], ['e4', 'p'], ['d5', 'p'], ['e8', 'k']],
      { current: 1 },
    );
    const v = gradeMove(seed, { from: S('d3'), to: S('e4') });
    expect(v.grade).toBe('blunder');
    expect(v.reason).toContain('丢后');
    expect(v.reason).toContain('黑兵'); // 被谁吃
    expect(v.loss).toBeGreaterThan(GRADE_THRESHOLDS.mistake);
  });

  it('2. 一步杀局面走出杀 → 🌟 最佳（关键局面将杀特判）', () => {
    // 底线将杀：白车 a1→a8#（黑王 g8 被 f7/g7/h7 三兵自堵）
    const seed = position(
      [['g1', 'K'], ['a1', 'R'], ['g2', 'P'], ['h2', 'P'], ['f7', 'p'], ['g7', 'p'], ['h7', 'p'], ['g8', 'k']],
      { current: 1 },
    );
    const v = gradeMove(seed, { from: S('a1'), to: S('a8') });
    expect(v.grade).toBe('best');
    expect(v.reason).toContain('将死');
    expect(v.playerValue).toBeGreaterThanOrEqual(MATE_WIN); // 行棋方视角已见必胜将杀
  });

  it('3. 有一步杀不走 → ❌ 大错 + 原因含"错过绝杀"', () => {
    // 同上局面改走 Ra1-b1：放过一步杀（引擎走前分值 ≥ MATE_WIN）
    const seed = position(
      [['g1', 'K'], ['a1', 'R'], ['g2', 'P'], ['h2', 'P'], ['f7', 'p'], ['g7', 'p'], ['h7', 'p'], ['g8', 'k']],
      { current: 1 },
    );
    const v = gradeMove(seed, { from: S('a1'), to: S('b1') });
    expect(v.grade).toBe('blunder');
    expect(v.reason).toContain('错过绝杀');
    expect(v.bestScore).toBeGreaterThanOrEqual(MATE_WIN);
    expect(v.best).toEqual({ from: S('a1'), to: S('a8') }); // 引擎首选即那步杀
  });

  it('4. 平稳开局（1.Nf3）→ ✅ 好棋', () => {
    // 固定参数（medium 深度 3 + COACH 节点预算）下确定性：Nf3 损失落在好棋档
    const v = gradeMove(initialState(), { from: S('g1'), to: S('f3') });
    expect(v.grade).toBe('good');
    expect(v.loss).toBeGreaterThan(GRADE_THRESHOLDS.best);
    expect(v.loss).toBeLessThanOrEqual(GRADE_THRESHOLDS.good);
    expect(v.reason).toBe('平稳：小幅损失');
  });

  it('5. 拦截预评估预算：复杂局面单次评估 ≤1.5s 墙钟（等待期上限，规格书第十节）', () => {
    // 意大利开局 6 步后的中局：走前 + 走后两次搜索合计须在拦截等待预算内
    const mid = makeMove(
      makeMove(
        makeMove(
          makeMove(
            makeMove(makeMove(initialState(), S('e2'), S('e4')), S('e7'), S('e5')),
            S('g1'),
            S('f3'),
          ),
          S('b8'),
          S('c6'),
        ),
        S('f1'),
        S('c4'),
      ),
      S('g8'),
      S('f6'),
    );
    const t0 = performance.now();
    const v = gradeMove(mid, { from: S('f3'), to: S('g5') });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(COACH_EVAL_TIMEOUT_MS);
    expect(v.best).not.toBeNull();
  });

  it('6. 确定性：同一局面同一着法两次评估结论完全一致', () => {
    const seed = position(
      [['e1', 'K'], ['d3', 'Q'], ['e4', 'p'], ['d5', 'p'], ['e8', 'k']],
      { current: 1 },
    );
    const a = gradeMove(seed, { from: S('d3'), to: S('e4') });
    const b = gradeMove(seed, { from: S('d3'), to: S('e4') });
    expect(b).toEqual(a);
  });

  it('7. 非法着法拒绝：gradeMove 抛错（评语输入只应来自合法落点）', () => {
    expect(() => gradeMove(initialState(), { from: S('e2'), to: S('e5') })).toThrow();
  });
});

describe('chess coach 提示阶梯与拦截卡文案（引擎侧纯函数）', () => {
  it('hintText：一步杀局面报"有一步将杀机会"；平稳开局报出子', () => {
    const mate = position(
      [['g1', 'K'], ['a1', 'R'], ['g2', 'P'], ['h2', 'P'], ['f7', 'p'], ['g7', 'p'], ['h7', 'p'], ['g8', 'k']],
      { current: 1 },
    );
    const verdict = gradeMove(mate, { from: S('a1'), to: S('b1') }); // 借走前搜索求最优分
    expect(verdict.best).toEqual({ from: S('a1'), to: S('a8') });
    expect(hintText(mate, verdict.best, verdict.bestScore)).toBe('有一步将杀机会');
    expect(hintText(initialState(), { from: S('g1'), to: S('f3') }, 50)).toBe(
      '向中心发展出子，注意王的安全',
    );
  });

  it('hintText：己方无保护子被捉优先提醒（象）', () => {
    // 白象 c4 被黑 b5 兵攻击且无保护；无将杀机会、不被将军 → "注意你的象被捉"
    const s = position([['e1', 'K'], ['c4', 'B'], ['a2', 'P'], ['e8', 'k'], ['b5', 'p'], ['a7', 'p']], {
      current: 1,
    });
    const text = hintText(s, { from: S('a2'), to: S('a4') }, 0);
    expect(text).toBe('注意你的象被捉');
  });

  it('hintHighlight：一级不点亮；二级起点+被吃目标；三级起点+终点', () => {
    const s = position([['e1', 'K'], ['d1', 'Q'], ['e8', 'k'], ['d5', 'p']], { current: 1 });
    // 一级（泛泛文字）：null
    expect(hintHighlight(s, { level: 1, best: { from: S('d1'), to: S('d5') } })).toBeNull();
    // 二级吃子：from + 被吃目标格
    expect(hintHighlight(s, { level: 2, best: { from: S('d1'), to: S('d5') } })).toEqual({
      from: S('d1'),
      to: S('d5'),
      level: 2,
      capture: true,
    });
    // 三级：from + to（capture 仅影响二级样式）
    expect(hintHighlight(s, { level: 3, best: { from: S('d1'), to: S('d5') } })).toEqual({
      from: S('d1'),
      to: S('d5'),
      level: 3,
      capture: true,
    });
  });

  it('interceptMessage：规格书格式"这步会丢后（白后 d1×d5），建议重试"', () => {
    expect(interceptMessage('丢后：被黑兵吃', '白后 d1×d5')).toBe(
      '这步会丢后（白后 d1×d5），建议重试',
    );
    expect(interceptMessage('错过绝杀：有 1 步将杀未走', '白车 a1-b1')).toBe(
      '这步会错过绝杀（白车 a1-b1），建议重试',
    );
  });
});
