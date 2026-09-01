// 围棋学堂关卡数据测试（docs/games/chess.md 第十三节关卡表）：
// 6 关齐全、id 唯一且与规格顺序一致、阶段数 1~4、文案齐全；每阶段局面可直接落子开局
//（盘面子均有气、行棋方至少一个合法点——保证"动手"阶段可玩）；六种目标类型全部出现。
import { describe, expect, it } from 'vitest';
import { CELLS, groupAt, legalMoves } from '../../engine/go';
import { LESSONS } from './lessons';
import { stagePosition } from './state';
import type { GoalKind } from './types';

/** 规格书第十三节关卡表要求的六种目标类型 */
const REQUIRED_KINDS: ReadonlyArray<GoalKind> = [
  'capture',
  'atari',
  'doubleAtari',
  'escape',
  'counterCapture',
  'twoEyes',
];

describe('围棋学堂关卡数据（规格书第十三节关卡表）', () => {
  it('6 关齐全、id 唯一且与规格顺序一致（气与提子→打吃→双叫吃→逃子→反提→两眼做活）', () => {
    expect(LESSONS.map((l) => l.id)).toEqual([
      'capture-stones', // ① 气与提子
      'atari', // ② 打吃
      'double-atari', // ③ 双叫吃
      'escape', // ④ 逃子（延气）
      'counter-capture', // ⑤ 反提
      'two-eyes', // ⑥ 两眼做活
    ]);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
  });

  it('每关标题/简介非空，阶段数 1~4，阶段文案与目标判定齐全', () => {
    for (const lesson of LESSONS) {
      expect(lesson.title.trim()).not.toBe('');
      expect(lesson.intro.trim()).not.toBe('');
      expect(lesson.stages.length).toBeGreaterThanOrEqual(1);
      expect(lesson.stages.length).toBeLessThanOrEqual(4);
      for (const stage of lesson.stages) {
        expect(stage.brief.trim()).not.toBe(''); // 说明文案
        expect(stage.goal.describe.trim()).not.toBe(''); // 任务提示
        expect(typeof stage.goal.check).toBe('function'); // 判定函数存在
        expect(stage.complete.trim()).not.toBe(''); // 完成语
        expect(Array.isArray(stage.position.stones)).toBe(true); // 裸棋盘描述
      }
    }
  });

  it('规格书六种目标类型全部出现（capture/atari/doubleAtari/escape/counterCapture/twoEyes）', () => {
    const kinds = new Set<GoalKind>(LESSONS.flatMap((l) => l.stages.map((s) => s.goal.kind)));
    for (const kind of REQUIRED_KINDS) expect(kinds.has(kind)).toBe(true);
  });

  it('每阶段局面合法可玩：坐标界内不重复、盘面子均有气（不存在已被提的死子）、至少一个合法落点', () => {
    for (const lesson of LESSONS) {
      for (const stage of lesson.stages) {
        const game = stagePosition(stage);
        expect(game.status).toBe('playing');
        // 坐标界内且不重复（stones 里的标签互不相同）
        const pts = stage.position.stones.map(([label]) => {
          const idx = ((): number => {
            const col = label.toUpperCase().charCodeAt(0) - 65;
            const row = Number(label.slice(1)) - 1;
            expect(col).toBeGreaterThanOrEqual(0);
            expect(col).toBeLessThanOrEqual(8);
            expect(row).toBeGreaterThanOrEqual(0);
            expect(row).toBeLessThanOrEqual(8);
            return row * 9 + col;
          })();
          return idx;
        });
        expect(new Set(pts).size).toBe(pts.length);
        // 盘面与描述一致
        expect(game.board.filter((v) => v !== 0)).toHaveLength(pts.length);
        // 每颗子（整群）都有气——构造局面不允许出现"本应已被提走"的死子
        for (const idx of pts) {
          expect(groupAt(game.board, idx).liberties.length).toBeGreaterThanOrEqual(1);
        }
        // 行棋方至少一手可落（保证"动手"阶段可玩）
        expect(legalMoves(game).length).toBeGreaterThan(0);
        expect(game.board).toHaveLength(CELLS);
      }
    }
  });

  it('反提关第 1 阶段白先（对方先来提，学员操纵双方）；其余关默认黑先', () => {
    const counter = stagePosition(LESSONS.find((l) => l.id === 'counter-capture')!.stages[0]);
    expect(counter.current).toBe(2);
    for (const lesson of LESSONS.filter((l) => l.id !== 'counter-capture')) {
      for (const stage of lesson.stages) {
        expect(stagePosition(stage).current).toBe(1);
      }
    }
  });
});
