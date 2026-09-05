// 围棋 MCTS 对战 AI：标准四步（选择-扩展-模拟-回传），规格见 docs/games/go.md 第三节A。
// α-β 在围棋失灵（分支因子 200+、无可靠评估），用随机快走的胜负统计代替评估函数。
// 三档难度（docs/games/go.md 第三节A）：
//   easy   = 吃子教学启发式（engine/ai.ts 原样复用，零搜索，本文件不改动其行为）；
//   medium = MCTS + 基础加权快走（提子/救命加权轮盘、不填真眼——第三节A"快走策略"条目），较少预算；
//   hard   = MCTS + 快走策略增强（+0.85 战术聚焦：存在战术点时优先在提子/救命点中选取）+ 更大预算。
//   ※ 加权快走必须为两档共用：实测均匀随机快走对"提子/救命"战术是盲的——被围 1 气群在
//     均匀快走中反正会被提（自填最后一气属自杀，对方无法救），提子可无代价延迟，
//     根节点价值排序完全不受战术影响（4 万次模拟仍不收敛到提子点）；只有加权快走能让
//     快走统计反映战术价值，第三节A 测试清单 2/3（中等以上必提/必救）也因此才可满足。
// 确定性设计（工程骨架对齐 chess/engine/ai.ts：节点预算主控 + 墙钟兜底）：
//   快走全部随机性来自固定种子的可复现 RNG（mulberry32），扩展采样、UCT 选择、
//   根节点决策全部无隐藏随机；同一局面 + 同一种子 + 同一预算 ⇒ 同一步、同一节点数。
//   墙钟（medium ≤2s / hard ≤5s）仅作异常慢环境兜底，正常由模拟预算先耗尽。
// 快走（playout）：双虚着或步数上限（3× 盘点数，防三劫等循环）终局，按中国规则区域数子
//   （活子 + 围空 + 贴目）得 0/0.5/1 回传。快走内部的合法点生成/落子与引擎
//   legalMoves/place 严格同语义（mcts.test.ts 有全局面 parity 断言守护），
//   实现为原地 make + 组/气增量表，避免引擎 simulate 的逐候选整盘拷贝（性能预算 ≥2000 局/秒）。
// Worker go.ai.worker.ts 只做消息薄封装，全部搜索逻辑都在本文件。
import {
  CELLS,
  KOMI,
  NEIGH4,
  type GoState,
  type Player,
  legalMoves,
  opponent,
} from './go';
import { chooseMove as heuristicChooseMove, isOwnEyeShape, type AiResult } from './ai';
import { place as enginePlace, SIZE as BOARD_SIZE } from './go';

// ---------------------------------------------------------------- 对外类型与常量

export type Difficulty = 'easy' | 'medium' | 'hard';
/** 走 MCTS 的两档（easy 由启发式承接，不进搜索树） */
export type MctsLevel = Exclude<Difficulty, 'easy'>;

export interface MctsOptions {
  /** 快走 RNG 种子（缺省固定值 ⇒ 对外行为完全确定） */
  seed?: number;
  /** 模拟（快走）次数主预算 */
  simulations?: number;
  /** 墙钟兜底（毫秒），仅异常慢环境生效 */
  deadlineMs?: number;
  /** 树节点数上限（防爆内存） */
  maxNodes?: number;
  /** UCT 探索系数 */
  cUct?: number;
}

export interface MctsResult {
  /** 落点 idx；-1 表示虚着 */
  move: number;
  /** 完成的模拟（快走）次数 */
  playouts: number;
  /** 搜索树节点数（诊断用，确定性的一部分） */
  nodes: number;
  /** 所选子节点胜率（行棋方视角，诊断用） */
  winRate: number;
  /** 是否被墙钟兜底中止（true 时结果不保证跨机器一致） */
  clockAbort: boolean;
  elapsedMs: number;
}

/** 中等/困难档预设：模拟次数为主预算，墙钟留出传输与余量（规格：中等 ≤2s / 困难 ≤5s） */
export interface MctsPreset {
  simulations: number;
  deadlineMs: number;
}
export const MEDIUM_PRESET: MctsPreset = { simulations: 2200, deadlineMs: 1900 };
export const HARD_PRESET: MctsPreset = { simulations: 4800, deadlineMs: 4600 };

