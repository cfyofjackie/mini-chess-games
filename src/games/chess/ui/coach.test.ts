// 教练模式 v1 状态机测试（docs/games/chess.md 第十节测试清单第 2/3/4 条，验收核心）：
// 直接测 ui/useChess.ts 的 chessReducer 纯状态机——
// - 提示阶梯：三级递进、换手重置、一局三次三级 → 教学局、新局重置；
// - 大错拦截：预评估 ❌ → 拦截卡 → 重试恢复选子前 / 坚持 → 落子并计数；⚠️/✅ 不拦截；
//   超时放行与迟到评语、过期回复按请求 id 丢弃、升变步预评估；
// - 教练关闭零行为变化：tap 直接落子、无任何教练副作用、走子序列与裸引擎一致。
// 评语 verdict 在测试中直接构造（分级正确性由 engine/coach.test.ts 覆盖）。
import { describe, expect, it } from 'vitest';
import { chessReducer, initialChessUiState, type ChessUiState } from './useChess';
import { fromAlgebraic, initialState, makeMove, position } from '../engine/chess';
import { hintHighlight, type CoachVerdict } from '../engine/coach';

const S = fromAlgebraic;
const E2 = S('e2');
const E4 = S('e4');

const goodVerdict: CoachVerdict = {
  grade: 'good',
  reason: '平稳：小幅损失',
  loss: 50,
  bestScore: 50,
  playerValue: 0,
  best: null,
};
const blunderVerdict: CoachVerdict = {
  grade: 'blunder',
  reason: '丢后：被黑兵吃',
  loss: 1600,
  bestScore: 900,
  playerValue: -700,
  best: null,
};

const coachOn = (game = initialState()): ChessUiState => ({
  ...initialChessUiState(),
  game,
  coach: true,
});

describe('提示阶梯状态机（规格书第十节清单 2）', () => {
  it('三级递进：每按一次升一级，一级纯文字不点亮、二级起点、三级起点+终点', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toMatchObject({ level: 1, ply: 0 });
    expect(hintHighlight(s.game, s.hint)).toBeNull(); // 一级：只给泛泛文字

    // Worker 回填最佳着法与分值 → 一级文字生成
    s = chessReducer(s, { type: 'hintBest', ply: 0, best: { from: S('g1'), to: S('f3') }, score: 50 });
    expect(s.hint?.text).toBe('向中心发展出子，注意王的安全');

    // 二级：同局面缓存命中（无需再次请求），高亮起点
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toMatchObject({ level: 2, ply: 0 });
    expect(s.hint?.best).toEqual({ from: S('g1'), to: S('f3') });
    expect(hintHighlight(s.game, s.hint)).toMatchObject({ from: S('g1'), to: S('f3'), level: 2 });

    // 三级：起点+终点，计数 +1（尚未到教学局）
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toMatchObject({ level: 3, ply: 0 });
    expect(hintHighlight(s.game, s.hint)).toMatchObject({ level: 3 });
    expect(s.hint3).toBe(1);
    expect(s.teaching).toBe(false);

    // 三级再按两次（累计三次三级提示）→ 教学局标记
    s = chessReducer(s, { type: 'requestHint' });
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint3).toBe(3);
    expect(s.teaching).toBe(true);
  });

  it('换手重置：走子后阶梯清空，新局面从一级重新开始', () => {
    let s = coachOn(); // 初始，轮白
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toMatchObject({ level: 1, ply: 0 });
    // 白方经教练评注通路落子（换手）→ 阶梯重置
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 1 });
    s = chessReducer(s, { type: 'coachVerdict', id: 1, verdict: goodVerdict });
    expect(s.hint).toBeNull();
    // AI 回手（换回白方）→ 仍为空，可从一级重新开始
    s = chessReducer(s, { type: 'aiMove', from: S('e7'), to: S('e5') });
    expect(s.hint).toBeNull();
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toMatchObject({ level: 1, ply: 2 });
  });

  it('新局重置：教学局 / 坚持计数 / 评语 / 提示清零，教练开关保留', () => {
    let s = coachOn();
    for (let i = 0; i < 5; i++) s = chessReducer(s, { type: 'requestHint' }); // 3 次三级
    expect(s.teaching).toBe(true);
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 1 });
    s = chessReducer(s, { type: 'coachVerdict', id: 1, verdict: blunderVerdict });
    s = chessReducer(s, { type: 'interceptInsist' });
    expect(s.insisted).toBe(1);

    s = chessReducer(s, { type: 'reset' });
    expect(s.teaching).toBe(false);
    expect(s.hint3).toBe(0);
    expect(s.insisted).toBe(0);
    expect(s.comment).toBeNull();
    expect(s.hint).toBeNull();
    expect(s.coach).toBe(true);
    expect(s.game.history.length).toBe(0);
  });

  it('非人类回合 / 拦截期 / 评估期 requestHint 被忽略', () => {
    let s = coachOn(makeMove(initialState(), S('e2'), S('e4'))); // 轮黑
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toBeNull();

    s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 1 });
    s = chessReducer(s, { type: 'requestHint' }); // 评估等待期
    expect(s.hint).toBeNull();
    s = chessReducer(s, { type: 'coachVerdict', id: 1, verdict: blunderVerdict });
    s = chessReducer(s, { type: 'requestHint' }); // 拦截卡打开期
    expect(s.hint).toBeNull();
  });
});

