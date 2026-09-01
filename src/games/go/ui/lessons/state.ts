// 围棋学堂运行器状态机（纯 reducer，node 环境可单测）：
// 关卡选择（menu）→ 进入关卡逐阶段（lesson）→ 每阶段目标达成（done）→ 下一阶段 / 完成关卡。
// 学堂内黑白双方都由学员操纵（轮到谁就落谁）：围棋交互是"空点直接落子"，无需选子 / 升变，
// 非法点（占子 / 劫禁 / 自杀）由引擎 isLegal 把关、Board 层只有合法点可点，reducer 再防御一次。
// 走错不惩罚：合法但未达成的着法照常落子，悔棋（复用引擎快照 undo）/ 重玩本阶段随时可用。
// 判定调用 ui/lessons/goals.ts 的目标闭包（place 驱动，可单测）；
// 进度（已完成关卡 id 列表）由 Runner 经 progress.ts 持久化到 localStorage，reducer 保持纯函数。
import { CELLS, initialState, isLegal, place, undo, type GoState } from '../../engine/go';
import { pt } from './goals';
import { LESSONS } from './lessons';
import type { Lesson, LessonStage } from './types';

/** 学堂运行器状态 */
export interface LessonsState {
  view: 'menu' | 'lesson';
  lessonId: string | null;
  /** 当前阶段下标（view === 'lesson' 时有效） */
  stageIdx: number;
  /** 当前阶段初始局面（重玩本阶段回到这里；menu 视图为占位空棋盘） */
  start: GoState;
  /** 当前局面（随学员落子演进） */
  game: GoState;
  /** 本阶段累计落点（目标判定输入，与 states 对齐） */
  moves: number[];
  /** 各手落完的局面（states[i] 与 moves[i] 对齐） */
  states: GoState[];
  /** 本阶段目标已达成（完成态，锁盘并展示完成语） */
  done: boolean;
  /** 已完成关卡 id（持久化由 Runner 负责） */
  completed: string[];
}

export type LessonsAction =
  | { type: 'openLesson'; id: string }
  | { type: 'backToMenu' }
  | { type: 'restartStage' }
  | { type: 'tap'; idx: number }
  | { type: 'undoMove' }
  | { type: 'nextStage' }
  | { type: 'completeLesson' };

export function getLesson(id: string | null): Lesson | null {
  return (id && LESSONS.find((l) => l.id === id)) || null;
}

export function getStage(lesson: Lesson | null, stageIdx: number): LessonStage | null {
  return (lesson && lesson.stages[stageIdx]) || null;
}

/** 阶段初始局面：stones 铺成裸棋盘 + 行棋方（默认黑先） */
export function stagePosition(stage: LessonStage): GoState {
  const board = new Int8Array(CELLS);
  for (const [label, color] of stage.position.stones) board[pt(label)] = color;
  return { ...initialState(), board, current: stage.position.options?.current ?? 1 };
}

/** 载入某关某阶段的全新状态（进入关卡 / 下一阶段 / 重玩本阶段共用） */
function stageState(lessonId: string, stageIdx: number, completed: string[]): LessonsState {
  const stage = getStage(getLesson(lessonId), stageIdx);
  const start = stage ? stagePosition(stage) : initialState();
  return {
    view: 'lesson',
    lessonId,
    stageIdx,
    start,
    game: start,
    moves: [],
    states: [],
    done: false,
    completed,
  };
}

/** 初始状态（menu 视图；completed 由 Runner 从 localStorage 读入） */
export function createLessonsState(completed: string[]): LessonsState {
  return {
    view: 'menu',
    lessonId: null,
    stageIdx: 0,
    start: initialState(),
    game: initialState(),
    moves: [],
    states: [],
    done: false,
    completed,
  };
}

/** 完成关卡：进度去重记录并回到关卡列表（✓ 徽标在列表更新） */
function finishLesson(s: LessonsState): LessonsState {
  if (!s.lessonId) return s;
  return {
    ...s,
    view: 'menu',
    lessonId: null,
    stageIdx: 0,
    completed: s.completed.includes(s.lessonId) ? s.completed : [...s.completed, s.lessonId],
  };
}

/** 应用一手落子（place）→ 累计落点/局面 → 目标判定 */
function applyMove(s: LessonsState, idx: number): LessonsState {
  const stage = getStage(getLesson(s.lessonId), s.stageIdx);
  if (!stage) return s;
  const next = place(s.game, idx);
  if (next === s.game) return s; // 非法步原样拒绝（防御：tap 已按 isLegal 过滤）
  const moves = [...s.moves, idx];
  const states = [...s.states, next];
  const done = stage.goal.check({ start: s.start, moves, states });
  return { ...s, game: next, moves, states, done };
}

export function lessonsReducer(s: LessonsState, action: LessonsAction): LessonsState {
  switch (action.type) {
    case 'openLesson': {
      if (!getLesson(action.id)) return s;
      return stageState(action.id, 0, s.completed);
    }
    case 'backToMenu':
      return { ...s, view: 'menu', lessonId: null };
    case 'restartStage': {
      if (s.view !== 'lesson' || !s.lessonId) return s;
      return stageState(s.lessonId, s.stageIdx, s.completed);
    }
    case 'tap': {
      if (s.view !== 'lesson' || s.done) return s; // 完成态锁盘
      if (!isLegal(s.game, action.idx)) return s; // 占子 / 劫禁 / 自杀 / 非对局阶段
      return applyMove(s, action.idx);
    }
    case 'undoMove': {
      // 悔棋一手：弹出引擎快照并回退累计落点（完成态不可悔棋，走错重试专用）
      if (s.moves.length === 0) return s;
      return {
        ...s,
        game: undo(s.game),
        moves: s.moves.slice(0, -1),
        states: s.states.slice(0, -1),
        done: false,
      };
    }
    case 'nextStage': {
      if (!s.done) return s;
      const lesson = getLesson(s.lessonId);
      if (!lesson) return s;
      if (s.stageIdx + 1 < lesson.stages.length) {
        return stageState(lesson.id, s.stageIdx + 1, s.completed);
      }
      return finishLesson(s);
    }
    case 'completeLesson':
      // 完成关卡：仅完成态可用（防御误触）
      return s.done ? finishLesson(s) : s;
  }
}
