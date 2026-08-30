// 中国象棋 AI：纯函数搜索，完全确定（无随机、无 DOM 依赖），规格见 docs/games/xiangqi.md 第四节。
// 三档难度：
// - easy   深度 1 贪心：仅看己方一步后的子料+位置分静态评估，看不见对方回应（终局检测除外，
//          因此一步将杀/困毙仍可见）；新手可胜。
// - medium α-β（负极大值）深度 3 + MVV-LVA 走法排序 + 静态搜索（叶子只延伸吃子，含隔一炮架的炮吃）。
// - hard   迭代加深至深度 5（预算内）+ MVV-LVA + 杀手步/历史启发 + 静态搜索 + 根候选剪枝；
//          任意一层完成即持有当前最优步（预算耗尽随时可返回）。
// 评估：子料（车900/马400/炮450/仕相200/兵过河前100、过河后200–300）+ 位置分（兵过河深入、
//       中炮位、马边缘处罚、车过河、士象完整成对加分）；完全确定、无随机。
// 合法性：搜索内部走法生成与引擎 allLegalMoves 严格一致——牵制（车牵/飞将牵）、炮双屏 discovered
//       将军、马腿 discovered 将军、"落子成炮架"的自将等全部精确验证，其余无风险着法走快速通道
//       （可证明：落子只会遮挡攻击线，只有"腾格子"与"落进敌炮空隙"才可能新开将军）。
// 限策：节点数为主预算（保证确定性可复现），墙钟 2.6s 仅作极端情况兜底；同一局面 + 同一难度
//       ⇒ 同一步与同一节点数。
// 性能优化（规格书许可）：搜索内部使用自有 make/unmake 零分配走子与增量攻击检测；不改动引擎
//       既有公开 API，输出与引擎 allLegalMoves / place 严格一致（ai.test.ts 有 parity 断言）。
// 不做：置换表/Zobrist、长将/长捉与重复局面判定、开局库（规格书明确的后续选项）。
// Worker xiangqi.ai.worker.ts 只做消息薄封装，全部搜索逻辑都在本文件。
import {
  B_C,
  B_K,
  B_N,
  B_P,
  B_R,
  CELLS,
  COLS,
  R_C,
  R_K,
  R_N,
  R_P,
  R_R,
  type Player,
  type Status,
} from './xiangqi';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 求解入参：XiangqiState 结构兼容（board/current/status），Worker 侧可按同构对象重建 */
export interface AiPosition {
  board: Int8Array;
  current: Player;
  status: Status;
}

export interface AiMove {
  from: number;
  to: number;
}

export interface AiResult {
  /** 最优步；已终局或当前方无合法步时为 null */
  move: AiMove | null;
  /** 本次求解展开的搜索节点数（诊断用；确定性的一部分） */
  nodes: number;
  /** 完成的搜索深度（easy=1；迭代加深被预算中止时为最后完成的层，诊断用） */
  depth: number;
  /** 根节点分值（行棋方视角；将杀/困毙 = MATE_SCORE − 剩余步数，诊断用） */
  score: number;
}

/** 将杀/困毙分值基准：减去剩余步数，保证 AI 偏好更快取胜 */
export const MATE_SCORE = 1_000_000;
/** ≥ 此值即已在搜索内找到取胜路径（100 手以内），迭代加深可提前停止 */
const MATE_WIN = MATE_SCORE - 256;

const MEDIUM_DEPTH = 3;
const HARD_DEPTH = 5;
/** 单步求解节点预算（确定性主限策），实测约 1M 节点/秒，墙钟余量充足 */
export const NODE_BUDGET = 600_000;
/** 墙钟兜底（毫秒）：规格单步 ≤3s，预留传输与余量 */
const DEADLINE_MS = 2600;
/** hard 档根候选剪枝：深层迭代只搜上一轮分值最高的前 ROOT_CAND 个候选（规格要求候选剪枝） */
const ROOT_CAND = 24;
/** 搜索总层数上限（主搜索 ≤5 层 + 静态搜索延伸；够用且封顶） */
const MAX_PLY = 64;
const INF = 0x3fffffff;
/** 每层走法缓冲容量：理论极值 ~119（双车双炮各 17 + 马兵仕相将），取 160 留余量 */
const MOVE_CAP = 160;

// ---------------------------------------------------------------- 棋子类型与评估

/** 棋子类型（下标 = (编码-1) % 7）：0帅将 1仕士 2相象 3马 4车 5炮 6兵卒 */
const TYPE = new Int8Array(16);
for (let t = 0; t < 7; t++) {
  TYPE[t + 1] = t; // 红 1..7
  TYPE[t + 8] = t; // 黑 8..14
}

const at = (r: number, c: number) => r * COLS + c;
const rowOf = (i: number) => (i / COLS) | 0;
const colOf = (i: number) => i % COLS;