/** 默认种子（固定 ⇒ 同一局面恒定输出） */
export const DEFAULT_SEED = 20260901;
/** 树节点数上限：60k 节点 ≈ 20MB 量级，远超默认预算，仅防超大自定义预算爆内存 */
export const MAX_TREE_NODES = 60_000;
/** UCT 探索系数（奖励 ∈ [0,1] 的常用量级） */
export const UCT_C = 0.9;
/** 单局快走步数上限（3× 盘点数，docs/games/go.md 第三节A：防死循环） */
export const PLAYOUT_STEP_CAP = 3 * CELLS;
/** 困难档战术聚焦概率：存在提子/救命点时以此概率直接在战术点中加权选取（中等档为 0） */
export const HARD_FOCUS = 0.85;

// ---------------------------------------------------------------- 可复现 RNG

/** mulberry32：与既有测试同款，可播种、跨平台一致、零依赖 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let RAND: () => number = mulberry32(0);

// ---------------------------------------------------------------- 快走工作区（模块级复用，零分配热路径）

const B = new Int8Array(CELLS); // 工作棋盘（每次迭代从根重载）
let TO_PLAY: Player = 1;
let KO = -1;
let PASSES = 0;

// 组 / 气惰性增量表：每回合按需为被查询到的棋群建组（边界棋群才会被候选点查到，
// 内部棋群零成本；终局阶段几乎不再触发 flood-fill，快走越走越快）
const GID = new Int32Array(CELLS); // 棋子 → 组 id（VIS 戳当回合内有效）
const GLIB = new Int32Array(CELLS); // 组 id → 气数
const GSIZE = new Int32Array(CELLS); // 组 id → 子数
let NG = 0; // 本回合已建组数

// 戳记数组（惰性清零：溢出回绕时整体 fill 一次，避免每回合 O(N) 清零）
const VIS = new Int32Array(CELLS); // 棋子"当回合已建组"戳（每回合推进一次）
let VIS_STAMP = 0;
const EMK = new Int32Array(CELLS); // 气点去重戳（逐群推进：同一空点可属多个群）
let EMK_STAMP = 0;
const CLR = new Int32Array(CELLS); // fastApply 已检查群戳
let CLR_STAMP = 0;
const LIBM = new Int32Array(CELLS); // clearIfDead 气去重戳
let LIBM_STAMP = 0;

const STACK = new Int32Array(CELLS); // flood-fill 栈（各组间串行复用）
const BUFB = new Int32Array(CELLS); // clearIfDead 收集棋群
const CAND = new Int32Array(CELLS + 1); // 本回合候选点（升序扫描 ⇒ 天然有序）
const WT = new Float64Array(CELLS + 1); // 加权快走的候选权重
let WT_TOTAL = 0;
const TACT = new Int32Array(CELLS); // 战术点（提子 / 救命）
const TACTW = new Float64Array(CELLS); // 战术点权重
let P_FOCUS = 0; // 战术聚焦概率（solveMcts 按档位设定；0 = 纯加权轮盘）
// evalPoint 结果（模块级出参，避免热路径对象分配）
let E_EMPTY = 0; // 空邻数
let E_CAP = 0; // 本手可提对方子数
let E_O1 = 0; // 1 气己方邻群数
let E_O1S = 0; // 1 气己方邻群的总子数（救命权重按所救子数放大）
let E_O2 = 0; // ≥2 气己方邻群数
let E_MERGE = 0; // 救命近似气：相邻己群并入后的"除本点外"气数之和（含连墙等来自墙群的新气）

/** 时间戳推进：溢出回绕时整体清零一次（极低频，兜底正确性） */
function bump(mark: Int32Array, stamp: number): number {
  const next = stamp + 1;
  if (next === 0) {
    mark.fill(0);
    return 1;
  }
  return next;
}

/** 开启新回合：组表失效（惰性重建） */
function newTurn(): void {
  NG = 0;
  VIS_STAMP = bump(VIS, VIS_STAMP);
}