describe('大错拦截状态机（规格书第十节清单 3）', () => {
  it('拦截弹卡 → 重试恢复选子前状态（棋盘未动、选择清空、等待期锁盘）', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 }); // 选中 e2 兵
    expect(s.selected).toBe(E2);
    s = chessReducer(s, { type: 'tap', idx: E4 }); // 点落点 → 挂起待评（不落子）
    expect(s.game.history.length).toBe(0);
    expect(s.pendingEval).toMatchObject({ from: E2, to: E4, ply: 1, reqId: 0 });
    expect(s.selected).toBe(-1);

    // 请求盖章 + ❌ 回复 → 拦截卡挂起该步
    s = chessReducer(s, { type: 'coachEvalSent', id: 7 });
    s = chessReducer(s, { type: 'coachVerdict', id: 7, verdict: blunderVerdict });
    expect(s.pendingEval).toBeNull();
    expect(s.intercept).toMatchObject({ from: E2, to: E4 });
    expect(s.intercept?.verdict.grade).toBe('blunder');
    expect(s.game.history.length).toBe(0);

    // 拦截卡打开期棋盘锁定：点击被忽略
    const locked = chessReducer(s, { type: 'tap', idx: S('d2') });
    expect(locked.selected).toBe(-1);
    expect(locked.intercept).not.toBeNull();

    // 重试：恢复选子前状态
    s = chessReducer(s, { type: 'interceptRetry' });
    expect(s.intercept).toBeNull();
    expect(s.selected).toBe(-1);
    expect(s.game.history.length).toBe(0);
    expect(s.comment).toBeNull();
  });

  it('拦截 → 坚持照走并计数，❌ 评语写入', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 1 });
    s = chessReducer(s, { type: 'coachVerdict', id: 1, verdict: blunderVerdict });
    s = chessReducer(s, { type: 'interceptInsist' });
    expect(s.game.history.length).toBe(1);
    expect(s.game.current).toBe(2);
    expect(s.insisted).toBe(1);
    expect(s.intercept).toBeNull();
    expect(s.comment).toMatchObject({ ply: 1, from: E2, to: E4 });
    expect(s.comment?.verdict.grade).toBe('blunder');
  });

  it('⚠️/✅/🌟 不拦截：预评估回复即落子 + 评语（机制 1）', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 3 });
    s = chessReducer(s, { type: 'coachVerdict', id: 3, verdict: goodVerdict });
    expect(s.game.history.length).toBe(1);
    expect(s.game.current).toBe(2);
    expect(s.intercept).toBeNull();
    expect(s.pendingEval).toBeNull();
    expect(s.comment?.verdict.grade).toBe('good');
  });

  it('超时放行：coachTimeout 照走；迟到评语按手数与最后一手校验写入', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachTimeout' });
    expect(s.game.history.length).toBe(1); // 照走，不卡玩家
    expect(s.pendingEval).toBeNull();

    // 迟到回复：局面仍停在该手 → 补写评语
    s = chessReducer(s, { type: 'coachComment', ply: 1, from: E2, to: E4, verdict: blunderVerdict });
    expect(s.comment?.verdict.grade).toBe('blunder');

    // AI 已回手（手数不符）→ 迟到评语丢弃，原评语不被覆盖
    const moved = { ...s, game: makeMove(s.game, S('e7'), S('e5')) };
    const s2 = chessReducer(moved, {
      type: 'coachComment',
      ply: 1,
      from: E2,
      to: E4,
      verdict: goodVerdict,
    });
    expect(s2.comment?.verdict.grade).toBe('blunder');
  });

  it('过期回复按请求 id 丢弃（同既有 Worker 回复模式）', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 10 });
    s = chessReducer(s, { type: 'coachVerdict', id: 99, verdict: goodVerdict }); // id 不匹配
    expect(s.game.history.length).toBe(0);
    expect(s.pendingEval).not.toBeNull();
    expect(s.comment).toBeNull();
  });

  it('升变步 + 教练：先选升变子再挂起预评估，回复后按所选升变落子', () => {
    const promoSeed = position([['f1', 'K'], ['b7', 'P'], ['h8', 'k'], ['h7', 'p']], { current: 1 });
    let s = coachOn(promoSeed);
    s = chessReducer(s, { type: 'tap', idx: S('b7') });
    s = chessReducer(s, { type: 'tap', idx: S('b8') });
    expect(s.pending).toMatchObject({ from: S('b7'), to: S('b8') }); // 先弹升变浮层
    s = chessReducer(s, { type: 'promote', piece: 'q' });
    expect(s.pendingEval).toMatchObject({ from: S('b7'), to: S('b8'), promotion: 'q', ply: 1 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 5 });
    s = chessReducer(s, { type: 'coachVerdict', id: 5, verdict: goodVerdict });
    expect(s.game.history.length).toBe(1);
    expect(s.game.board[S('b8')]).toBe(5); // 白后（W_QUEEN）
    expect(s.comment?.verdict.grade).toBe('good');
  });

  it('悔棋清教练瞬态（评语/提示/挂起/拦截），不残留过期高亮', () => {
    let s = coachOn();
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    s = chessReducer(s, { type: 'coachEvalSent', id: 1 });
    s = chessReducer(s, { type: 'coachVerdict', id: 1, verdict: goodVerdict });
    expect(s.comment).not.toBeNull();
    s = chessReducer(s, { type: 'undoToHuman' });
    expect(s.game.history.length).toBe(0);
    expect(s.comment).toBeNull();
    expect(s.hint).toBeNull();
    expect(s.pendingEval).toBeNull();
    expect(s.intercept).toBeNull();
  });
});

