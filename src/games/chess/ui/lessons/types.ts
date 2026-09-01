// 新手学堂（docs/games/chess.md 第十一节第一步）：关卡剧本系统的类型定义。
// 每关 = 初始局面（复用引擎 position() 构造器的描述）+ 目标条件（引擎可判定的纯函数）+ 文案序列。
// 运行器（state.ts / Runner.tsx）只依赖这里的接口；目标判定以"阶段累计着法 + 各手走完局面"
// 为输入，可在 node 环境用 makeMove 直接单测。
import type { ChessState, Player, Promotion } from '../../engine/chess';

/** 阶段内的一手着法（升变步带升变子） */
export interface StageMove {
  from: number;
  to: number;
  promotion?: Promotion;
}

/** 目标判定输入：阶段初始局面 + 累计着法 + 每手走完的局面（states[i] 与 moves[i] 对齐） */
export interface GoalContext {
  start: ChessState;
  moves: StageMove[];
  states: ChessState[];
}

/**
 * 目标类型（规格书六种起步，promote 为升变教学补充）：
 * reach 走到指定格 / capture 吃掉指定子 / checkmate 完成将死 /
 * castle 完成易位 / enPassant 完成吃过路兵 / sequence 指定着法序列 / promote 完成升变。
 */
export type GoalKind =
  | 'reach'
  | 'capture'
  | 'checkmate'
  | 'castle'
  | 'enPassant'
  | 'sequence'
  | 'promote';

export interface StageGoal {
  kind: GoalKind;
  /** 任务提示（棋盘下方 🎯 一句话，告诉玩家要做什么） */
  describe: string;
  /** 判定：当前累计着法是否已达成目标（纯函数，零 DOM） */
  check: (ctx: GoalContext) => boolean;
}

/** 阶段初始局面描述：pieces/options 原样喂给引擎 position() 构造器 */
export interface StagePosition {
  pieces: Array<[string, string]>;
  /** position() 可选项：行棋方（默认白）/ 易位权利（默认 'KQkq'）/ 过路兵目标格（代数坐标） */
  options?: { current?: Player; castling?: string; enPassant?: string };
}

export interface LessonStage {
  /** 说明文案（说明→演示→动手的讲解部分，含"照提示走"的着法） */
  brief: string;
  /** 初始局面（position() 构造器描述） */
  position: StagePosition;
  /** 目标（任务判定） */
  goal: StageGoal;
  /** 完成语（目标达成后展示） */
  complete: string;
}

export interface Lesson {
  id: string;
  title: string;
  /** 关卡简介（列表卡片与进入引导） */
  intro: string;
  /** 阶段序列（每关 1~4 个阶段） */
  stages: LessonStage[];
}