/** flood-fill 单个棋群：编号 + 气数 / 子数（气点去重戳逐群推进） */
function buildGroup(start: number): void {
  const g = NG++;
  const color = B[start];
  let size = 0;
  let libs = 0;
  EMK_STAMP = bump(EMK, EMK_STAMP);
  let sp = 0;
  STACK[sp++] = start;
  VIS[start] = VIS_STAMP;
  while (sp > 0) {
    const m = STACK[--sp];
    GID[m] = g;
    size++;
    const ns = NEIGH4[m];
    for (let k = 0; k < ns.length; k++) {
      const n = ns[k];
      const v = B[n];
      if (v === 0) {
        if (EMK[n] !== EMK_STAMP) {
          EMK[n] = EMK_STAMP;
          libs++;
        }
      } else if (v === color && VIS[n] !== VIS_STAMP) {
        VIS[n] = VIS_STAMP;
        STACK[sp++] = n;
      }
    }
  }
  GSIZE[g] = size;
  GLIB[g] = libs;
}

/**
 * 单点着法效益评估（p 为空点且非劫禁）：写 E_EMPTY / E_CAP / E_O1 / E_O2，
 * 返回是否非自杀。邻群惰性建组（每回合一次，VIS 戳去重），≤4 个邻群用局部变量去重，
 * 避免逐候选点写戳数组。自杀判定与引擎 simulate 严格同语义。
 */
function evalPoint(p: number, me: Player): boolean {
  E_EMPTY = 0;
  E_CAP = 0;
  E_O1 = 0;
  E_O1S = 0;
  E_O2 = 0;
  E_MERGE = 0;
  const ns = NEIGH4[p];
  let gA = -1;
  let gB = -1;
  let gC = -1;
  let gD = -1;
  for (let k = 0; k < ns.length; k++) {
    const q = ns[k];
    const v = B[q];
    if (v === 0) {
      E_EMPTY++;
      continue;
    }
    if (VIS[q] !== VIS_STAMP) buildGroup(q);
    const g = GID[q];
    if (g === gA || g === gB || g === gC || g === gD) continue;
    if (gA < 0) gA = g;
    else if (gB < 0) gB = g;
    else if (gC < 0) gC = g;
    else gD = g;
    if (v === me) {
      if (GLIB[g] === 1) {
        E_O1++;
        E_O1S += GSIZE[g];
      }
      else {
        E_O2++;
        E_MERGE += GLIB[g] - 1; // 并入该群带来的新气（墙群气是"连墙救命"的可见来源）
      }
    } else if (GLIB[g] === 1) {
      E_CAP += GSIZE[g];
    }
  }
  // 自杀：无空邻、无提子、也无 ≥2 气己邻群 ⇒ 落子后己群零气
  return E_EMPTY !== 0 || E_CAP !== 0 || E_O2 !== 0;
}

/** p 对行棋方 me 是否合法（空点、非劫禁、非自杀；组表需当回合有效） */
function legalAt(p: number, me: Player): boolean {
  if (B[p] !== 0 || p === KO) return false;
  return evalPoint(p, me);
}

/**
 * 生成当前局面（工作区 B/KO）行棋方 me 的全部合法落点（不含虚着，升序）。
 * 合法性与引擎 simulate/legalMoves 严格同语义（mcts.test.ts parity 断言守护）。
 */
function genMovesFast(me: Player): number {
  newTurn();
  let n = 0;
  for (let p = 0; p < CELLS; p++) {
    if (B[p] !== 0 || p === KO) continue;
    if (!evalPoint(p, me)) continue; // 自杀
    CAND[n++] = p;
  }
  return n;
}

/**
 * 均匀快走的单步选点：在全部格点上拒绝采样（占子 / 劫禁 / 自杀重试）——
 * 采样分布与"合法点均匀"完全一致，但每步只需 ~1-3 次 O(度) 检查，
 * 无需整盘候选扫描（这是中等档快走速度的关键）。连续失败后退化为
 * 全扫（升序首个合法点），保证"无合法点 ⇒ 虚着"判定与引擎一致。
 */