/**
 * 子料+位置分表（红方视角，书写顺序 r=0 为黑方底线，与引擎棋盘一致）；
 * 黑子取垂直镜像位 MIRROR[i]。七类：0帅 1仕 2相 3马 4车 5炮 6兵。
 */
const VAL_PST: Int16Array[] = [];
/** 黑子垂直镜像下标：r → 9−r */
const MIRROR = new Uint8Array(CELLS);
/** 相/象活动半场（红 r≥5，黑 r≤4） */
const HALF_OK: Uint8Array[] = [new Uint8Array(CELLS), new Uint8Array(CELLS)];

(() => {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = at(r, c);
      MIRROR[i] = at(9 - r, c);
      HALF_OK[0][i] = r >= 5 ? 1 : 0;
      HALF_OK[1][i] = r <= 4 ? 1 : 0;

      // 兵：过河前 100，过河 200–300，越深入越高，中路边卒略优
      let pawn: number;
      if (r <= 4) {
        pawn = r === 4 ? 200 : r === 3 ? 220 : r === 2 ? 240 : r === 1 ? 260 : 250;
        if (c >= 3 && c <= 5) pawn += 15;
        if (r <= 2 && c === 4) pawn += 10;
      } else {
        pawn = r === 5 ? 110 : 100;
      }
      // 马：400 + 边线处罚 + 过河推进奖励
      const knight =
        400 +
        (c === 0 || c === 8 ? -12 : c === 1 || c === 7 ? -4 : 4) +
        (r <= 1 ? 6 : r <= 4 ? 12 : r <= 6 ? 2 : -6);
      // 车：900 + 过河与中路小奖励
      const rook = 900 + (r <= 4 ? 8 : 0) + (c >= 3 && c <= 5 ? 4 : 0);
      // 炮：450 + 中炮位奖励（当头炮为核心进攻位）
      const cannon =
        450 + (c === 4 ? 20 : c === 3 || c === 5 ? 6 : 0) + (r <= 4 && c === 4 ? 6 : 0);
      // 帅：留底线中路更安全
      const king = (r === 9 ? 12 : r === 8 ? 4 : 0) + (c === 4 ? 4 : 0);

      const tables = [king, 200, 200, knight, rook, cannon, pawn];
      for (let t = 0; t < 7; t++) {
        if (!VAL_PST[t]) VAL_PST[t] = new Int16Array(CELLS);
        VAL_PST[t][i] = tables[t];
      }
    }
  }
})();

/** 吃子排序受害者分值（将不可被吃，防御性给大值），下标 = 类型 */
const VAL = [20000, 200, 200, 400, 900, 450, 100];
/** MVV-LVA 攻击方附加值（贱子吃贵子优先：兵最小），下标 = 类型 */
const LVA = [0, 2, 2, 4, 9, 5, 1];
/** 士/象成对完整加分（士象完整性） */
const PAIR_BONUS = 20;

// ---------------------------------------------------------------- 几何表（预计算）

/** 马步：落点与马腿（并行数组）；马攻击对：[马位, 马腿] 扁平对（从被攻击格出发） */
const KN_TO: Int8Array[] = [];
const KN_LEG: Int8Array[] = [];
const KN_ATK: Int8Array[] = [];
/** 相/象：田字落点与象眼（并行数组，仅界内） */
const ELE_TO: Int8Array[] = [];
const ELE_EYE: Int8Array[] = [];
/** 仕 / 帅：宫内落点（分侧） */
const ADV_TO: Int8Array[][] = [[], []];
const KG_TO: Int8Array[][] = [[], []];
/** 直线射线：RAYS[sq * 4 + d]，d：0 上 1 右 2 下 3 左 */
const RAYS: Int8Array[] = [];

