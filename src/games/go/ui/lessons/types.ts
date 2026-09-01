// 围棋学堂（docs/games/chess.md 第十三节"围棋教学 v1"）：关卡剧本系统的类型定义。
// 每关 = 初始局面（裸棋盘铺子）+ 目标条件（围棋引擎 groupAt/groupsOf 可判定的纯函数）+ 文案序列。
// 与国象学堂（chess/ui/lessons）同一套剧本模型，但围棋交互是"空点直接落子"
//（无选子 / 无升变），且棋盘渲染与规则判定均出自围棋引擎——参数化改造 chess 运行器
// 的代价高于平行实现，故按规格书"耦合过深则平行"的预案在 go 下落地（零改 chess）。
// 目标判定以"阶段累计落点 + 各手落完的局面"为输入，可在 node 环境用 place 直接单测。
import type { GoState, Player } from '../../engine/go';

/** 初始局面的一颗子：坐标标签（列 A–I 从左到右 + 行 1–9 从上到下，如 E5）+ 颜色（1 黑 / 2 白） */
export type StoneSpec = [label: string, color: Player];

/** 阶段初始局面描述：stones 直接铺成裸棋盘 + 行棋方（默认黑先） */
export interface StagePosition {
  stones: StoneSpec[];
  options?: { current?: Player };
}

/** 目标判定输入：阶段初始局面 + 累计落点 + 每手落完的局面（states[i] 与 moves[i] 对齐） */
export interface GoalContext {
  start: GoState;
  moves: number[];
  states: GoState[];
}

/**
 * 目标类型（规格书第十三节六关）：
 * capture 提子 / atari 打吃 / doubleAtari 双叫吃 / escape 逃子延气 /
 * counterCapture 反提 / twoEyes 两眼做活。
 */
export type GoalKind =
  | 'capture'
  | 'atari'
  | 'doubleAtari'
  | 'escape'
  | 'counterCapture'
  | 'twoEyes';

export interface StageGoal {
  kind: GoalKind;
  /** 任务提示（棋盘下方 🎯 一句话，告诉学员要做什么） */
  describe: string;
  /** 判定：当前累计着法是否已达成目标（纯函数，零 DOM） */
  check: (ctx: GoalContext) => boolean;
}

export interface LessonStage {
  /** 说明文案（说明→动手的讲解部分，含"照提示落子"的着法） */
  brief: string;
  /** 初始局面（裸棋盘铺子描述） */
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
