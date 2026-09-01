// 新手学堂判定逻辑测试（docs/games/chess.md 第十一节）：
// 每关每个阶段都有"照正解用 makeMove 逐手驱动 → 最后一步达成、中途未达成"与
// "错误着法 → 不达成"两类用例（不起 UI，纯引擎驱动，验收核心）。
// 另覆盖学堂依赖的关键引擎联动：升变显式传参、吃过路兵窗口、易位落子效果、将死终局判定。
import { describe, expect, it } from 'vitest';
import {
  W_KING,
  W_KNIGHT,
  W_QUEEN,
  W_ROOK,
  fromAlgebraic,
  legalTargets,
  makeMove,
  position,
  type ChessState,
  type Promotion,
} from '../../engine/chess';
import { LESSONS } from './lessons';
import { stagePosition } from './state';
import type { LessonStage, StageMove } from './types';

const sq = fromAlgebraic;

/** 每关每阶段的"照提示走"正解（与 lessons.ts 的提示文案一致） */
const SOLUTIONS: Record<string, Array<{ moves: Array<[string, string]>; promotions?: Promotion[] }>> =
  {
    'board-pieces': [{ moves: [['b1', 'c3']] }, { moves: [['d1', 'h5']] }],
    'pawn-moves': [
      { moves: [['e3', 'e4']] },
      { moves: [['e2', 'e4']] },
      { moves: [['e5', 'd6']] },
    ],
    'pawn-promotion': [{ moves: [['b7', 'b8']], promotions: ['q'] }],
    'checkmate-basics': [
      { moves: [['h1', 'h8']] },
      { moves: [['f6', 'g6'], ['h8', 'g8'], ['a7', 'a8']] },
    ],
    castling: [{ moves: [['e1', 'g1']] }, { moves: [['e1', 'c1']] }],
    'en-passant': [{ moves: [['e5', 'd6']] }, { moves: [['c4', 'b3']] }],
    'capture-defense': [
      { moves: [['e3', 'f5']] },
      { moves: [['b4', 'c3'], ['b2', 'c3']] },
    ],
    'mixed-quiz': [{ moves: [['c3', 'e5']] }, { moves: [['e1', 'g1']] }, { moves: [['d1', 'd8']] }],
  };

/** 每关第 1 阶段的一步"合法但不达成"反例 */
const WRONG: Record<string, [string, string]> = {
  'board-pieces': ['b1', 'a3'], // 马跳去了别处
  'pawn-moves': ['e1', 'd2'], // 走了王，没走兵
  'pawn-promotion': ['f1', 'e1'], // 走了王，没推兵
  'checkmate-basics': ['b6', 'b5'], // 王让开守格，不成杀
  castling: ['e1', 'e2'], // 王只走一格，不是易位
  'en-passant': ['e5', 'e6'], // 直进而非斜吃过路兵
  'capture-defense': ['e3', 'd5'], // 马去了别处，没吃象
  'mixed-quiz': ['e1', 'f1'], // 没吃 e5 的兵
};

/** 从阶段初始局面按正解逐手 makeMove，返回每手之后的目标判定结果 */
function drive(stage: LessonStage, moves: Array<[string, string]>, promotions?: Promotion[]) {
  const start = stagePosition(stage);
  let game = start;
  const acc: StageMove[] = [];
  const states: ChessState[] = [];
  const results: boolean[] = [];
  moves.forEach(([f, t], i) => {
    const next = makeMove(game, sq(f), sq(t), promotions?.[i]);
    expect(next).not.toBe(game); // 正解每一步都必须合法（局面与提示设计正确性）
    game = next;
    acc.push({ from: sq(f), to: sq(t), promotion: promotions?.[i] });
    states.push(next);
    results.push(stage.goal.check({ start, moves: [...acc], states: [...states] }));
  });
  return { start, game, results };
}

const lessonById = (id: string) => LESSONS.find((l) => l.id === id)!;