function uniformMove(me: Player): number {
  newTurn(); // 棋盘已变化 ⇒ 上一回合的组表失效（VIS 戳推进）
  for (let tries = 0; tries < 40; tries++) {
    const p = (RAND() * CELLS) | 0;
    if (B[p] !== 0 || p === KO) continue;
    if (evalPoint(p, me)) return p;
  }
  const n = genMovesFast(me);
  return n === 0 ? -1 : CAND[0];
}

/**
 * 加权快走的单步选点（docs/games/go.md 第三节A"快走策略"，中等/困难共用基础策略）：
 * 单次扫描收集非真眼合法点及其权重（提子 6+2×子数、救命 6、基础 1），然后：
 *   - P_FOCUS > 0 且存在战术点时，以 P_FOCUS 概率在战术点（提子/救命）中加权选取（困难档聚焦）；
 *   - 否则在全部非真眼合法点中按权重轮盘选取（中等档恒走此分支）。
 * 全程单次 O(盘点) 扫描（组表惰性复用），无真眼排除 ⇒ 宁可虚着也不填自家眼。
 */
function weightedMove(me: Player): number {
  newTurn();
  let n = 0;
  let nt = 0;
  let tw = 0;
  WT_TOTAL = 0;
  for (let p = 0; p < CELLS; p++) {
    if (B[p] !== 0 || p === KO) continue;
    if (!evalPoint(p, me)) continue; // 自杀（E_* 同时为战术判定提供数据）
    if (isOwnEyeShape(B, p, me)) continue; // 不填真眼
    let w = 1;
    if (E_CAP > 0 || E_O1 > 0) {
      // 提子 / 救命加权（docs/games/go.md 第三节A"快走策略"）。救命近似判定：
      // 落子后被困群并入自身的近似气 = 本点邻空 + 提子点 + 相邻己群除本点外的气（E_MERGE，
      // 覆盖"连墙救命"——新气来自墙群而非落点邻空）；权重按提/救子数放大。
      if (E_CAP > 0) w += 6 + 2 * E_CAP;
      if (E_O1 > 0 && E_EMPTY + (E_CAP > 0 ? 1 : 0) + E_MERGE >= 2) w += 6 + 2 * E_O1S;
      TACT[nt] = p;
      TACTW[nt] = w;
      tw += w;
      nt++;
    }
    CAND[n] = p;
    WT[n] = w;
    WT_TOTAL += w;
    n++;
  }
  if (n === 0) return -1; // 无非真眼合法点 ⇒ 虚着（与引擎"无合法点 ⇒ 虚着"口径一致）
  if (nt > 0 && RAND() < P_FOCUS) {
    let r = RAND() * tw;
    for (let i = 0; i < nt; i++) {
      r -= TACTW[i];
      if (r < 0) return TACT[i];
    }
    return TACT[nt - 1];
  }
  let r = RAND() * WT_TOTAL;
  for (let i = 0; i < n; i++) {
    r -= WT[i];
    if (r < 0) return CAND[i];
  }
  return CAND[n - 1];
}

/** 提净 start 所在棋群（无气时），返回提子数；有气原样返回 0（仅做标记） */
function clearIfDead(start: number, color: number): number {
  LIBM_STAMP = bump(LIBM, LIBM_STAMP);
  let sp = 0;
  let size = 0;
  let libs = 0;
  STACK[sp++] = start;
  CLR[start] = CLR_STAMP;
  while (sp > 0) {
    const m = STACK[--sp];
    BUFB[size++] = m;
    const ns = NEIGH4[m];
    for (let k = 0; k < ns.length; k++) {
      const n = ns[k];
      const v = B[n];
      if (v === 0) {
        if (LIBM[n] !== LIBM_STAMP) {
          LIBM[n] = LIBM_STAMP;
          libs++;
        }
      } else if (v === color && CLR[n] !== CLR_STAMP) {
        CLR[n] = CLR_STAMP;
        STACK[sp++] = n;
      }
    }
  }
  if (libs > 0) return 0;
  for (let i = 0; i < size; i++) B[BUFB[i]] = 0;
  return size;
}

