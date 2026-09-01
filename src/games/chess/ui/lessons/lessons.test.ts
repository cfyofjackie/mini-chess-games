// 新手学堂关卡数据测试（docs/games/chess.md 第十一节）：
// 8 关齐全、id 唯一、阶段数 1~4、文案齐全；每阶段局面可由 position() 构造器搭建
//（双方有王、行棋方未被将军、行棋方至少一步合法——保证"动手"阶段可玩）；
// 规格书六种目标类型全部在关卡表中出现。
import { describe, expect, it } from 'vitest';
import { allLegalMoves, B_KING, W_KING } from '../../engine/chess';
import { LESSONS } from './lessons';
import { stagePosition } from './state';
import type { GoalKind } from './types';

/** 规格书第十一节要求的六种目标类型（promote 为升变教学补充，不在此列） */
const REQUIRED_KINDS: ReadonlyArray<GoalKind> = [
  'reach',
  'capture',
  'checkmate',
  'castle',
  'enPassant',
  'sequence',
];

describe('新手学堂关卡数据（规格书第十一节关卡表）', () => {
  it('8 关齐全、id 唯一且与规格顺序一致', () => {
    expect(LESSONS.map((l) => l.id)).toEqual([
      'board-pieces', // ① 认识棋盘与棋子
      'pawn-moves', // ② 兵的走法
      'pawn-promotion', // ③ 兵的升变
      'checkmate-basics', // ④ 将死的概念
      'castling', // ⑤ 王车易位
      'en-passant', // ⑥ 吃过路兵
      'capture-defense', // ⑦ 捉子与保护
      'mixed-quiz', // ⑧ 综合小测
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
        expect(Array.isArray(stage.position.pieces)).toBe(true); // position() 描述
      }
    }
  });

  it('规格书六种目标类型全部出现（reach/capture/checkmate/castle/enPassant/sequence）', () => {
    const kinds = new Set<GoalKind>(LESSONS.flatMap((l) => l.stages.map((s) => s.goal.kind)));
    for (const kind of REQUIRED_KINDS) expect(kinds.has(kind)).toBe(true);
    expect(kinds.has('promote')).toBe(true); // 升变关使用补充类型
  });

  it('每阶段局面可由 position() 构造：双方有王、行棋方未被将军、至少一步合法', () => {
    for (const lesson of LESSONS) {
      for (const stage of lesson.stages) {
        const game = stagePosition(stage);
        expect(game.status).toBe('playing');
        expect(game.check).toBe(false); // 行棋方开局未被将军（position() 已计算）
        const hasKing = (side: 1 | 2) =>
          game.board.some((p) => p === (side === 1 ? W_KING : B_KING));
        expect(hasKing(1)).toBe(true);
        expect(hasKing(2)).toBe(true);
        expect(
          allLegalMoves(game.board, game.current, game.enPassant, game.castling).length,
        ).toBeGreaterThan(0);
      }
    }
  });
});
