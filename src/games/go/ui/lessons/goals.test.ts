// 围棋学堂判定逻辑测试（docs/games/chess.md 第十三节）：
// 每关每个阶段都有"照正解用 place 逐手驱动 → 最后一步达成、中途未达成"与
// "错误着法 → 不达成"两类用例（不起 UI，纯引擎驱动，验收核心）。
// 另覆盖学堂依赖的关键引擎联动：提子整群提、打吃不误提、反提不受简单劫拦截、
// 真眼近似判定（真眼 / 假眼 / 边眼）与坐标工具。
import { describe, expect, it } from 'vitest';
import { groupAt, place, type GoState, type Player } from '../../engine/go';
import {
  coordName,
  countTrueEyes,
  capturedCount,
  moverOf,
  pt,
  trueEyeAt,
} from './goals';
import { LESSONS } from './lessons';
import { stagePosition } from './state';
import type { GoalContext, LessonStage } from './types';

/** 每关每阶段的"照提示落"正解（与 lessons.ts 的提示文案一致，坐标标签 = 列字母 + 行号） */
const SOLUTIONS: Record<string, string[][]> = {
  'capture-stones': [['F5'], ['G5']],
  atari: [['E4'], ['G6']],
  'double-atari': [['F5'], ['E5']],
  escape: [['G5'], ['F5']],
  'counter-capture': [['D5', 'E5']], // 白提两子 → 黑立即反提（中间态必须不通过）
  'two-eyes': [['C1'], ['D5']],
};

/** 每关第 1 阶段的一手"合法但不达成"反例 */
const WRONG: Record<string, string> = {
  'capture-stones': 'A1', // 落在远处，没提子
  atari: 'A1', // 没有堵对方的气
  'double-atari': 'E4', // 只打吃了一处（E5），不算双叫吃
  escape: 'A1', // 没给被打吃的黑子延气
  'counter-capture': 'A1', // 白棋先落在远处，没有提子
  'two-eyes': 'B1', // 占了眼位边点而不是中间，分不出两只眼
};

/** 从阶段初始局面按正解逐手 place，返回每手之后的目标判定结果 */
function drive(stage: LessonStage, labels: string[]) {
  const start = stagePosition(stage);
  let game = start;
  const moves: number[] = [];
  const states: GoState[] = [];
  const results: boolean[] = [];
  labels.forEach((label) => {
    const idx = pt(label);
    const next = place(game, idx);
    expect(next).not.toBe(game); // 正解每一步都必须合法（局面与提示设计正确性）
    game = next;
    moves.push(idx);
    states.push(next);
    results.push(stage.goal.check({ start, moves: [...moves], states: [...states] }));
  });
  const ctx: GoalContext = { start, moves, states };
  return { start, game, ctx, results };
}

const lessonById = (id: string) => LESSONS.find((l) => l.id === id)!;