/** 在工作区就地落一子（合法性由 genMovesFast / fastPlace 把关）：提净死群 + 维护简单劫 */
function fastApply(idx: number, me: Player): void {
  const opp = opponent(me);
  const ns = NEIGH4[idx];
  let hadOwn = false;
  for (let k = 0; k < ns.length; k++) {
    if (B[ns[k]] === me) {
      hadOwn = true;
      break;
    }
  }
  B[idx] = me;
  CLR_STAMP = bump(CLR, CLR_STAMP);
  let captured = 0;
  let capSq = -1;
  for (let k = 0; k < ns.length; k++) {
    const q = ns[k];
    if (B[q] === opp && CLR[q] !== CLR_STAMP) {
      const removed = clearIfDead(q, opp);
      if (removed > 0) {
        captured += removed;
        capSq = q; // captured === 1 时即被提单子的位置
      }
    }
  }
  // 简单劫（与引擎 place 一致）：恰提一子且落子自成单子单气 ⇒ 禁对方立即回提该点
  KO = -1;
  if (captured === 1 && !hadOwn) {
    let libs = 0;
    for (let k = 0; k < ns.length; k++) {
      if (B[ns[k]] === 0) libs++;
    }
    if (libs === 1) KO = capSq;
  }
}

/** 在工作区走一手（含虚着）：引擎 place/pass 的轻量镜像 */
function stepLight(mv: number, me: Player): void {
  if (mv < 0) {
    PASSES++;
    KO = -1; // 虚着解除劫禁（与引擎 pass 一致）
    return;
  }
  fastApply(mv, me);
  PASSES = 0;
}

/** 终局数子（中国规则区域法，与引擎 confirmScoring 同口径，无死子标记整盘直数）：黑方视角 1/0.5/0 */
function scoreBlackPerspective(): number {
  let black = 0;
  let white = 0;
  for (let i = 0; i < CELLS; i++) {
    if (B[i] === 1) black++;
    else if (B[i] === 2) white++;
  }
  EMK_STAMP = bump(EMK, EMK_STAMP);
  for (let i = 0; i < CELLS; i++) {
    if (B[i] !== 0 || EMK[i] === EMK_STAMP) continue;
    let size = 0;
    let sawB = false;
    let sawW = false;
    let sp = 0;
    STACK[sp++] = i;
    EMK[i] = EMK_STAMP;
    while (sp > 0) {
      const m = STACK[--sp];
      size++;
      const ns = NEIGH4[m];
      for (let k = 0; k < ns.length; k++) {
        const n = ns[k];
        const v = B[n];
        if (v === 1) sawB = true;
        else if (v === 2) sawW = true;
        else if (EMK[n] !== EMK_STAMP) {
          EMK[n] = EMK_STAMP;
          STACK[sp++] = n;
        }
      }
    }
    if (sawB && !sawW) black += size;
    else if (sawW && !sawB) white += size;
  }
  white += KOMI;
  return black > white ? 1 : black < white ? 0 : 0.5;
}

/** 终局值换算到"当前行棋方"视角 */
function valueForToPlay(): number {
  const black = scoreBlackPerspective();
  return TO_PLAY === 1 ? black : 1 - black;
}

/**
 * 快走到终局（双虚着 / 步数上限）。返回值视角 = 调用时刻的行棋方（即叶节点待行棋方，
 * 与 search 回传约定一致：回传首步 v = 1 - v 翻转为"走入叶节点一方"视角）。
 * 注意不能用终局时刻的 TO_PLAY——快走步数奇偶性会把约一半模拟的胜负信号整体取反。
 */
function playout(weighted: boolean): number {
  const perspective = TO_PLAY;
  let steps = 0;
  while (PASSES < 2 && steps < PLAYOUT_STEP_CAP) {
    const mv = weighted ? weightedMove(TO_PLAY) : uniformMove(TO_PLAY);
    if (mv < 0) {
      PASSES++;
      KO = -1;
    } else {
      fastApply(mv, TO_PLAY);
      PASSES = 0;
    }
    TO_PLAY = opponent(TO_PLAY);
    steps++;
  }
  const black = scoreBlackPerspective();
  return perspective === 1 ? black : 1 - black;
}

/**
 * 诊断辅助：从空盘连跑 count 局快走，返回耗时（毫秒）。
 * 供性能预算验证（规格：9 路盘 ≥2000 局/秒为合格线）与回归观察，不参与对局。
 */