describe('教练关闭零行为变化（规格书第十节清单 4）', () => {
  it('tap 直接落子，无待评 / 拦截 / 评语 / 提示副作用；requestHint 被忽略', () => {
    let s = initialChessUiState(); // coach 默认 false
    s = chessReducer(s, { type: 'tap', idx: E2 });
    expect(s.selected).toBe(E2);
    s = chessReducer(s, { type: 'tap', idx: E4 });
    expect(s.game.history.length).toBe(1);
    expect(s.pendingEval).toBeNull();
    expect(s.intercept).toBeNull();
    expect(s.comment).toBeNull();
    expect(s.hint).toBeNull();
    s = chessReducer(s, { type: 'requestHint' });
    expect(s.hint).toBeNull();
  });

  it('关闭状态下走子序列与裸引擎 makeMove 完全一致', () => {
    let s = initialChessUiState();
    for (const [f, t] of [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ] as const) {
      s = chessReducer(s, { type: 'tap', idx: S(f) });
      s = chessReducer(s, { type: 'tap', idx: S(t) });
    }
    const plain = makeMove(
      makeMove(makeMove(initialState(), S('e2'), S('e4')), S('e7'), S('e5')),
      S('g1'),
      S('f3'),
    );
    expect(s.game.history.length).toBe(3);
    expect(Array.from(s.game.board)).toEqual(Array.from(plain.board));
    expect(s.game.castling).toBe(plain.castling);
    expect(s.game.enPassant).toBe(plain.enPassant);
    expect(s.game.current).toBe(plain.current);
  });

  it('toggleCoach：开启后 tap 改为挂起预评估；关闭时挂起着法照常放行', () => {
    let s = initialChessUiState();
    s = chessReducer(s, { type: 'toggleCoach' });
    expect(s.coach).toBe(true);
    s = chessReducer(s, { type: 'tap', idx: E2 });
    s = chessReducer(s, { type: 'tap', idx: E4 });
    expect(s.pendingEval).not.toBeNull();
    expect(s.game.history.length).toBe(0);

    s = chessReducer(s, { type: 'toggleCoach' }); // 关闭：挂起视作放行
    expect(s.coach).toBe(false);
    expect(s.game.history.length).toBe(1);
    expect(s.pendingEval).toBeNull();
    expect(s.intercept).toBeNull();
  });
});
