// 关卡运行器状态机（纯 reducer，与 ui/useChess.ts 同构，node 环境可单测）：
// 关卡选择（menu）→ 进入关卡逐阶段（lesson）→ 每阶段目标达成（done）→ 下一阶段 / 完成关卡。
// 学堂内黑白双方都由学员操纵（轮到谁就走谁），交互复用对局思路：点击选子 → 高亮合法落点 →
// 落子（升变步先弹选择，由 Runner 渲染浮层）；走错不惩罚——合法但未达成的着法照常落子并
// toast 提示，悔棋（复用引擎快照 undo）/ 重玩本阶段随时可用。
// 判定调用 ui/lessons/goals.ts 的目标闭包（makeMove 驱动，可单测）；
// 进度（已完成关卡 id 列表）由 Runner 经 progress.ts 持久化到 localStorage，reducer 保持纯函数。
import {
  legalTargets,
  makeMove,
  needsPromotion,
  position,
  sideOf,
  undo,
  type ChessState,
  type Promotion,
} from '../../engine/chess';
import { explainSelection, toastText } from '../hints';
import { LESSONS } from './lessons';
import type { Lesson, LessonStage, StageMove } from './types';

/** 学堂运行器状态 */
export interface LessonsState {
  view: 'menu' | 'lesson';
  lessonId: string | null;
  /** 当前阶段下标（view === 'lesson' 时有效） */
  stageIdx: number;
  /** 当前阶段初始局面（重玩本阶段回到这里；menu 视图为占位空局面） */
  start: ChessState;
  /** 当前局面（随学员走子演进） */
  game: ChessState;
  /** 当前选中格 idx，-1 为未选中 */
  selected: number;
  /** 待决升变：兵已点到升变落点，等待选择升变子 */
  pending: { from: number; to: number } | null;
  /** 本阶段累计着法（目标判定输入） */
  moves: StageMove[];
  /** 各手走完的局面（states[i] 与 moves[i] 对齐） */
  states: ChessState[];
  /** 本阶段目标已达成（完成态，锁盘并展示完成语） */
  done: boolean;
  /** 提示浮条文案（走错 / 轮次），null 为不显示；Runner 2.6s 后清除 */
  toast: string | null;
  /** 已完成关卡 id（持久化由 Runner 负责） */
  completed: string[];
}

export type LessonsAction =
  | { type: 'openLesson'; id: string }
  | { type: 'backToMenu' }
  | { type: 'restartStage' }
  | { type: 'tap'; idx: number }
  | { type: 'promote'; piece: Promotion }
  | { type: 'cancelPromotion' }
  | { type: 'undoMove' }
  | { type: 'clearToast' }
  | { type: 'nextStage' }
  | { type: 'completeLesson' };

export function getLesson(id: string | null): Lesson | null {
  return (id && LESSONS.find((l) => l.id === id)) || null;
}

export function getStage(lesson: Lesson | null, stageIdx: number): LessonStage | null {
  return (lesson && lesson.stages[stageIdx]) || null;
}

/** 阶段初始局面：pieces/options 喂给引擎 position() 构造器 */
export function stagePosition(stage: LessonStage): ChessState {
  return position(stage.position.pieces, stage.position.options);
}

/** 载入某关某阶段的全新状态（进入关卡 / 下一阶段 / 重玩本阶段共用） */
function stageState(lessonId: string, stageIdx: number, completed: string[]): LessonsState {
  const stage = getStage(getLesson(lessonId), stageIdx);
  const start = stage ? stagePosition(stage) : position([]);
  return {
    view: 'lesson',
    lessonId,
    stageIdx,
    start,
    game: start,
    selected: -1,
    pending: null,
    moves: [],
    states: [],
    done: false,
    toast: null,
    completed,
  };
}

/** 初始状态（menu 视图；completed 由 Runner 从 localStorage 读入） */
export function createLessonsState(completed: string[]): LessonsState {
  return {
    view: 'menu',
    lessonId: null,
    stageIdx: 0,
    start: position([]),
    game: position([]),
    selected: -1,
    pending: null,
    moves: [],
    states: [],
    done: false,
    toast: null,
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
    toast: null,
  };
}