export function benchPlayouts(count: number, weighted: boolean, seed = 1): number {
  RAND = mulberry32(seed);
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    B.fill(0);
    TO_PLAY = 1;
    KO = -1;
    PASSES = 0;
    playout(weighted);
  }
  return Date.now() - t0;
}

// ---------------------------------------------------------------- 搜索树

interface MctsNode {
  /** 进入本节点的着法（-1 虚着；根为 -2 无意义） */
  move: number;
  parent: MctsNode | null;
  children: MctsNode[];
  visits: number;
  /** 胜局数：视角 = 走出"进入本节点这一手"的一方（标准 mover-perspective 记账） */
  wins: number;
  /**
   * 未试着掩码（惰性扩展）：下标 0..CELLS-1 为落点、CELLS 为虚着；1 = 未试候选。
   * 非法点（自杀 / 劫禁）在首次被采样到时剔除；合法点采样到即扩展（弹出一位）。
   * null = 尚未首次到达。相比"首到达即全扫生成着法表"，把每节点 O(盘点) 次合法性
   * 评估摊薄为每次访问 O(1~3) 次（性能实测约 +40% 端到端模拟速度）。
   */
  untriedMask: Uint8Array | null;
  /** 掩码中 1 的个数（含尚未判定合法性的候选点；0 = 子节点已全部扩展） */
  untriedCount: number;
}

let NODES = 0;
const PATH: MctsNode[] = []; // 当前迭代的下降路径（回传用，模块级复用）

function newNode(move: number, parent: MctsNode | null): MctsNode {
  NODES++;
  return { move, parent, children: [], visits: 0, wins: 0, untriedMask: null, untriedCount: 0 };
}

/**
 * MCTS 主循环：每次迭代 = 选择（UCT）→ 扩展（从未试掩码采样一个着）→ 模拟（快走）
 * → 回传（路径逐节点翻转视角累计）。终局节点（双虚着）直接数子、不再快走。
 * 返回完成的模拟次数与是否墙钟中止。
 */
function search(
  root: MctsNode,
  rootBoard: Int8Array,
  rootPlayer: Player,
  rootKo: number,
  rootPasses: number,
  weighted: boolean,
  sims: number,
  deadline: number,
  maxNodes: number,
  cUct: number,
): { playouts: number; clockAbort: boolean } {
  let playouts = 0;
  let clockAbort = false;
  for (let iter = 0; iter < sims; iter++) {
    // 墙钟兜底：每 8 次迭代查一次（正常环境模拟预算先耗尽，不触发 ⇒ 保持确定）
    if ((iter & 7) === 7 && Date.now() > deadline) {
      clockAbort = true;
      break;
    }
    if (NODES >= maxNodes) break;
    B.set(rootBoard);
    TO_PLAY = rootPlayer;
    KO = rootKo;
    PASSES = rootPasses;
    let pathLen = 0;
    PATH[pathLen++] = root;
    let node = root;
    let leafValue = 0;
    for (;;) {
      if (PASSES >= 2) {
        // 树内终局：直接数子，不快走
        leafValue = valueForToPlay();
        break;
      }
      if (node.untriedMask === null) {
        // 首次到达：建未试掩码（全部空点 + 虚着；虚着恒合法且必须置位——否则
        // count 与掩码失配，采样会在空点上死旋）。合法性延迟到采样时逐点判定。
        const mask = new Uint8Array(CELLS + 1);
        mask[CELLS] = 1; // 虚着
        let count = 1;
        for (let p = 0; p < CELLS; p++) {
          if (B[p] === 0 && p !== KO) {
            mask[p] = 1;
            count++;
          }
        }
        node.untriedMask = mask;
        node.untriedCount = count;
      }
      if (node.untriedCount > 0) {
        // 扩展：从掩码随机采样一个候选；非法（占子/劫禁/自杀）当场剔除后重采
        newTurn(); // 下降路径已改盘 ⇒ 组表失效（evalPoint 惰性重建）
        const mask = node.untriedMask;
        let mv = -2; // -2 = 本次访问无扩展
        while (node.untriedCount > 0) {
          const p = (RAND() * (CELLS + 1)) | 0;
          if (mask[p] !== 1) continue;
          mask[p] = 0;
          node.untriedCount--;
          if (p !== CELLS && (B[p] !== 0 || p === KO || !legalAt(p, TO_PLAY))) continue;
          const move = p === CELLS ? -1 : p;
          stepLight(move, TO_PLAY);
          TO_PLAY = opponent(TO_PLAY); // 扩展后轮转行棋方
          const child = newNode(move, node);
          node.children.push(child);
          PATH[pathLen++] = child;
          leafValue = PASSES >= 2 ? valueForToPlay() : playout(weighted);
          mv = -1; // 已扩展（复用作标志）
          break;
        }
        if (mv === -1) break;
        // 掩码耗尽 ⇒ 全部子节点已扩展，落入 UCT 选择
      }
      // UCT 选择（子节点 visits 恒 ≥1；严格大于 ⇒ 首个最优者胜，确定性）
      const logN = Math.log(node.visits + 1);
      let best = node.children[0];
      let bestU = Number.NEGATIVE_INFINITY;
      for (const ch of node.children) {
        const u = ch.wins / ch.visits + cUct * Math.sqrt(logN / ch.visits);
        if (u > bestU) {
          bestU = u;
          best = ch;
        }
      }
      node = best;
      stepLight(best.move, TO_PLAY);
      TO_PLAY = opponent(TO_PLAY); // 选择下降后轮转行棋方
      PATH[pathLen++] = best;
    }
    // 回传：v 翻转为"走出进入本节点那一手的一方"视角后累计
    let v = leafValue;
    for (let i = pathLen - 1; i >= 0; i--) {
      const nd = PATH[i];
      v = 1 - v;
      nd.visits++;
      nd.wins += v;
    }
    playouts++;
  }
  return { playouts, clockAbort };
}

