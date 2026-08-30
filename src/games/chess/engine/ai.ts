// 国际象棋 AI：纯函数搜索，完全确定（无随机、无 DOM 依赖），规格见 docs/games/chess.md 第四节。
// 三档难度：
// - easy   深度 1 贪心：仅看己方一步后的子料+PST 静态评估，看不见对方回应（终局检测除外，
//          因此一步将杀/逼和仍可见）；新手可胜。
// - medium α-β（负极大值）深度 3 + MVV-LVA 走法排序 + 静态搜索（叶子只延伸吃子）。
// - hard   迭代加深至深度 5（预算内）+ MVV-LVA + 杀手步/历史启发 + 静态搜索；
//          任意一层完成即持有当前最优步（预算耗尽随时可返回）。
// 评估：子料（兵100/马320/象330/车500/后900/王∞）+ 标准位置分表 PST（黑白镜像）；
//       无后时王格改用残局表（鼓励王活性，利于残局将杀推进）。完全确定、无随机。
// 限策：节点数为主预算（保证确定性可复现），墙钟 2.6s 仅作极端情况兜底；
//       正常由节点预算先触发，同一局面 + 同一难度 ⇒ 同一步与同一节点数。
// 性能优化（规格书许可）：搜索内部使用自有 make/unmake 零分配走子、牵制/将军感知的
//       合法步生成与增量攻击检测；不改动引擎既有公开 API，输出与引擎
//       allLegalMoves / makeMove 严格一致（ai.test.ts 有 parity 断言验证）。
// 不做：置换表/Zobrist、重复局面与 50 回合判定（规格书明确的后续优化项）。
// Worker chess.ai.worker.ts 只做消息薄封装，全部搜索逻辑都在本文件。
import {
  B_BISHOP,
  B_KING,
  B_KNIGHT,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  W_BISHOP,
  W_KING,
  W_KNIGHT,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  type Player,
  type Promotion,
  type Status,
} from './chess';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 求解入参：ChessState 结构兼容（board/current/castling/enPassant/status），Worker 侧可按同构对象重建 */
export interface AiPosition {
  board: Int8Array;
  current: Player;
  /** 易位权利 'KQkq' 子集（与引擎一致） */
  castling: string;
  /** 吃过路兵目标格 idx，无则 -1 */
  enPassant: number;
  status: Status;
}

export interface AiMove {
  from: number;
  to: number;
  /** 升变步必须携带（'q'/'r'/'b'/'n'），与引擎 makeMove 显式传参语义一致 */
  promotion?: Promotion;
}

export interface AiResult {
  /** 最优步；已终局或当前方无合法步时为 null */
  move: AiMove | null;
  /** 本次求解展开的搜索节点数（诊断用；确定性的一部分） */
  nodes: number;
  /** 完成的搜索深度（easy=1；迭代加深被预算中止时为最后完成的层，诊断用） */
  depth: number;
  /** 根节点分值（行棋方视角，厘兵；将杀 = MATE_SCORE − 剩余步数，诊断用） */
  score: number;
}

/** 将杀分值基准：减去剩余步数，保证 AI 偏好更快将杀 */
export const MATE_SCORE = 1_000_000;
/** ≥ 此值即已在搜索内找到将杀路径（100 步以内），迭代加深可提前停止 */
const MATE_WIN = MATE_SCORE - 256;

const MEDIUM_DEPTH = 3;
const HARD_DEPTH = 5;
/** 单步求解节点预算（确定性主限策；实测约 0.8M 节点/秒，600k ≈ 0.8s，墙钟余量充足） */
export const NODE_BUDGET = 600_000;
/** 墙钟兜底（毫秒）：规格单步 ≤3s，预留传输与余量 */
const DEADLINE_MS = 2600;
/** 搜索总层数上限（主搜索 ≤5 层 + 静态搜索延伸；够用且封顶） */
const MAX_PLY = 64;
const INF = 0x3fffffff;

// ---------------------------------------------------------------- 棋子与评估

/** 棋子种类表（下标 = 引擎棋子编码）：0 兵 1 马 2 象 3 车 4 后 5 王 */
const TYPE = new Int8Array(14);
for (let t = 0; t < 6; t++) {
  TYPE[t + 1] = t; // 白 1..6
  TYPE[t + 8] = t; // 黑 8..13
}