describe('坐标与判定工具', () => {
  it('pt：列字母 + 行号 → idx，越界 / 非法标签抛错；coordName 是逆运算', () => {
    expect(pt('A1')).toBe(0);
    expect(pt('E5')).toBe(40); // 9 路天元
    expect(pt('I9')).toBe(80);
    expect(pt('c3')).toBe(2 * 9 + 2); // 大小写不敏感
    expect(coordName(pt('G5'))).toBe('G5');
    expect(coordName(pt('A1'))).toBe('A1');
    expect(() => pt('J1')).toThrow(); // 9 路盘只有 A–I 九列
    expect(() => pt('K1')).toThrow();
    expect(() => pt('A0')).toThrow();
    expect(() => pt('A10')).toThrow();
    expect(() => pt('5E')).toThrow();
  });

  it('moverOf：从阶段初始行棋方逐手轮转', () => {
    const ctx = { start: stagePosition(lessonById('capture-stones').stages[0]), moves: [], states: [] };
    expect([0, 1, 2, 3].map((i) => moverOf(ctx, i))).toEqual([1, 2, 1, 2]);
    const whiteFirst = {
      start: { ...ctx.start, current: 2 as Player },
      moves: [],
      states: [],
    };
    expect([0, 1, 2].map((i) => moverOf(whiteFirst, i))).toEqual([2, 1, 2]);
  });

  it('capturedCount：落 1 提 n 的盘面差换算', () => {
    const empty = stagePosition(lessonById('capture-stones').stages[0]); // 含 4 颗子
    const placed = place(empty, pt('A1')); // 无提子
    expect(capturedCount(empty, placed)).toBe(0);
    // 空盘阶段：合法 LessonStage（无子局面），落子无提子
    const bare: LessonStage = {
      brief: '空盘',
      position: { stones: [] },
      goal: { kind: 'capture', describe: '提掉任意白子', check: () => true },
      complete: '完成',
    };
    const one = place(stagePosition(bare), pt('E5'));
    expect(capturedCount(stagePosition(bare), one)).toBe(0);
    // 构造提子：empty 里 E5 白子本就只剩 F5 一口气，黑 F5 提 1
    const capture = place(empty, pt('F5'));
    expect(capture.board[pt('E5')]).toBe(0);
    expect(capturedCount(empty, capture)).toBe(1);
  });

  it('trueEyeAt：真眼成立；对角被占的假眼不成立；边角眼按对角数减半规则判定', () => {
    // 中腹真眼：C5 四周全是黑，四个对角也全是黑
    const b = new Int8Array(81);
    for (const label of ['B5', 'D5', 'C4', 'C6', 'B4', 'B6', 'D4', 'D6']) b[pt(label)] = 1;
    expect(trueEyeAt(b, pt('C5'), 1)).toBe(true);
    // 假眼：D4、D6 两个对角被白占（对方对角过半的临界形）
    b[pt('D4')] = 2;
    b[pt('D6')] = 2;
    expect(trueEyeAt(b, pt('C5'), 1)).toBe(false);
    // 只占一个对角（≤1）仍按真眼算
    b[pt('D6')] = 0;
    expect(trueEyeAt(b, pt('C5'), 1)).toBe(true);
    // 边眼：B1 三面黑 + 两个对角全黑 → 真；其中一个对角白 → 假
    const e = new Int8Array(81);
    for (const label of ['A1', 'C1', 'B2', 'A2', 'C2']) e[pt(label)] = 1;
    expect(trueEyeAt(e, pt('B1'), 1)).toBe(true);
    e[pt('A2')] = 2;
    expect(trueEyeAt(e, pt('B1'), 1)).toBe(false);
    // 空点才可能是眼：己方 / 对方棋子占据的点不算
    expect(trueEyeAt(b, pt('B5'), 1)).toBe(false);
  });

  it('countTrueEyes：两只真眼计数（第 6 关正解局面）', () => {
    const { game } = drive(lessonById('two-eyes').stages[0], ['C1']);
    expect(countTrueEyes(game.board, 1)).toBe(2);
  });
});