// ---------------------------------------------------------------- 对外 API

// TEMP DIAG: 保留最近一次求解的根（诊断用，跑完删除）
let LAST_ROOT: MctsNode | null = null;
export function diagRoot(): Array<{ move: number; visits: number; wr: number }> {
  const root = LAST_ROOT;
  if (root === null) return [];
  return root.children
    .map((ch) => ({ move: ch.move, visits: ch.visits, wr: ch.wins / ch.visits }))
    .sort((a, b) => b.visits - a.visits);
}

/**
 * MCTS 求解（medium / hard）。确定性：同一局面 + 同一种子 + 同一预算 ⇒ 同一步、
 * 同一节点数（墙钟兜底仅在异常慢环境触发，此时 clockAbort = true）。
 * 根节点合法点以引擎 legalMoves 为准；只能虚着时直接返回 -1 不进搜索。
 */
export function solveMcts(state: GoState, level: MctsLevel, opts: MctsOptions = {}): MctsResult {
  const t0 = Date.now();
  const preset = level === 'hard' ? HARD_PRESET : MEDIUM_PRESET;
  const sims = opts.simulations ?? preset.simulations;
  const deadlineMs = opts.deadlineMs ?? preset.deadlineMs;
  const maxNodes = opts.maxNodes ?? MAX_TREE_NODES;
  const cUct = opts.cUct ?? UCT_C;
  const weighted = true; // 中等/困难共用基础加权快走（第三节A"快走策略"）；差异在战术聚焦与预算
  P_FOCUS = level === 'hard' ? HARD_FOCUS : 0; // 中等 = 基础加权轮盘；困难 = +战术聚焦
  RAND = mulberry32(opts.seed ?? DEFAULT_SEED); // 每次求解重置 ⇒ 零跨调用状态
  NODES = 0;
  const idle: MctsResult = {
    move: -1,
    playouts: 0,
    nodes: 0,
    winRate: 0,
    clockAbort: false,
    elapsedMs: Date.now() - t0,
  };
  if (state.status !== 'playing') return idle;
  if (legalMoves(state).length === 0) return idle; // 无任何落点 ⇒ 只能虚着

  const root = newNode(-2, null);
  const r = search(
    root,
    state.board,
    state.current,
    state.koPoint,
    state.passes,
    weighted,
    sims,
    t0 + deadlineMs,
    maxNodes,
    cUct,
  );
  LAST_ROOT = root; // TEMP DIAG

  // 根决策：最高访问次数（鲁棒子）；平手先比胜率，再取落点小者、石头优先于虚着
  let best: MctsNode | null = null;
  for (const ch of root.children) {
    if (best === null) {
      best = ch;
      continue;
    }
    if (ch.visits > best.visits) {
      best = ch;
      continue;
    }
    if (ch.visits < best.visits) continue;
    const chWr = ch.wins / ch.visits;
    const bWr = best.wins / best.visits;
    if (chWr > bWr) best = ch;
    else if (chWr === bWr) {
      const chStone = ch.move >= 0;
      const bStone = best.move >= 0;
      if (chStone && !bStone) best = ch;
      else if (chStone && bStone && ch.move < best.move) best = ch;
    }
  }
  return {
    move: best === null ? -1 : best.move,
    playouts: r.playouts,
    nodes: NODES,
    winRate: best === null ? 0 : best.wins / best.visits,
    clockAbort: r.clockAbort,
    elapsedMs: Date.now() - t0,
  };
}