(() => {
  const KNIGHT = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ] as const;
  const ELEPHANT = [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const;
  const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]] as const;
  const inPalace = (side: number, r: number, c: number) =>
    c >= 3 && c <= 5 && (side === 0 ? r >= 7 : r <= 2);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < COLS; c++) {
      const sq = at(r, c);
      const knT: number[] = [];
      const knL: number[] = [];
      const knA: number[] = [];
      for (const [dr, dc] of KNIGHT) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= 10 || nc < 0 || nc >= COLS) continue;
        // 走法视角：马腿靠马（先直后斜的那一格）
        knT.push(at(nr, nc));
        knL.push(at(r + (Math.abs(dr) === 2 ? dr / 2 : 0), c + (Math.abs(dc) === 2 ? dc / 2 : 0)));
        // 攻击视角：马位在 sq 的日字偏移处，马腿 = 马位往回退半个长轴
        knA.push(at(nr, nc));
        knA.push(at(nr + (Math.abs(dr) === 2 ? -dr / 2 : 0), nc + (Math.abs(dc) === 2 ? -dc / 2 : 0)));
      }
      KN_TO[sq] = Int8Array.from(knT);
      KN_LEG[sq] = Int8Array.from(knL);
      KN_ATK[sq] = Int8Array.from(knA);
      const elT: number[] = [];
      const elE: number[] = [];
      for (const [dr, dc] of ELEPHANT) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= 10 || nc < 0 || nc >= COLS) continue;
        elT.push(at(nr, nc));
        elE.push(at(r + dr / 2, c + dc / 2));
      }
      ELE_TO[sq] = Int8Array.from(elT);
      ELE_EYE[sq] = Int8Array.from(elE);
      for (let side = 0; side < 2; side++) {
        const adv: number[] = [];
        for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < 10 && nc >= 0 && nc < COLS && inPalace(side, nr, nc)) {
            adv.push(at(nr, nc));
          }
        }
        ADV_TO[side][sq] = Int8Array.from(adv);
        const kg: number[] = [];
        for (const [dr, dc] of DIRS) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < 10 && nc >= 0 && nc < COLS && inPalace(side, nr, nc)) {
            kg.push(at(nr, nc));
          }
        }
        KG_TO[side][sq] = Int8Array.from(kg);
      }
      for (let d = 0; d < 4; d++) {
        const [dr, dc] = DIRS[d];
        const ray: number[] = [];
        let rr = r + dr;
        let cc = c + dc;
        while (rr >= 0 && rr < 10 && cc >= 0 && cc < COLS) {
          ray.push(at(rr, cc));
          rr += dr;
          cc += dc;
        }
        RAYS[sq * 4 + d] = Int8Array.from(ray);
      }
    }
  }
})();

// ---------------------------------------------------------------- 搜索状态（模块级复用，零分配）

const S_BOARD = new Int8Array(CELLS);
let S_STM = 0; // 0 红 1 黑
const S_KING = new Int8Array(2); // [红帅格, 黑将格]

/** 悔棋栈（深度上限 MAX_PLY） */
const U_FROM = new Int16Array(MAX_PLY);
const U_TO = new Int16Array(MAX_PLY);
const U_PIECE = new Int8Array(MAX_PLY);
const U_CAP = new Int8Array(MAX_PLY);
let SP = 0; // 栈指针 = 当前 ply

/** 每层走法/评分缓冲（genMoves 写入，selection 排序原地交换） */
const MOVE_BUF: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(MOVE_CAP));
const SCORE_BUF: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(MOVE_CAP));

/** 走法编码：from | to<<7（90 格 < 128，无升变） */
const enc = (from: number, to: number): number => from | (to << 7);
const decFrom = (m: number): number => m & 127;
const decTo = (m: number): number => m >>> 7;

/** 杀手步 / 历史启发（仅 hard 档启用；每次求解前清零保证确定性） */
const KILLER = new Int32Array(MAX_PLY * 2);
const HIST = new Int32Array(2 << 14); // [行棋方<<14 | from<<7 | to]
const KILLER1_SCORE = 700_000;
const KILLER2_SCORE = 699_000;
const HISTORY_CAP = 690_000;

interface SearchCtx {
  nodes: number;
  nodeBudget: number;
  deadline: number;
  aborted: boolean;
}
let CTX: SearchCtx = { nodes: 0, nodeBudget: 0, deadline: 0, aborted: false };
let USE_HEUR = false;

// ---------------------------------------------------------------- 攻击检测

/**
 * sq 是否被 by 一方攻击（车/炮含隔一炮架、马含蹩腿、兵/卒正面与过河横吃、
 * 将帅飞将同列无遮挡）。与引擎 isAttacked 语义严格一致，仅改为表驱动 + 跟踪将位。
 */