/** 应用一手着法（makeMove）→ 累计着法/局面 → 目标判定 →（未达成时）走错提示 */
function applyMove(
  s: LessonsState,
  from: number,
  to: number,
  promotion?: Promotion,
): LessonsState {
  const stage = getStage(getLesson(s.lessonId), s.stageIdx);
  if (!stage) return s;
  const next = makeMove(s.game, from, to, promotion);
  if (next === s.game) return s; // 非法步原样拒绝（防御：tap 已按合法落点过滤）
  const moves = [...s.moves, promotion ? { from, to, promotion } : { from, to }];
  const states = [...s.states, next];
  const done = stage.goal.check({ start: s.start, moves, states });
  let toast: string | null = null;
  if (!done) {
    if (next.status === 'draw' && next.reason === 'stalemate') {
      toast = '逼和了：对方无子可动且未被将军。点「重玩本阶段」再来一次';
    } else if (stage.goal.kind === 'sequence') {
      toast = '这步不在提示的着法里：可悔棋一步回到正轨，或重玩本阶段';
    }
    // 其余类型不逐手提示（中间着法是自由发挥），到达目标即过关
  }
  return { ...s, game: next, moves, states, selected: -1, pending: null, done, toast };
}

export function lessonsReducer(s: LessonsState, action: LessonsAction): LessonsState {
  switch (action.type) {
    case 'openLesson': {
      if (!getLesson(action.id)) return s;
      return stageState(action.id, 0, s.completed);
    }
    case 'backToMenu':
      return { ...s, view: 'menu', lessonId: null, selected: -1, pending: null, toast: null };
    case 'restartStage': {
      if (s.view !== 'lesson' || !s.lessonId) return s;
      return stageState(s.lessonId, s.stageIdx, s.completed);
    }
    case 'tap': {
      if (s.view !== 'lesson' || s.done || s.pending) return s; // 完成态 / 升变浮层期锁盘
      const { game } = s;
      // 逼和等和棋终局：点棋盘只清选择，交给"重玩本阶段"按钮
      if (game.status !== 'playing') return { ...s, selected: -1, toast: null };
      const { idx } = action;
      // 已有选中：点到合法落点 → 升变步先弹浮层，其余走子并判定
      if (s.selected >= 0 && s.selected !== idx && legalTargets(game, s.selected).includes(idx)) {
        if (needsPromotion(game, s.selected, idx)) {
          return { ...s, pending: { from: s.selected, to: idx }, toast: null };
        }
        return applyMove(s, s.selected, idx);
      }
      // 再点同一子取消选择
      if (s.selected === idx) return { ...s, selected: -1, toast: null };
      // 点己方棋子：选中（零合法步时复用第九节提示文案）
      const piece = game.board[idx];
      if (piece !== 0 && sideOf(piece) === game.current) {
        const reason = explainSelection(game, idx);
        return { ...s, selected: idx, toast: reason ? toastText({ kind: 'hint', reason }) : null };
      }
      // 点对方棋子（非落点）：取消选择并提示当前轮次
      if (piece !== 0) {
        return { ...s, selected: -1, toast: toastText({ kind: 'turn', side: game.current }) };
      }
      // 点空处：仅取消选择
      return { ...s, selected: -1, toast: null };
    }
    case 'promote': {
      if (!s.pending) return s;
      const { from, to } = s.pending;
      // makeMove 会对非法升变子同引用拒绝，此处传入浮层选择结果
      return applyMove({ ...s, pending: null }, from, to, action.piece);
    }
    case 'cancelPromotion':
      // 取消：回到选子前状态，可改走别的步
      return { ...s, selected: -1, pending: null, toast: null };
    case 'undoMove': {
      // 悔棋一步：弹出引擎快照并回退累计着法（完成态不可悔棋，走错重试专用）
      if (s.moves.length === 0) return s;
      return {
        ...s,
        game: undo(s.game),
        moves: s.moves.slice(0, -1),
        states: s.states.slice(0, -1),
        selected: -1,
        pending: null,
        done: false,
        toast: null,
      };
    }
    case 'clearToast':
      return { ...s, toast: null };
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