describe('各关判定：完成任务 → 通过，错误着法 → 不通过', () => {
  it('每关都配置了全部阶段的正解与反例', () => {
    for (const lesson of LESSONS) {
      expect(SOLUTIONS[lesson.id]).toBeDefined();
      expect(SOLUTIONS[lesson.id]).toHaveLength(lesson.stages.length);
      expect(WRONG[lesson.id]).toBeDefined();
    }
  });

  for (const lesson of LESSONS) {
    describe(`「${lesson.title}」`, () => {
      lesson.stages.forEach((stage, i) => {
        it(`阶段 ${i + 1}：照正解逐手驱动 → 最后一步达成、中途未达成`, () => {
          const sol = SOLUTIONS[lesson.id][i];
          const { results } = drive(stage, sol.moves, sol.promotions);
          expect(results).toHaveLength(sol.moves.length);
          for (let k = 0; k < results.length - 1; k++) expect(results[k]).toBe(false);
          expect(results[results.length - 1]).toBe(true);
        });
      });

      it('错误着法（合法但不达成）→ 不通过', () => {
        const stage = lesson.stages[0];
        const [wf, wt] = WRONG[lesson.id];
        const start = stagePosition(stage);
        const next = makeMove(start, sq(wf), sq(wt));
        expect(next).not.toBe(start); // 反例本身合法（有意义的"走错"）
        expect(
          stage.goal.check({
            start,
            moves: [{ from: sq(wf), to: sq(wt) }],
            states: [next],
          }),
        ).toBe(false);
      });
    });
  }
});

describe('学堂关键规则的引擎联动', () => {
  it('升变：未传升变子 makeMove 拒绝（同引用）；传 q / n 均达成升变目标（自选）', () => {
    const stage = lessonById('pawn-promotion').stages[0];
    const start = stagePosition(stage);
    expect(makeMove(start, sq('b7'), sq('b8'))).toBe(start); // 未传升变子 → 拒绝
    const queen = drive(stage, [['b7', 'b8']], ['q']);
    expect(queen.results[0]).toBe(true);
    expect(queen.game.board[sq('b8')]).toBe(W_QUEEN);
    const knight = drive(stage, [['b7', 'b8']], ['n']);
    expect(knight.results[0]).toBe(true);
    expect(knight.game.board[sq('b8')]).toBe(W_KNIGHT);
  });

  it('吃过路兵：构造局面（带过路格）可吃；同一局面去掉过路格目标则不可吃（机会即逝）', () => {
    const stage = lessonById('en-passant').stages[0];
    const ready = stagePosition(stage);
    expect(legalTargets(ready, sq('e5'))).toContain(sq('d6'));
    const expired = position(stage.position.pieces); // 同棋子摆放，无 enPassant 目标格
    expect(legalTargets(expired, sq('e5'))).not.toContain(sq('d6'));
  });

  it('易位：短易位后王在 g1、车到 f1；长易位后王在 c1、车到 d1', () => {
    const castling = lessonById('castling');
    const shortGame = drive(castling.stages[0], [['e1', 'g1']]).game;
    expect(shortGame.board[sq('g1')]).toBe(W_KING);
    expect(shortGame.board[sq('f1')]).toBe(W_ROOK);
    const longGame = drive(castling.stages[1], [['e1', 'c1']]).game;
    expect(longGame.board[sq('c1')]).toBe(W_KING);
    expect(longGame.board[sq('d1')]).toBe(W_ROOK);
  });

  it('将死：车沉底后引擎判定 status=won / winner=白 / reason=checkmate', () => {
    const mate = lessonById('checkmate-basics').stages[0];
    const { game, results } = drive(mate, [['h1', 'h8']]);
    expect(results[0]).toBe(true);
    expect(game.status).toBe('won');
    expect(game.winner).toBe(1);
    expect(game.reason).toBe('checkmate');
  });

  it('捉子与保护阶段 2：黑方先走吃马、白兵反吃——顺序着法判定达成', () => {
    const stage = lessonById('capture-defense').stages[1];
    expect(stagePosition(stage).current).toBe(2); // 轮黑先走（黑象吃马是剧本第一手）
    const { results } = drive(stage, [
      ['b4', 'c3'],
      ['b2', 'c3'],
    ]);
    expect(results).toEqual([false, true]);
  });
});