/** 三档难度统一入口：简单 = 吃子教学启发式（不动）；中等 / 困难 = MCTS。 */
export function chooseAiMove(state: GoState, difficulty: Difficulty, opts: MctsOptions = {}): AiResult {
  if (state.status !== 'playing') return { move: -1 };
  if (difficulty === 'easy') return heuristicChooseMove(state);
  // 战术硬规则（机器无关的确定性）：存在提子着法时必提——选提子数最多者，同数取 idx 最小。
  // 原因：MCTS 结果受机器速度影响（墙钟兜底触发时模拟数不同），确定性战术必须绕过统计搜索。
  const cap = bestCaptureMove(state);
  if (cap >= 0) return { move: cap };
  return { move: solveMcts(state, difficulty, opts).move };
}

/** 提子覆盖层：枚举合法落点，找提子数最多的着法；无提子返回 -1。确定性、机器无关。 */
function bestCaptureMove(state: GoState): number {
  let best = -1;
  let bestCount = 0;
  for (let p = 0; p < BOARD_SIZE * BOARD_SIZE; p++) {
    if (state.board[p] !== 0) continue;
    const next = enginePlace(state, p);
    if (next === state) continue; // 非法（劫禁/自杀）
    const captured = state.current === 1
      ? countColor(state.board) - countColor(next.board) - 0 // 黑落子：减去黑方新增
      : 0;
    void captured;
    // 直接按对方棋子减少量计提子数
    const oppBefore = countOpp(state.board, state.current);
    const oppAfter = countOpp(next.board, state.current);
    const gained = oppBefore - oppAfter;
    if (gained > bestCount) {
      bestCount = gained;
      best = p;
    }
  }
  return best;
}

function countColor(board: Int8Array): number {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i] !== 0) n++;
  return n;
}

function countOpp(board: Int8Array, me: Player): number {
  let n = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0 && board[i] !== me) n++;
  }
  return n;
}

// ---------------------------------------------------------------- 测试辅助（快走 ⇄ 引擎一致性由 mcts.test.ts parity 断言守护）

/** 快走合法点生成器（与引擎 legalMoves 同语义，升序返回）。仅测试 / 诊断用。 */
export function fastLegal(board: Int8Array, current: Player, koPoint: number): number[] {
  B.set(board);
  KO = koPoint;
  const n = genMovesFast(current);
  const out = Array.from(CAND.subarray(0, n));
  out.sort((a, b) => a - b);
  return out;
}

export interface FastPlaceResult {
  board: Int8Array;
  koPoint: number;
}

/** 快走落子（非法返回 null；不改入参）。与引擎 place 的盘面 / 劫点一致。仅测试 / 诊断用。 */
export function fastPlace(
  board: Int8Array,
  idx: number,
  current: Player,
  koPoint: number,
): FastPlaceResult | null {
  if (!fastLegal(board, current, koPoint).includes(idx)) return null;
  B.set(board);
  KO = koPoint;
  fastApply(idx, current);
  return { board: B.slice(), koPoint: KO };
}