describe('各关判定：照正解落子 → 通过，错误着法 → 不通过', () => {
  it('每关都配置了全部阶段的正解与反例', () => {
    expect(Object.keys(SOLUTIONS).sort()).toEqual(LESSONS.map((l) => l.id).sort());
    expect(Object.keys(WRONG).sort()).toEqual(LESSONS.map((l) => l.id).sort());
    for (const lesson of LESSONS) {
      expect(SOLUTIONS[lesson.id]).toHaveLength(lesson.stages.length);
    }
  });

  it('第 1 关 气与提子：提掉 1 口气白子 / 整群两子；不提子不通过', () => {
    const lesson = lessonById('capture-stones');
    const s1 = drive(lesson.stages[0], SOLUTIONS['capture-stones'][0]);
    expect(s1.game.board[pt('E5')]).toBe(0); // 白子被提
    expect(s1.game.captures[0]).toBe(1); // 黑提子数 +1
    expect(s1.results).toEqual([true]);
    const s2 = drive(lesson.stages[1], SOLUTIONS['capture-stones'][1]);
    expect(s2.game.board[pt('E5')]).toBe(0);
    expect(s2.game.board[pt('F5')]).toBe(0); // 整群同提
    expect(s2.results).toEqual([true]);
    // 反例：远处落子不提子 → 不通过
    const w1 = drive(lesson.stages[0], [WRONG['capture-stones']]);
    expect(w1.results).toEqual([false]);
    // 反例：堵一口气但对方还有气 → 不通过
    const w2 = drive(lesson.stages[1], ['H5']);
    expect(w2.results).toEqual([false]);
  });

  it('第 2 关 打吃：2 口气棋群打成 1 口气；提子手 / 未打吃手不通过', () => {
    const lesson = lessonById('atari');
    for (let i = 0; i < 2; i++) {
      const s = drive(lesson.stages[i], SOLUTIONS.atari[i]);
      expect(s.results).toEqual([true]);
      const enemy = groupAt(s.game.board, pt(i === 0 ? 'E5' : 'F5'));
      expect(enemy.liberties).toHaveLength(1); // 确实只剩一口气
    }
    const w1 = drive(lesson.stages[0], [WRONG.atari]);
    expect(w1.results).toEqual([false]);
    // 反例：把对方棋群直接提掉（提子不是打吃）
    const w2 = drive(lesson.stages[0], ['E4', 'E7']); // E4 打吃后白不应，黑 E7 提两子
    expect(w2.results).toEqual([true, false]); // 第二手是提子，不满足"打吃"目标
  });

  it('第 3 关 双叫吃：一手两处打吃；只打吃一处 / 普通落子不通过', () => {
    const lesson = lessonById('double-atari');
    for (let i = 0; i < 2; i++) {
      const s = drive(lesson.stages[i], SOLUTIONS['double-atari'][i]);
      expect(s.results).toEqual([true]);
    }
    // 反例：E4 只把 E5 打到 1 口气，G5 仍有 2 口 → 不是双叫吃
    const w1 = drive(lesson.stages[0], [WRONG['double-atari']]);
    expect(w1.results).toEqual([false]);
    const w2 = drive(lesson.stages[1], [WRONG.atari]);
    expect(w2.results).toEqual([false]);
  });

  it('第 4 关 逃子：被打吃棋群延气到 2 口以上；不救 / 弃子不通过', () => {
    const lesson = lessonById('escape');
    for (let i = 0; i < 2; i++) {
      const s = drive(lesson.stages[i], SOLUTIONS.escape[i]);
      expect(s.results).toEqual([true]);
      expect(groupAt(s.game.board, pt('E5')).liberties.length).toBeGreaterThanOrEqual(2);
    }
    const w1 = drive(lesson.stages[0], [WRONG.escape]);
    expect(w1.results).toEqual([false]);
    expect(groupAt(w1.game.board, pt('E5')).liberties).toHaveLength(1); // 仍被打吃
  });

  it('第 5 关 反提：白提两子（中间态不通过）→ 黑立即反提通过，且不受简单劫拦截', () => {
    const lesson = lessonById('counter-capture');
    const s = drive(lesson.stages[0], SOLUTIONS['counter-capture'][0]);
    expect(s.results).toEqual([false, true]); // 第一步只是"被提"，反提完成后才通过
    expect(s.game.board[pt('D5')]).toBe(0); // 白子被反提
    expect(s.game.captures).toEqual([1, 2]); // 黑提 1、白提 2
    // 反例 1：白棋没先提子，黑棋谈不上反提
    const w1 = drive(lesson.stages[0], [WRONG['counter-capture']]);
    expect(w1.results).toEqual([false]);
    // 反例 2：白提两子后黑不去反提（落他处）→ 不通过
    const w2 = drive(lesson.stages[0], ['D5', 'A1']);
    expect(w2.results).toEqual([false, false]);
  });

  it('第 6 关 两眼做活：点中间分出两只真眼；占边点 / 让白棋进眼位不通过', () => {
    const lesson = lessonById('two-eyes');
    for (let i = 0; i < 2; i++) {
      const s = drive(lesson.stages[i], SOLUTIONS['two-eyes'][i]);
      expect(s.results).toEqual([true]);
      expect(countTrueEyes(s.game.board, 1)).toBeGreaterThanOrEqual(2);
    }
    const w1 = drive(lesson.stages[0], [WRONG['two-eyes']]);
    expect(w1.results).toEqual([false]);
    expect(countTrueEyes(w1.game.board, 1)).toBe(0);
    // 反例 2：点中间之前白棋先进眼位（白 B1 黑提掉后仍能做出两眼 → 换个更直接的反例：
    // 黑先占 D1 边点，眼位只剩两连空点，做不出两只真眼）
    const w2 = drive(lesson.stages[0], ['D1']);
    expect(w2.results).toEqual([false]);
  });
});