function isAttackedFast(b: Int8Array, sq: number, by: number): boolean {
  // 兵/卒：红兵从目标下侧（r+1）正面吃，黑卒从上侧；过河后横吃
  const r = rowOf(sq);
  const c = colOf(sq);
  const pP = by === 0 ? R_P : B_P;
  const front = by === 0 ? sq + 9 : sq - 9;
  if (b[front] === pP) return true;
  if (by === 0 ? r <= 4 : r >= 5) {
    if (c > 0 && b[sq - 1] === pP) return true;
    if (c < COLS - 1 && b[sq + 1] === pP) return true;
  }
  // 马：马位在目标的日字偏移处，且马腿（靠马的直行格）为空
  const nP = by === 0 ? R_N : B_N;
  const pairs = KN_ATK[sq];
  for (let i = 0; i < pairs.length; i += 2) {
    if (b[pairs[i]] === nP && b[pairs[i + 1]] === 0) return true;
  }
  // 四个正方向：车 / 飞将（遇到的第一个子）/ 炮（隔一炮架后的第一个子）
  const rP = by === 0 ? R_R : B_R;
  const kP = by === 0 ? R_K : B_K;
  const cP = by === 0 ? R_C : B_C;
  for (let d = 0; d < 4; d++) {
    const ray = RAYS[sq * 4 + d];
    let hasScreen = false;
    for (let i = 0; i < ray.length; i++) {
      const p = b[ray[i]];
      if (p !== 0) {
        if (!hasScreen) {
          if (p === rP || (p === kP && (d === 0 || d === 2))) return true; // 飞将仅限同列
          hasScreen = true;
        } else {
          if (p === cP) return true;
          break;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- make / unmake

function make(m: number): void {
  const from = m & 127;
  const to = m >>> 7;
  const piece = S_BOARD[from];
  U_FROM[SP] = from;
  U_TO[SP] = to;
  U_PIECE[SP] = piece;
  U_CAP[SP] = S_BOARD[to];
  S_BOARD[to] = piece;
  S_BOARD[from] = 0;
  if (piece === R_K) S_KING[0] = to;
  else if (piece === B_K) S_KING[1] = to;
  SP++;
  S_STM ^= 1; // 行棋方翻转：子节点 = 对手视角（genMoves / evaluate / qsearch 都依赖）
}

function unmake(): void {
  S_STM ^= 1;
  SP--;
  const from = U_FROM[SP];
  const to = U_TO[SP];
  const piece = U_PIECE[SP];
  S_BOARD[from] = piece;
  S_BOARD[to] = U_CAP[SP];
  if (piece === R_K) S_KING[0] = from;
  else if (piece === B_K) S_KING[1] = from;
}

// ---------------------------------------------------------------- 合法步生成（威胁感知）

/** 本次 genMoves 的"风险格"印章：腾开该格会给己方将/帅新开将军（牵制/炮屏/马腿） */
const UNSAFE = new Uint16Array(CELLS);
/**
 * 落点级风险格印章：敌炮是己方王某条射线上的首子且与王之间有空格时，
 * 我方任何子落入该空格都会成为炮架、凭空新开炮将军（引擎 isSafeAfter 会拒绝这类步，
 * 快速通道必须同样拒绝——parity 关键）。
 */
const LAND_UNSAFE = new Uint16Array(CELLS);
let STAMP = 0;
/** genMoves 结果：行棋方是否正被将军（无合法步时区分将死/困毙——均为判负） */
let GEN_IN_CHECK = false;

/** 非王棋子 from→to 后己方将是否安全（拔子试格，精确 ground truth） */
function pieceSafe(from: number, to: number, piece: number, kSq: number, them: number): boolean {
  const b = S_BOARD;
  const cap = b[to];
  b[from] = 0;
  b[to] = piece;
  const ok = !isAttackedFast(b, kSq, them);
  b[to] = cap;
  b[from] = piece;
  return ok;
}

/**
 * 非王着法放行判定：被将军或源格属风险格（牵制/炮屏/马腿腾格）时必须验证；
 * 安静步落入"敌炮空隙"落点风险格（LAND_UNSAFE）同样必须验证——落子成为炮架
 * 会凭空新开炮将军。吃子落在已有子上、不改变任何遮挡，无落点风险。
 * 其余着法走快速通道（可证明：落子只会遮挡攻击线，不可能新开将军）。
 */
function moveLegal(
  from: number,
  to: number,
  piece: number,
  kSq: number,
  them: number,
  mustVerify: boolean,
  quiet: boolean,
): boolean {
  if (!mustVerify && !(quiet && LAND_UNSAFE[to] === STAMP)) return true;
  return pieceSafe(from, to, piece, kSq, them);
}

/**
 * 生成行棋方全部合法步（与引擎 allLegalMoves 严格一致）写入 MOVE_BUF[SP]，返回数量。
 * capturesOnly = true 时仅生成吃子；被将军时始终生成全部应将着法（静态搜索内判将死所必需）。
 * 合法性判定：先从将位做一次威胁扫描——
 * - 将/帅着法：一律拔王试格（含飞将规则）；
 * - 被将军：所有着法逐一拔子试格验证；
 * - 未被将军：两类风险着法需要逐着验证——"腾开会新开将军"的源格（车牵/飞将牵制、
 *   炮恰两屏的两屏子、敌马马腿上的子），以及"落子会成为炮架"的落点（敌炮是射线
 *   首子时与王之间的空隙格，LAND_UNSAFE）；其余着法可证明合法（落子只会遮挡
 *   攻击线，吃子不改变任何遮挡，腾非风险格不会新开车/炮/马/卒/飞将的将军）。
 */
function genMoves(capturesOnly: boolean): number {
  const b = S_BOARD;
  const us = S_STM;
  const them = us ^ 1;
  const kSq = S_KING[us];
  const out = MOVE_BUF[SP];
  let n = 0;

  STAMP = (STAMP + 1) & 0xffff;
  if (STAMP === 0) {
    UNSAFE.fill(0);
    LAND_UNSAFE.fill(0);
    STAMP = 1;
  }
  let checkers = 0;

  // 马将军 / 马腿腾格风险
  const eN = them === 0 ? R_N : B_N;
  const kAtk = KN_ATK[kSq];
  for (let i = 0; i < kAtk.length; i += 2) {
    if (b[kAtk[i]] === eN) {
      if (b[kAtk[i + 1]] === 0) checkers++;
      else UNSAFE[kAtk[i + 1]] = STAMP;
    }
  }
  // 兵/卒将军（正面 + 过河横吃；宫内行号使横吃条件恒成立）
  const eP = them === 0 ? R_P : B_P;
  if (b[them === 0 ? kSq + 9 : kSq - 9] === eP) checkers++;
  const kc = colOf(kSq);
  if (kc > 0 && b[kSq - 1] === eP) checkers++;
  if (kc < COLS - 1 && b[kSq + 1] === eP) checkers++;

  // 四向射线：车/飞将将军、车牵/飞将牵制标记、炮恰两屏的风险格标记
  const eR = them === 0 ? R_R : B_R;
  const eK = them === 0 ? R_K : B_K;
  const eC = them === 0 ? R_C : B_C;
  for (let d = 0; d < 4; d++) {
    const ray = RAYS[kSq * 4 + d];
    let q0 = -1;
    let q1 = -1;
    let q2 = -1; // 前三个有子点
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < ray.length; i++) {
      const sq = ray[i];
      const p = b[sq];
      if (p === 0) continue;
      if (q0 < 0) {
        q0 = sq;
        p0 = p;
      } else if (q1 < 0) {
        q1 = sq;
        p1 = p;
      } else {
        q2 = sq;
        p2 = p;
        break;
      }
    }
    if (q0 < 0) continue;
    const vert = d === 0 || d === 2;
    if (p0 === eR || (p0 === eK && vert)) {
      checkers++; // 首子的敌车 / 飞将直接将军
    } else if (q1 >= 0 && (p1 === eR || (p1 === eK && vert))) {
      UNSAFE[q0] = STAMP; // 己方首子被敌车/飞将牵制
    }
    if (q1 >= 0 && p1 === eC) {
      checkers++; // 恰一屏（q0）的敌炮将军
    } else if (q2 >= 0 && p2 === eC) {
      UNSAFE[q0] = STAMP; // 恰两屏：腾开任一屏都会新开炮将军
      UNSAFE[q1] = STAMP;
    }
    if (p0 === eC) {
      // 敌炮为首子（与王之间零屏）：我方任何子落入首子前的空格都会成为炮架，
      // 凭空新开炮将军——这是"落子"而非"腾子"造成的风险，源格印章覆盖不到，
      // 必须按落点标记（射线首子之前全为空格，由 q0 的定义保证）。
      for (let i = 0; i < ray.length && ray[i] !== q0; i++) LAND_UNSAFE[ray[i]] = STAMP;
    }
  }
  GEN_IN_CHECK = checkers > 0;

  // ---- 帅/将着法（拔王试格，处理飞将规则）----
  const kp = us === 0 ? R_K : B_K;
  const kg = KG_TO[us][kSq];
  for (let i = 0; i < kg.length; i++) {
    const to = kg[i];
    const cap = b[to];
    if (cap !== 0 && (sideOfPiece(cap) === us || cap === eK)) continue; // 己方子 / 敌将不可吃
    b[kSq] = 0;
    b[to] = kp;
    const ok = !isAttackedFast(b, to, them);
    b[to] = cap;
    b[kSq] = kp;
    if (ok && (!capturesOnly || cap !== 0)) out[n++] = enc(kSq, to);
  }

  // ---- 其余棋子 ----
  const inChk = GEN_IN_CHECK;
  const half = HALF_OK[us];
  for (let from = 0; from < CELLS; from++) {
    const piece = b[from];
    if (piece === 0 || sideOfPiece(piece) !== us) continue;
    const t = TYPE[piece];
    if (t === 0) continue; // 王已处理
    const mustVerify = inChk || UNSAFE[from] === STAMP;
    // 落点可踏条件：空 / 敌方非将子（与引擎一致：将不可被任何子吃）
    const capOk = (cap: number): boolean => cap === 0 || (sideOfPiece(cap) !== us && cap !== eK);

    switch (t) {
      case 1: {
        // 仕/士：宫内斜一格
        const tbl = ADV_TO[us][from];
        for (let i = 0; i < tbl.length; i++) {
          const to = tbl[i];
          const cap = b[to];
          if (!capOk(cap)) continue;
          if (capturesOnly && cap === 0) continue;
          if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
        }
        break;
      }
      case 2: {
        // 相/象：田字，塞象眼，不过河
        const tbl = ELE_TO[from];
        const eyes = ELE_EYE[from];
        for (let i = 0; i < tbl.length; i++) {
          const to = tbl[i];
          if (b[eyes[i]] !== 0) continue; // 象眼被塞
          if (!half[to]) continue; // 不可过河
          const cap = b[to];
          if (!capOk(cap)) continue;
          if (capturesOnly && cap === 0) continue;
          if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
        }
        break;
      }
      case 3: {
        // 马：日字，蹩马腿
        const tbl = KN_TO[from];
        const legs = KN_LEG[from];
        for (let i = 0; i < tbl.length; i++) {
          const to = tbl[i];
          if (b[legs[i]] !== 0) continue; // 马腿被蹩
          const cap = b[to];
          if (!capOk(cap)) continue;
          if (capturesOnly && cap === 0) continue;
          if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
        }
        break;
      }
      case 4: {
        // 车：直线任意距离，不可越子
        for (let d = 0; d < 4; d++) {
          const ray = RAYS[from * 4 + d];
          for (let i = 0; i < ray.length; i++) {
            const to = ray[i];
            const cap = b[to];
            if (cap === 0) {
              if (!capturesOnly && moveLegal(from, to, piece, kSq, them, mustVerify, true)) {
                out[n++] = enc(from, to);
              }
              continue;
            }
            if (sideOfPiece(cap) !== us && cap !== eK) {
              if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
            }
            break;
          }
        }
        break;
      }
      case 5: {
        // 炮：平移同车；吃子必须隔恰好一个炮架
        for (let d = 0; d < 4; d++) {
          const ray = RAYS[from * 4 + d];
          let hasScreen = false;
          for (let i = 0; i < ray.length; i++) {
            const to = ray[i];
            const cap = b[to];
            if (!hasScreen) {
              if (cap === 0) {
                if (!capturesOnly && moveLegal(from, to, piece, kSq, them, mustVerify, true)) {
                  out[n++] = enc(from, to);
                }
              } else {
                hasScreen = true; // 遇到的第一个子成为炮架
              }
          } else if (cap !== 0) {
            if (sideOfPiece(cap) !== us && cap !== eK) {
              if (moveLegal(from, to, piece, kSq, them, mustVerify, false)) {
                out[n++] = enc(from, to);
              }
            }
            break;
          }
          }
        }
        break;
      }
      default: {
        // 兵/卒：过河前每步只能前进；过河后可前进或左右横移；永不后退
        const fr = rowOf(from);
        const fc = colOf(from);
        const fwd = us === 0 ? -COLS : COLS;
        if (us === 0 ? fr > 0 : fr < 9) {
          const to = from + fwd;
          const cap = b[to];
          if (capOk(cap) && (!capturesOnly || cap !== 0)) {
            if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
          }
        }
        if (us === 0 ? fr <= 4 : fr >= 5) {
          if (fc > 0) {
            const to = from - 1;
            const cap = b[to];
            if (capOk(cap) && (!capturesOnly || cap !== 0)) {
              if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
            }
          }
          if (fc < COLS - 1) {
            const to = from + 1;
            const cap = b[to];
            if (capOk(cap) && (!capturesOnly || cap !== 0)) {
              if (moveLegal(from, to, piece, kSq, them, mustVerify, cap === 0)) out[n++] = enc(from, to);
            }
          }
        }
        break;
      }
    }
  }
  return n;
}

const sideOfPiece = (piece: number): number => (piece < 8 ? 0 : 1);

// ---------------------------------------------------------------- 评估

/** 士象成对计数的临时数组（评估内复用） */
const PAIR_CNT = new Int8Array(4); // [红仕, 红相, 黑士, 黑象]

/**
 * 叶子评估（行棋方视角）：子料 + 位置分（黑子取镜像）+ 士象成对完整加分。
 * 将/帅只计位置分（不可被吃，胜负由搜索的将杀/困毙判定）。
 */
function evaluate(): number {
  const b = S_BOARD;
  let score = 0;
  PAIR_CNT[0] = 0;
  PAIR_CNT[1] = 0;
  PAIR_CNT[2] = 0;
  PAIR_CNT[3] = 0;
  for (let i = 0; i < CELLS; i++) {
    const p = b[i];
    if (p === 0) continue;
    const t = TYPE[p];
    if (p < 8) {
      score += VAL_PST[t][i];
      if (t === 1) PAIR_CNT[0]++;
      else if (t === 2) PAIR_CNT[1]++;
    } else {
      score -= VAL_PST[t][MIRROR[i]];
      if (t === 1) PAIR_CNT[2]++;
      else if (t === 2) PAIR_CNT[3]++;
    }
  }
  if (PAIR_CNT[0] === 2) score += PAIR_BONUS;
  if (PAIR_CNT[1] === 2) score += PAIR_BONUS;
  if (PAIR_CNT[2] === 2) score -= PAIR_BONUS;
  if (PAIR_CNT[3] === 2) score -= PAIR_BONUS;
  return S_STM === 0 ? score : -score;
}

// ---------------------------------------------------------------- 走法排序

/** 按评分对 MOVE_BUF[ply] 前缀做 selection 排序的"选最大换前"步（稳定：同分保持生成序） */
function pickMax(ply: number, i: number, n: number): void {
  const buf = MOVE_BUF[ply];
  const sc = SCORE_BUF[ply];
  let bi = i;
  for (let j = i + 1; j < n; j++) {
    if (sc[j] > sc[bi]) bi = j;
  }
  if (bi !== i) {
    const tm = buf[i];
    buf[i] = buf[bi];
    buf[bi] = tm;
    const ts = sc[i];
    sc[i] = sc[bi];
    sc[bi] = ts;
  }
}

function scoreMoves(ply: number, n: number): void {
  const buf = MOVE_BUF[ply];
  const sc = SCORE_BUF[ply];
  for (let i = 0; i < n; i++) {
    const m = buf[i];
    const victim = S_BOARD[decTo(m)];
    let s: number;
    if (victim !== 0) {
      // MVV-LVA：先吃贵子、用贱子吃（含隔一炮架的炮吃，与普通吃子同序）
      s = 1_000_000 + VAL[TYPE[victim]] * 16 - LVA[TYPE[S_BOARD[decFrom(m)]]];
    } else if (USE_HEUR && m === KILLER[ply << 1]) {
      s = KILLER1_SCORE;
    } else if (USE_HEUR && m === KILLER[(ply << 1) + 1]) {
      s = KILLER2_SCORE;
    } else if (USE_HEUR) {
      s = HIST[(S_STM << 14) | m];
      if (s > HISTORY_CAP) s = HISTORY_CAP;
    } else {
      s = 0;
    }
    sc[i] = s;
  }
}

// ---------------------------------------------------------------- 搜索

/** 负极大值 + α-β；叶子进入静态搜索。返回 0 的"中止值"由上层经 CTX.aborted 丢弃 */
function negamax(depth: number, alpha: number, beta: number, ply: number): number {
  if (CTX.nodes >= CTX.nodeBudget || ((CTX.nodes & 1023) === 0 && Date.now() > CTX.deadline)) {
    CTX.aborted = true;
    return 0;
  }
  CTX.nodes++;
  if (depth <= 0) return qsearch(alpha, beta, ply);

  const n = genMoves(false);
  if (n === 0) return -(MATE_SCORE - ply); // 将死 / 困毙：中国象棋无子可动即判负
  scoreMoves(ply, n);
  let best = -INF;
  for (let i = 0; i < n; i++) {
    pickMax(ply, i, n);
    const m = MOVE_BUF[ply][i];
    make(m);
    const v = -negamax(depth - 1, -beta, -alpha, ply + 1);
    unmake();
    if (CTX.aborted) return 0;
    if (v > best) {
      best = v;
      if (v > alpha) {
        alpha = v;
        if (alpha >= beta) {
          if (USE_HEUR && S_BOARD[decTo(m)] === 0) {
            // 杀手步 / 历史启发（仅安静步；unmake 后 to 处为被吃子或空）
            if (KILLER[ply << 1] !== m) {
              KILLER[(ply << 1) + 1] = KILLER[ply << 1];
              KILLER[ply << 1] = m;
            }
            const h = (S_STM << 14) | m;
            HIST[h] += depth * depth;
          }
          break;
        }
      }
    }
  }
  return best;
}

/** 静态搜索：叶子只延伸吃子（含隔一炮架的炮吃）；被将军时生成全部应将着法（无解即精确将死值） */
function qsearch(alpha: number, beta: number, ply: number): number {
  if (CTX.nodes >= CTX.nodeBudget || ((CTX.nodes & 1023) === 0 && Date.now() > CTX.deadline)) {
    CTX.aborted = true;
    return 0;
  }
  CTX.nodes++;
  if (ply >= MAX_PLY - 1) return evaluate();
  const inChk = isAttackedFast(S_BOARD, S_KING[S_STM], S_STM ^ 1);
  let best: number;
  let n: number;
  if (inChk) {
    n = genMoves(false); // 全部应将着法
    if (n === 0) return -(MATE_SCORE - ply); // 将死 / 困毙
    best = -INF;
  } else {
    n = genMoves(true); // 仅吃子
    const stand = evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    best = stand;
    if (n === 0) return best;
  }
  scoreMoves(ply, n);
  for (let i = 0; i < n; i++) {
    pickMax(ply, i, n);
    const m = MOVE_BUF[ply][i];
    make(m);
    const v = -qsearch(-beta, -alpha, ply + 1);
    unmake();
    if (CTX.aborted) return 0;
    if (v > best) {
      best = v;
      if (v > alpha) {
        alpha = v;
        if (alpha >= beta) break;
      }
    }
  }
  return best;
}

/**
 * 根节点逐子全窗搜索。中止时返回已完成部分的当前最优（completed = false）。
 * 完成后按根分值稳定降序重排 rootMoves，供迭代加深下一层优先搜索（确定性）。
 */
function searchRoot(depth: number, rootMoves: number[]): { move: number; score: number; completed: boolean } {
  const scores = new Array<number>(rootMoves.length).fill(-INF);
  let alpha = -INF;
  let bestMove = -1;
  let bestScore = -INF;
  for (let i = 0; i < rootMoves.length; i++) {
    const m = rootMoves[i];
    make(m);
    const v = -negamax(depth - 1, -INF, -alpha, 1);
    unmake();
    if (CTX.aborted) return { move: bestMove, score: bestScore, completed: false };
    scores[i] = v;
    if (v > bestScore) {
      bestScore = v;
      bestMove = m;
      if (v > alpha) alpha = v;
    }
  }
  const order = rootMoves.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const copy = rootMoves.slice();
  for (let i = 0; i < rootMoves.length; i++) rootMoves[i] = copy[order[i]];
  return { move: bestMove, score: bestScore, completed: true };
}

// ---------------------------------------------------------------- 局面装载与对外 API

function loadPos(pos: AiPosition): void {
  S_BOARD.set(pos.board);
  S_STM = pos.current - 1;
  S_KING[0] = S_BOARD.indexOf(R_K);
  S_KING[1] = S_BOARD.indexOf(B_K);
  SP = 0;
  // 启发与印章状态清零：每次求解自包含（跨调用残留会破坏确定性）
  KILLER.fill(0);
  HIST.fill(0);
  UNSAFE.fill(0);
  LAND_UNSAFE.fill(0);
  STAMP = 0;
}

/**
 * 三档难度统一入口。确定性：同一局面 + 同一难度 ⇒ 同一步、同一节点数、同一分值
 * （无随机、无跨调用状态；墙钟兜底仅在节点预算远未触发的异常慢环境下生效）。
 */
export function chooseMove(pos: AiPosition, difficulty: Difficulty): AiResult {
  if (pos.status !== 'playing') return { move: null, nodes: 0, depth: 0, score: 0 };
  loadPos(pos);
  const rootN = genMoves(false);
  if (rootN === 0) return { move: null, nodes: 0, depth: 0, score: 0 }; // 无合法步（将死/困毙后不会到达，防御）

  if (difficulty === 'easy') {
    // 深度 1 贪心：仅看己方一步后的静态评估；终局检测使一步将杀/困毙可见
    const rootMoves = Array.from(MOVE_BUF[0].subarray(0, rootN));
    let bestM = rootMoves[0];
    let bestS = -INF;
    for (const m of rootMoves) {
      make(m);
      const replyN = genMoves(false);
      // 对方无合法步 = 对方负（将死/困毙同判）；evaluate() 返回"行棋方（已是对手）视角" ⇒ 取负
      const v = replyN === 0 ? MATE_SCORE - 1 : -evaluate();
      unmake();
      if (v > bestS) {
        bestS = v;
        bestM = m;
      }
    }
    return { move: decode(bestM), nodes: rootMoves.length, depth: 1, score: bestS };
  }

  CTX = { nodes: 0, nodeBudget: NODE_BUDGET, deadline: Date.now() + DEADLINE_MS, aborted: false };
  USE_HEUR = difficulty === 'hard';

  if (difficulty === 'medium') {
    const rootMoves = Array.from(MOVE_BUF[0].subarray(0, rootN));
    const r = searchRoot(MEDIUM_DEPTH, rootMoves);
    const m = r.move >= 0 ? r.move : rootMoves[0];
    return {
      move: decode(m),
      nodes: CTX.nodes,
      depth: r.completed ? MEDIUM_DEPTH : 0,
      score: r.score === -INF ? 0 : r.score,
    };
  }

  // hard：迭代加深至深度 5（预算内）；每层完成即持有当前最优，随时可返回。
  // 完成两层后做根候选剪枝：只保留上一轮分值最高的前 ROOT_CAND 个候选继续加深。
  const rootMoves = Array.from(MOVE_BUF[0].subarray(0, rootN));
  let bestMove = rootMoves[0];
  let bestScore = 0;
  let completed = 0;
  for (let d = 1; d <= HARD_DEPTH; d++) {
    const r = searchRoot(d, rootMoves);
    if (CTX.aborted) break; // 本层未完成：沿用上一层最优
    bestMove = r.move;
    bestScore = r.score;
    completed = d;
    if (bestScore >= MATE_WIN) break; // 已见取胜路径，无需更深
    if (d >= 2 && rootMoves.length > ROOT_CAND) rootMoves.length = ROOT_CAND;
  }
  return { move: decode(bestMove), nodes: CTX.nodes, depth: completed, score: bestScore };
}

function decode(m: number): AiMove {
  return { from: decFrom(m), to: decTo(m) };
}

/** 测试/诊断辅助：当前局面全部合法步（与引擎 allLegalMoves 的 from-to 集合一致） */
export function legalMovesOf(pos: AiPosition): AiMove[] {
  loadPos(pos);
  const n = genMoves(false);
  const out: AiMove[] = [];
  for (let i = 0; i < n; i++) out.push(decode(MOVE_BUF[0][i]));
  return out;
}