/** 子料分（规格书定值），下标 = 种类 */
const MAT = [100, 320, 330, 500, 900, 0];
/** 吃子排序的受害者分值（王不可被吃，防御性给大值） */
const VAL = [100, 320, 330, 500, 900, 20000];

/**
 * 标准位置分表（PST，仿 Michniewski 简化评估；书写顺序 r=0 为第 8 横线，
 * 与引擎棋盘一致）：白子直接取 PST[type][idx]，黑子取垂直镜像位 idx ^ 56。
 * 下标 0-4 为兵马车象后，5 为王（中局表），6 为王（残局表，无后时启用）。
 */
const PST: Int16Array[] = [
  // 兵
  Int16Array.from([
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]),
  // 马
  Int16Array.from([
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ]),
  // 象
  Int16Array.from([
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ]),
  // 车
  Int16Array.from([
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ]),
  // 后
  Int16Array.from([
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ]),
  // 王（中局：王城安全）
  Int16Array.from([
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ]),
  // 王（残局：居中活性）
  Int16Array.from([
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ]),
];

// ---------------------------------------------------------------- 几何表（预计算）

/** 马步落点 / 王步落点（界内，无越界检测成本） */
const N_MOVES: Int8Array[] = [];
const K_MOVES: Int8Array[] = [];
/**
 * 滑子射线：RAYS[sq * 8 + d] 为从 sq 沿方向 d 依次到达的格子（不含 sq，至边界）。
 * 方向编号：0 上 1 右 2 下 3 左（直行），4 左上 5 右上 6 左下 7 右下（斜行）。
 */
const RAYS: Int8Array[] = [];
(() => {
  const DIRS = [
    [-1, 0], [0, 1], [1, 0], [0, -1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ] as const;
  const KNIGHT = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ] as const;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = r * 8 + c;
      const kn: number[] = [];
      for (const [kr, kc] of KNIGHT) {
        const nr = r + kr;
        const nc = c + kc;
        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) kn.push(nr * 8 + nc);
      }
      N_MOVES[sq] = Int8Array.from(kn);
      const kg: number[] = [];
      for (let d = 0; d < 8; d++) {
        const [dr, dc] = DIRS[d];
        const kr = r + dr;
        const kc = c + dc;
        if (kr >= 0 && kr < 8 && kc >= 0 && kc < 8) kg.push(kr * 8 + kc);
        const ray: number[] = [];
        let rr = r + dr;
        let cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          ray.push(rr * 8 + cc);
          rr += dr;
          cc += dc;
        }
        RAYS[sq * 8 + d] = Int8Array.from(ray);
      }
      K_MOVES[sq] = Int8Array.from(kg);
    }
  }
})();

// ---------------------------------------------------------------- 搜索状态（模块级复用，零分配）

const S_BOARD = new Int8Array(64);
let S_STM = 0; // 0 白 1 黑
let S_CAST = 0; // 位 1=K 2=Q 4=k 8=q
let S_EP = -1;
const S_KING = new Int8Array(2); // [白王格, 黑王格]

/** 走到/经过某格时应清除的易位权利位（引擎 ROOK_HOME/王位语义的位掩码版） */
const CASTLE_MASK = new Uint8Array(64).fill(15);
CASTLE_MASK[60] = 15 & ~3; // e1：清 K|Q
CASTLE_MASK[63] = 15 & ~1; // h1：清 K
CASTLE_MASK[56] = 15 & ~2; // a1：清 Q
CASTLE_MASK[4] = 15 & ~12; // e8：清 k|q
CASTLE_MASK[7] = 15 & ~4; // h8：清 k
CASTLE_MASK[0] = 15 & ~8; // a8：清 q

/** 悔棋栈（深度上限 MAX_PLY） */
const U_FROM = new Int8Array(MAX_PLY);
const U_TO = new Int8Array(MAX_PLY);
const U_PIECE = new Int8Array(MAX_PLY);
const U_CAP = new Int8Array(MAX_PLY);
const U_CAPSQ = new Int8Array(MAX_PLY);
const U_PROMO = new Int8Array(MAX_PLY); // 0 无，1 q 2 r 3 b 4 n
const U_EP = new Int16Array(MAX_PLY);
const U_CAST = new Uint8Array(MAX_PLY);
const U_RF = new Int8Array(MAX_PLY); // 易位车起点（-1 非易位）
const U_RT = new Int8Array(MAX_PLY);
let SP = 0; // 栈指针 = 当前 ply

/** 每层走法/评分缓冲（genMoves 写入，selection 排序原地交换） */
const MOVE_BUF: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
const SCORE_BUF: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(256));

/** 走法编码：from | to<<6 | promo<<12（promo 0 无 / 1 q / 2 r / 3 b / 4 n） */
const enc = (from: number, to: number, promo = 0): number => from | (to << 6) | (promo << 12);

function decode(m: number): AiMove {
  const from = m & 63;
  const to = (m >> 6) & 63;
  const promo = m >>> 12;
  if (promo === 1) return { from, to, promotion: 'q' };
  if (promo === 2) return { from, to, promotion: 'r' };
  if (promo === 3) return { from, to, promotion: 'b' };
  if (promo === 4) return { from, to, promotion: 'n' };
  return { from, to };
}

/** 杀手步 / 历史启发（仅 hard 档启用；每次求解前清零保证确定性） */
const KILLER = new Int32Array(MAX_PLY * 2);
const HIST = new Int32Array(2 * 64 * 64); // [行棋方 | from<<6 | to]
const KILLER1_SCORE = 700_000;
const KILLER2_SCORE = 699_000;
const HISTORY_CAP = 690_000;
const PROMO_QUIET_BASE = 800_000;

interface SearchCtx {
  nodes: number;
  nodeBudget: number;
  deadline: number;
  aborted: boolean;
}
let CTX: SearchCtx = { nodes: 0, nodeBudget: 0, deadline: 0, aborted: false };
let USE_HEUR = false;

// ---------------------------------------------------------------- 攻击检测

/** sq 是否被 by 一方攻击（兵/马/王/直行滑子/斜行滑子，覆盖全部攻击方式） */
function isAttacked(b: Int8Array, sq: number, by: number): boolean {
  const r = sq >> 3;
  const c = sq & 7;
  // 兵：白兵位于目标下方（r+1）两斜格，黑兵位于上方（r-1）
  if (by === 0) {
    if (r < 7) {
      if (c > 0 && b[sq + 7] === W_PAWN) return true;
      if (c < 7 && b[sq + 9] === W_PAWN) return true;
    }
  } else {
    if (r > 0) {
      if (c > 0 && b[sq - 9] === B_PAWN) return true;
      if (c < 7 && b[sq - 7] === B_PAWN) return true;
    }
  }
  const kn = by === 0 ? W_KNIGHT : B_KNIGHT;
  const nm = N_MOVES[sq];
  for (let i = 0; i < nm.length; i++) if (b[nm[i]] === kn) return true;
  const kg = by === 0 ? W_KING : B_KING;
  const km = K_MOVES[sq];
  for (let i = 0; i < km.length; i++) if (b[km[i]] === kg) return true;
  const rk = by === 0 ? W_ROOK : B_ROOK;
  const qu = by === 0 ? W_QUEEN : B_QUEEN;
  for (let d = 0; d < 4; d++) {
    const ray = RAYS[sq * 8 + d];
    for (let i = 0; i < ray.length; i++) {
      const p = b[ray[i]];
      if (p !== 0) {
        if (p === rk || p === qu) return true;
        break;
      }
    }
  }
  const bi = by === 0 ? W_BISHOP : B_BISHOP;
  for (let d = 4; d < 8; d++) {
    const ray = RAYS[sq * 8 + d];
    for (let i = 0; i < ray.length; i++) {
      const p = b[ray[i]];
      if (p !== 0) {
        if (p === bi || p === qu) return true;
        break;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- make / unmake

function make(m: number): void {
  const from = m & 63;
  const to = (m >> 6) & 63;
  const promo = m >>> 12;
  const piece = S_BOARD[from];
  let cap = S_BOARD[to];
  let capSq = to;
  // 吃过路兵：被吃兵不在 to，而在己方兵原行、目标列
  if ((piece === W_PAWN || piece === B_PAWN) && cap === 0 && to === S_EP) {
    capSq = to + (piece === W_PAWN ? 8 : -8);
    cap = S_BOARD[capSq];
    S_BOARD[capSq] = 0;
  }
  U_FROM[SP] = from;
  U_TO[SP] = to;
  U_PIECE[SP] = piece;
  U_CAP[SP] = cap;
  U_CAPSQ[SP] = capSq;
  U_PROMO[SP] = promo;
  U_EP[SP] = S_EP;
  U_CAST[SP] = S_CAST;
  // 王车易位：王横移两格，同步移动参与的车
  let rf = -1;
  let rt = -1;
  if ((piece === W_KING || piece === B_KING) && Math.abs((to & 7) - (from & 7)) === 2) {
    if (to === 62) { rf = 63; rt = 61; } // g1：h1→f1
    else if (to === 58) { rf = 56; rt = 59; } // c1：a1→d1
    else if (to === 6) { rf = 7; rt = 5; } // g8：h8→f8
    else { rf = 0; rt = 3; } // c8：a8→d8
    S_BOARD[rt] = S_BOARD[rf];
    S_BOARD[rf] = 0;
  }
  U_RF[SP] = rf;
  U_RT[SP] = rt;
  S_BOARD[from] = 0;
  // 升变编码 1 q / 2 r / 3 b / 4 n → 棋子编码（白 6−promo，黑 13−promo）
  S_BOARD[to] = promo ? (piece < 8 ? 6 - promo : 13 - promo) : piece;
  if (piece === W_KING) S_KING[0] = to;
  else if (piece === B_KING) S_KING[1] = to;
  // 过路兵目标格：仅兵起始两格时设置
  S_EP =
    (piece === W_PAWN && to - from === -16) || (piece === B_PAWN && to - from === 16)
      ? (from + to) >> 1
      : -1;
  S_CAST &= CASTLE_MASK[from] & CASTLE_MASK[to];
  S_STM ^= 1;
  SP++;
}

function unmake(): void {
  SP--;
  const from = U_FROM[SP];
  const to = U_TO[SP];
  const piece = U_PIECE[SP];
  S_STM ^= 1;
  S_CAST = U_CAST[SP];
  S_EP = U_EP[SP];
  const rf = U_RF[SP];
  if (rf >= 0) {
    S_BOARD[rf] = S_BOARD[U_RT[SP]];
    S_BOARD[U_RT[SP]] = 0;
  }
  S_BOARD[to] = 0;
  if (U_CAP[SP]) S_BOARD[U_CAPSQ[SP]] = U_CAP[SP];
  S_BOARD[from] = piece;
  if (piece === W_KING) S_KING[0] = from;
  else if (piece === B_KING) S_KING[1] = from;
}

// ---------------------------------------------------------------- 合法步生成（牵制/将军感知）

/** 本次 genMoves 的"印章"：牵制方向表与应将格表的惰性失效标记 */
const STAMP_ARR = new Uint16Array(64);
const PIN_DIR = new Int8Array(64); // 印章有效时：被牵制方向（0-7）
const MASK_ARR = new Uint16Array(64); // 印章有效时：能解将的格（吃掉将军子或垫将）
let STAMP = 0;
/** genMoves 结果：行棋方是否正被将军（无合法步时区分将死/逼和） */
let GEN_IN_CHECK = false;

/** 被牵制棋子沿牵制方向的合法落点判定：to 必须在王→钉子的线段上（含钉子格，越过即非法） */
function onPinRay(from: number, dir: number, to: number): boolean {
  const ray = RAYS[S_KING[S_STM] * 8 + dir];
  for (let i = 0; i < ray.length; i++) {
    const sq = ray[i];
    if (sq === to) return true;
    const p = S_BOARD[sq];
    if (p !== 0 && sq !== from) return false; // 首个他子即钉子：越过则不再遮挡
  }
  return false;
}

/**
 * 生成行棋方全部合法步（与引擎 allLegalMoves 严格一致）写入 MOVE_BUF[SP]，
 * 返回数量。capturesOnly = true 时仅生成吃子（含吃过路兵与吃子升变）；
 * 被将军时始终生成全部应将着法（静态搜索内区分将死/逼和所必需）。
 * 合法性判定：先计算将军子与被牵制子 ——
 * - 王步：拔王试格（吃子先摘子），处理沿将军线逃离与吃受保将军子；
 * - 双将：仅王步；
 * - 单将：非王着法须落在解将格集（被牵制子与解将线不相交，恒无解，直接排除）；
 *   吃过路兵一律做完整 make/verify（移除第三格兵可能新开横线闪击）；
 * - 无将：未牵制子任意走必合法；牵制子须留在牵制线上；易位按权利/空格/王经过格安全判定。
 */
function genMoves(capturesOnly: boolean): number {
  const b = S_BOARD;
  const us = S_STM;
  const them = us ^ 1;
  const ksq = S_KING[us];
  const out = MOVE_BUF[SP];
  let n = 0;

  // ---- 将军子与牵制子（从王出发 8 向射线一次扫描）----
  STAMP = (STAMP + 1) & 0xffff;
  if (STAMP === 0) {
    STAMP_ARR.fill(0);
    MASK_ARR.fill(0);
    STAMP = 1;
  }
  let checkers = 0;
  let checkFrom = -1;
  let checkDir = -1; // 将军滑子相对王的方向；非滑子将军为 -1
  // 马将军
  const ekn = them === 0 ? W_KNIGHT : B_KNIGHT;
  const knm = N_MOVES[ksq];
  for (let i = 0; i < knm.length; i++) {
    if (b[knm[i]] === ekn) {
      checkers++;
      checkFrom = knm[i];
    }
  }
  // 兵将军
  const epn = them === 0 ? W_PAWN : B_PAWN;
  const kr = ksq >> 3;
  const kc = ksq & 7;
  if (us === 1) {
    if (kr < 7) {
      if (kc > 0 && b[ksq + 7] === epn) { checkers++; checkFrom = ksq + 7; }
      if (kc < 7 && b[ksq + 9] === epn) { checkers++; checkFrom = ksq + 9; }
    }
  } else {
    if (kr > 0) {
      if (kc > 0 && b[ksq - 9] === epn) { checkers++; checkFrom = ksq - 9; }
      if (kc < 7 && b[ksq - 7] === epn) { checkers++; checkFrom = ksq - 7; }
    }
  }
  // 滑子将军 + 牵制
  const usWhite = us === 0;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[ksq * 8 + d];
    let first = -1;
    for (let i = 0; i < ray.length; i++) {
      const sq = ray[i];
      const p = b[sq];
      if (p === 0) continue;
      const t = TYPE[p];
      if (first < 0) {
        if ((p < 8) === usWhite) {
          first = sq; // 首子为己方：牵制候选，继续找钉子
          continue;
        }
        if (d < 4 ? t === 3 || t === 4 : t === 2 || t === 4) {
          checkers++;
          checkFrom = sq;
          checkDir = d;
        }
        break;
      }
      // 己方首子之后的他子：与方向匹配的滑子 ⇒ 首子被牵制
      if ((p < 8) !== usWhite && (d < 4 ? t === 3 || t === 4 : t === 2 || t === 4)) {
        STAMP_ARR[first] = STAMP;
        PIN_DIR[first] = d;
      }
      break;
    }
  }
  GEN_IN_CHECK = checkers > 0;

  // ---- 解将格集（单将时：吃掉将军子或沿将军线垫将）----
  if (checkers === 1) {
    if (checkDir >= 0) {
      const ray = RAYS[ksq * 8 + checkDir];
      for (let i = 0; i < ray.length; i++) {
        MASK_ARR[ray[i]] = STAMP;
        if (ray[i] === checkFrom) break;
      }
    } else {
      MASK_ARR[checkFrom] = STAMP;
    }
  }

  // ---- 王步（拔王 + 摘被吃子后试格，处理沿线逃离与受保将军子）----
  const kp = usWhite ? W_KING : B_KING;
  const kmv = K_MOVES[ksq];
  for (let i = 0; i < kmv.length; i++) {
    const to = kmv[i];
    const tp = b[to];
    if (tp !== 0 && (tp < 8) === usWhite) continue;
    b[ksq] = 0;
    b[to] = 0;
    const ok = !isAttacked(b, to, them);
    b[to] = tp;
    b[ksq] = kp;
    if (ok) out[n++] = enc(ksq, to);
  }
  if (checkers >= 2) return n; // 双将：只有王步

  const skipQuiet = capturesOnly && checkers === 0;

  // ---- 王车易位（不在将军中；权利未失 + 车在原位 + 路径无子 + 经过格不受攻）----
  if (checkers === 0 && !skipQuiet) {
    if (us === 0) {
      if ((S_CAST & 1) && ksq === 60 && b[63] === W_ROOK && b[61] === 0 && b[62] === 0
        && !isAttacked(b, 61, 1) && !isAttacked(b, 62, 1)) {
        out[n++] = enc(60, 62);
      }
      if ((S_CAST & 2) && ksq === 60 && b[56] === W_ROOK && b[59] === 0 && b[58] === 0 && b[57] === 0
        && !isAttacked(b, 59, 1) && !isAttacked(b, 58, 1)) {
        out[n++] = enc(60, 58);
      }
    } else {
      if ((S_CAST & 4) && ksq === 4 && b[7] === B_ROOK && b[5] === 0 && b[6] === 0
        && !isAttacked(b, 5, 0) && !isAttacked(b, 6, 0)) {
        out[n++] = enc(4, 6);
      }
      if ((S_CAST & 8) && ksq === 4 && b[0] === B_ROOK && b[3] === 0 && b[2] === 0 && b[1] === 0
        && !isAttacked(b, 3, 0) && !isAttacked(b, 2, 0)) {
        out[n++] = enc(4, 2);
      }
    }
  }

  // ---- 其余棋子（兵先于其余，走法最繁）----
  const fwd = usWhite ? -8 : 8;
  const startRow = usWhite ? 6 : 1;
  const promoRow = usWhite ? 0 : 7;
  const pawn = usWhite ? W_PAWN : B_PAWN;
  const checkFilter = checkers > 0; // 非王着法须落点在解将格集

  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (p === 0 || (p < 8) !== usWhite) continue;
    const t = TYPE[p];
    if (t === 5) continue; // 王已处理
    const pinned = STAMP_ARR[from] === STAMP ? PIN_DIR[from] : -1;
    const r = from >> 3;
    const c = from & 7;

    if (t === 0) {
      // 兵
      const nr = r + (usWhite ? -1 : 1);
      if (nr >= 0 && nr <= 7) {
        const one = from + fwd;
        // 前进（升变 ×4）
        if (!skipQuiet && b[one] === 0) {
          if (nr === promoRow) {
            out[n++] = enc(from, one, 1);
            out[n++] = enc(from, one, 2);
            out[n++] = enc(from, one, 3);
            out[n++] = enc(from, one, 4);
          } else {
            if (checkFilter ? MASK_ARR[one] === STAMP : true) {
              if (pinned < 0 || onPinRay(from, pinned, one)) out[n++] = enc(from, one);
            }
            const two = one + fwd;
            if (r === startRow && b[two] === 0 && (checkFilter ? MASK_ARR[two] === STAMP : true)) {
              if (pinned < 0 || onPinRay(from, pinned, two)) out[n++] = enc(from, two);
            }
          }
        }
        // 斜吃 / 吃过路兵（升变 ×4）
        for (const dc of [-1, 1] as const) {
          const nc = c + dc;
          if (nc < 0 || nc > 7) continue;
          const to = from + fwd + dc;
          const tp = b[to];
          if (tp !== 0 && (tp < 8) !== usWhite) {
            if (checkFilter ? MASK_ARR[to] === STAMP : true) {
              if (pinned < 0 || onPinRay(from, pinned, to)) {
                if (nr === promoRow) {
                  out[n++] = enc(from, to, 1);
                  out[n++] = enc(from, to, 2);
                  out[n++] = enc(from, to, 3);
                  out[n++] = enc(from, to, 4);
                } else {
                  out[n++] = enc(from, to);
                }
              }
            }
          } else if (tp === 0 && to === S_EP) {
            // 吃过路兵：移除第三格被吃兵可能新开线攻击，一律完整验证
            const capSq = to + (usWhite ? 8 : -8);
            const capP = b[capSq];
            b[from] = 0;
            b[to] = pawn;
            b[capSq] = 0;
            const ok = !isAttacked(b, S_KING[us], them);
            b[from] = p;
            b[to] = 0;
            b[capSq] = capP;
            if (ok) out[n++] = enc(from, to);
          }
        }
      }
      continue;
    }

    if (t === 1) {
      // 马：被牵制即无合法步
      if (pinned >= 0) continue;
      const ms = N_MOVES[from];
      for (let i = 0; i < ms.length; i++) {
        const to = ms[i];
        const tp = b[to];
        if (tp !== 0 && (tp < 8) === usWhite) continue;
        if (tp === 0 && skipQuiet) continue;
        if (checkFilter && MASK_ARR[to] !== STAMP) continue;
        out[n++] = enc(from, to);
      }
      continue;
    }

    // 象 / 车 / 后：射线滑动
    const d0 = t === 2 ? 4 : 0;
    const d1 = t === 3 ? 4 : 8;
    for (let d = d0; d < d1; d++) {
      const ray = RAYS[from * 8 + d];
      for (let i = 0; i < ray.length; i++) {
        const to = ray[i];
        const tp = b[to];
        if (tp === 0) {
          if (!skipQuiet && (checkFilter ? MASK_ARR[to] === STAMP : true)
            && (pinned < 0 || onPinRay(from, pinned, to))) {
            out[n++] = enc(from, to);
          }
          continue;
        }
        if ((tp < 8) !== usWhite && (checkFilter ? MASK_ARR[to] === STAMP : true)
          && (pinned < 0 || onPinRay(from, pinned, to))) {
          out[n++] = enc(from, to);
        }
        break;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- 评估

/**
 * 叶子评估（行棋方视角）：子料 + PST（黑白镜像）；无后时王格用残局表。
 * 内联子力不足判和（与引擎 isInsufficientMaterial 语义一致）：
 * K vs K、K+单轻子 vs K、K+B vs K+B 同色象 ⇒ 0。
 */
function evaluate(): number {
  const b = S_BOARD;
  let score = 0;
  let wMinor = 0;
  let bMinor = 0;
  let wBishopColor = -1;
  let bBishopColor = -1;
  let pawnOrMajor = false;
  let queens = 0;
  let wK = -1;
  let bK = -1;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p === 0) continue;
    const t = TYPE[p];
    if (p < 8) {
      score += MAT[t] + PST[t][i];
      if (t === 0 || t === 3 || t === 4) {
        pawnOrMajor = true;
        if (t === 4) queens++;
      } else if (t === 1) {
        wMinor++;
      } else if (t === 2) {
        wMinor++;
        wBishopColor = (i + (i >> 3)) & 1;
      } else {
        wK = i;
      }
    } else {
      score -= MAT[t] + PST[t][i ^ 56];
      if (t === 0 || t === 3 || t === 4) {
        pawnOrMajor = true;
        if (t === 4) queens++;
      } else if (t === 1) {
        bMinor++;
      } else if (t === 2) {
        bMinor++;
        bBishopColor = (i + (i >> 3)) & 1;
      } else {
        bK = i;
      }
    }
  }
  if (!pawnOrMajor) {
    const total = wMinor + bMinor;
    if (total <= 1) return 0;
    if (total === 2 && wMinor === 1 && bMinor === 1
      && wBishopColor >= 0 && wBishopColor === bBishopColor) {
      return 0;
    }
  }
  const kTable = queens === 0 ? PST[6] : PST[5];
  if (wK >= 0) score += kTable[wK];
  if (bK >= 0) score -= kTable[bK ^ 56];
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
    const from = m & 63;
    const to = (m >> 6) & 63;
    const promo = m >>> 12;
    const victim = S_BOARD[to];
    let s: number;
    if (victim !== 0) {
      // MVV-LVA：先吃贵子、用贱子吃
      s = 1_000_000 + VAL[TYPE[victim]] * 16 - TYPE[S_BOARD[from]];
      if (promo) s += PROMO_QUIET_BASE + VAL[5 - promo];
    } else if (promo) {
      s = PROMO_QUIET_BASE + VAL[5 - promo];
    } else if (to === S_EP && TYPE[S_BOARD[from]] === 0) {
      s = 1_000_000 + VAL[0] * 16; // 吃过路兵视作兵吃兵
    } else if (USE_HEUR && m === KILLER[ply << 1]) {
      s = KILLER1_SCORE;
    } else if (USE_HEUR && m === KILLER[(ply << 1) + 1]) {
      s = KILLER2_SCORE;
    } else if (USE_HEUR) {
      s = HIST[(S_STM << 12) | (from << 6) | to];
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
  if (n === 0) return GEN_IN_CHECK ? -(MATE_SCORE - ply) : 0; // 将死 / 逼和
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
          if (USE_HEUR && (m >>> 12) === 0 && S_BOARD[(m >> 6) & 63] === 0
            && !(TYPE[S_BOARD[m & 63]] === 0 && ((m >> 6) & 63) === S_EP)) {
            // 杀手步 / 历史启发（仅安静步）
            if (KILLER[ply << 1] !== m) {
              KILLER[(ply << 1) + 1] = KILLER[ply << 1];
              KILLER[ply << 1] = m;
            }
            const h = (S_STM << 12) | (((m >> 6) & 63) << 6) | (m & 63);
            HIST[h] += depth * depth;
          }
          break;
        }
      }
    }
  }
  return best;
}

/** 静态搜索：叶子只延伸吃子；被将军时生成全部应将着法（无解即精确将死值） */
function qsearch(alpha: number, beta: number, ply: number): number {
  if (CTX.nodes >= CTX.nodeBudget || ((CTX.nodes & 1023) === 0 && Date.now() > CTX.deadline)) {
    CTX.aborted = true;
    return 0;
  }
  CTX.nodes++;
  if (ply >= MAX_PLY - 1) return evaluate();
  const inChk = isAttacked(S_BOARD, S_KING[S_STM], S_STM ^ 1);
  let best: number;
  let n: number;
  if (inChk) {
    n = genMoves(false); // 全部应将着法
    if (n === 0) return -(MATE_SCORE - ply);
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
  S_CAST = 0;
  if (pos.castling.includes('K')) S_CAST |= 1;
  if (pos.castling.includes('Q')) S_CAST |= 2;
  if (pos.castling.includes('k')) S_CAST |= 4;
  if (pos.castling.includes('q')) S_CAST |= 8;
  S_EP = pos.enPassant;
  S_KING[0] = S_BOARD.indexOf(W_KING);
  S_KING[1] = S_BOARD.indexOf(B_KING);
  SP = 0;
  // 启发状态清零：每次求解自包含（跨调用残留会破坏确定性）
  KILLER.fill(0);
  HIST.fill(0);
}

/**
 * 三档难度统一入口。确定性：同一局面 + 同一难度 ⇒ 同一步、同一节点数、同一分值
 * （无随机、无跨调用状态；墙钟兜底仅在节点预算远未触发的异常慢环境下生效）。
 */
export function chooseMove(pos: AiPosition, difficulty: Difficulty): AiResult {
  if (pos.status !== 'playing') return { move: null, nodes: 0, depth: 0, score: 0 };
  loadPos(pos);
  const rootN = genMoves(false);
  if (rootN === 0) return { move: null, nodes: 0, depth: 0, score: 0 }; // 无合法步（将死/逼和后不会到达，防御）

  if (difficulty === 'easy') {
    // 深度 1 贪心：仅看己方一步后的静态评估；终局检测使一步将杀/逼和可见
    const rootMoves = Array.from(MOVE_BUF[0].subarray(0, rootN));
    let bestM = rootMoves[0];
    let bestS = -INF;
    for (const m of rootMoves) {
      make(m);
      const replyN = genMoves(false);
      // evaluate() 返回"行棋方视角"，此处行棋方已是对手 ⇒ 取负得 AI 自身视角
      const v = replyN === 0 ? (GEN_IN_CHECK ? MATE_SCORE - 1 : 0) : -evaluate();
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

  // hard：迭代加深至深度 5（预算内）；每层完成即持有当前最优，随时可返回
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
    if (bestScore >= MATE_WIN) break; // 已见将杀路径，无需更深
  }
  return { move: decode(bestMove), nodes: CTX.nodes, depth: completed, score: bestScore };
}

/** 测试/诊断辅助：当前局面全部合法步（与引擎 allLegalMoves 的 from-to 集合一致，升变展开为多条） */
export function legalMovesOf(pos: AiPosition): AiMove[] {
  loadPos(pos);
  const n = genMoves(false);
  const out: AiMove[] = [];
  for (let i = 0; i < n; i++) out.push(decode(MOVE_BUF[0][i]));
  return out;
}
