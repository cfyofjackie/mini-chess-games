// 国际象棋状态机：引擎之上薄封装一层 reducer（与 gomoku / reversi / xiangqi 同构），
// 额外维护"当前选中格"、"待决升变"、"提示浮条"与教练模式 v1（docs/games/chess.md 第十节）
// 的四个 UI 状态：
// - 逐步评注（机制 1）：pendingEval 挂起待评着法，Worker coachEval 回复后落子并写入 comment；
// - 大错拦截（机制 2）：预评估为 ❌ 时转入 intercept 拦截卡，重试 = 恢复选子前状态，
//   坚持 = 落子并计数（insisted）；
// - 提示阶梯（机制 3）：requestHint 每按一次升一级（1 泛泛文字 / 2 高亮起点 / 3 起点+终点），
//   best 由 Worker coachHint 回填；换手 / 新局重置（hint 清空），一局三次三级 → teaching 教学局。
// 提示浮条（规格书第九节）：点己方零合法步子 → 牵制/堵死原因（explainSelection）；
// 点对方棋子 → 轮次提示；终局后点击保持静默。文案由 ui/hints.ts 的 toastText 生成。
// 教练关闭（coach = false，默认）时：tap 直接落子、教练字段保持 null/0，行为与旧版零差异。
import { useReducer } from 'react';
import {
  initialState,
  legalTargets,
  makeMove,
  needsPromotion,
  sideOf,
  undo,
  type ChessState,
  type Promotion,
} from '../engine/chess';
import { hintText, type CoachVerdict, type HintState } from '../engine/coach';
import { explainSelection, type SelectionToast } from './hints';

/** 待评/待落着法：已选定尚未应用，等待 Worker coachEval 回复（等待期棋盘锁定 ≤1.5s） */
export interface PendingEval {
  /** Worker 请求 id（coachEvalSent 盖章；0 = 尚未发出）；回复按 id 匹配，过期丢弃 */
  reqId: number;
  from: number;
  to: number;
  promotion?: Promotion;
  /** 该手落子后的手数（校验回复与局面同步） */
  ply: number;
}

/** 大错拦截卡：预评估为 ❌ 时挂起该步，等待 [重试] / [坚持] */
export interface InterceptedMove {
  from: number;
  to: number;
  promotion?: Promotion;
  verdict: CoachVerdict;
}

/** 最近一手人类着法的教练评语（机制 1） */
export interface CoachComment {
  ply: number;
  from: number;
  to: number;
  promotion?: Promotion;
  verdict: CoachVerdict;
}

export interface ChessUiState {
  game: ChessState;
  /** 当前选中的格 idx，-1 为未选中 */
  selected: number;
  /** 待决升变：兵已点到升变落点，等待玩家选择升变子（后/车/象/马）；null 为无 */
  pending: { from: number; to: number } | null;
  /** 提示浮条内容（零合法步原因 / 轮次），null 为不显示；UI 2.6s 后自动清除 */
  toast: SelectionToast | null;
  /** 教练模式开关（规格书第十节，默认关）。关闭时零行为变化 */
  coach: boolean;
  /** 教练待评估着法（选子后落子前），null 为无；等待期棋盘锁定 */
  pendingEval: PendingEval | null;
  /** 大错拦截卡（❌ 预评估挂起），null 为无 */
  intercept: InterceptedMove | null;
  /** 最近一手人类着法的教练评语，null 为无 */
  comment: CoachComment | null;
  /** 提示阶梯状态，null 为未激活；换手 / 新局重置 */
  hint: HintState | null;
  /** 一局内三级提示累计次数；≥3 → teaching */
  hint3: number;
  /** 教学局标记（一局三次三级提示） */
  teaching: boolean;
  /** 一局内"坚持走"大错的次数 */
  insisted: number;
}

export type ChessAction =
  | { type: 'tap'; idx: number }
  | { type: 'promote'; piece: Promotion }
  | { type: 'cancelPromotion' }
  | { type: 'aiMove'; from: number; to: number; promotion?: Promotion }
  | { type: 'undo' }
  | { type: 'undoToHuman' }
  | { type: 'reset' }
  | { type: 'clearToast' }
  | { type: 'toggleCoach' }
  /** 效果层已向 Worker 发出 coachEval 请求：给挂起着法盖请求 id 章 */
  | { type: 'coachEvalSent'; id: number }
  /** 教练评估回复（机制 1/2）：❌ → 拦截卡挂起；其余 → 落子 + 评语 */
  | { type: 'coachVerdict'; id: number; verdict: CoachVerdict }
  /** 拦截预评估超时放行（≤1.5s，规格书第十节）：照常落子，迟到回复转评语 */
  | { type: 'coachTimeout' }
  /** 超时放行后的迟到评语（机制 1）：局面仍在该手时补写 */
  | { type: 'coachComment'; ply: number; from: number; to: number; promotion?: Promotion; verdict: CoachVerdict }
  | { type: 'interceptRetry' }
  | { type: 'interceptInsist' }
  | { type: 'requestHint' }
  /** 提示阶梯的最佳着法回填（Worker coachHint 回复） */
  | { type: 'hintBest'; ply: number; best: { from: number; to: number; promotion?: Promotion } | null; score: number };

/** 初始 UI 状态（useReducer 与状态机测试共用） */
export function initialChessUiState(): ChessUiState {
  return {
    game: initialState(),
    selected: -1,
    pending: null,
    toast: null,
    coach: false,
    pendingEval: null,
    intercept: null,
    comment: null,
    hint: null,
    hint3: 0,
    teaching: false,
    insisted: 0,
  };
}

/** 落子后的公共收尾：清选择/待决/浮条 + 提示阶梯重置（换手重置，规格书第十节） */
function afterMove(s: ChessUiState, game: ChessState): ChessUiState {
  return { ...s, game, selected: -1, pending: null, toast: null, hint: null };
}

export function chessReducer(s: ChessUiState, action: ChessAction): ChessUiState {
  switch (action.type) {
    case 'tap': {
      const { game } = s;
      // 教练评估等待期 / 拦截卡打开：棋盘锁定（规格书第十节），忽略点击
      if (s.pendingEval || s.intercept) return s;
      // 终局后点击：清空选择与浮条，保持静默（不与终局弹窗叠加噪音）
      if (game.status !== 'playing') return { ...s, selected: -1, pending: null, toast: null };
      // 升变弹窗打开时浮层遮挡棋盘，正常点不到；防御性忽略
      if (s.pending) return s;
      const { idx } = action;
      // 已有选中：点到合法落点——升变步先弹选择浮层，其余走子
      if (s.selected >= 0 && s.selected !== idx && legalTargets(game, s.selected).includes(idx)) {
        if (needsPromotion(game, s.selected, idx)) {
          return { ...s, pending: { from: s.selected, to: idx }, toast: null };
        }
        // 教练开启：先挂起待评（Worker 预评估后再落子），不立即应用
        if (s.coach) {
          return {
            ...s,
            pendingEval: { reqId: 0, from: s.selected, to: idx, ply: game.history.length + 1 },
            selected: -1,
            toast: null,
          };
        }
        return { ...s, game: makeMove(game, s.selected, idx), selected: -1, pending: null, toast: null };
      }
      // 再点同一子取消选择
      if (s.selected === idx) return { ...s, selected: -1, toast: null };
      // 点己方棋子：选中 / 换选；零合法步时按原因提示（仍进入选中态，与现状一致）
      const piece = game.board[idx];
      if (piece !== 0 && sideOf(piece) === game.current) {
        const reason = explainSelection(game, idx);
        return { ...s, selected: idx, toast: reason ? { kind: 'hint', reason } : null };
      }
      // 点对方棋子（非落点）：取消选择并提示当前轮次
      if (piece !== 0) return { ...s, selected: -1, toast: { kind: 'turn', side: game.current } };
      // 点空处：仅取消选择，不提示
      return { ...s, selected: -1, toast: null };
    }
    case 'promote': {
      if (!s.pending) return s;
      const { from, to } = s.pending;
      // 教练开启：挂起待评（含升变子），预评估后再落子
      if (s.coach) {
        return {
          ...s,
          pendingEval: { reqId: 0, from, to, promotion: action.piece, ply: s.game.history.length + 1 },
          pending: null,
          toast: null,
        };
      }
      // makeMove 会对非法升变子同引用拒绝，此处正常传入浮层选择结果
      return afterMove(s, makeMove(s.game, from, to, action.piece));
    }
    case 'aiMove': {
      // AI（黑方）落子：与人类同一 makeMove 通路（升变步由 AI 显式携带升变子）
      if (s.game.status !== 'playing') return s;
      return afterMove(s, makeMove(s.game, action.from, action.to, action.promotion));
    }
    case 'cancelPromotion':
      // 取消：回到选子前状态（清除选中与待决），可改走别的步
      return { ...s, selected: -1, pending: null, toast: null };
    case 'undo':
      return {
        ...s,
        game: undo(s.game),
        selected: -1,
        pending: null,
        toast: null,
        pendingEval: null,
        intercept: null,
        comment: null,
        hint: null,
      };
    case 'undoToHuman': {
      // 人机模式悔棋：快照逐级弹出，连 AI 的手一起回退，直到轮到人类（白方）或无可再退。
      // 否则悔一手落在 AI 回合上，AI 会立刻原样重下，悔棋看起来像没生效。
      let g = undo(s.game);
      while (g.history.length > 0 && g.current !== 1) g = undo(g);
      return {
        ...s,
        game: g,
        selected: -1,
        pending: null,
        toast: null,
        pendingEval: null,
        intercept: null,
        comment: null,
        hint: null,
      };
    }
    case 'reset':
      // 新局：阶梯 / 教学局 / 坚持计数一并重置；教练开关保留（用户偏好）
      return {
        ...initialChessUiState(),
        coach: s.coach,
      };
    case 'clearToast':
      // 仅清浮条，不动选择 / 待决（2.6s 定时到期时调用）
      return { ...s, toast: null };
    case 'toggleCoach': {
      const coach = !s.coach;
      if (coach) return { ...s, coach, hint: null };
      // 关闭时收尾：待评着法视作超时放行（照常落子），拦截卡按重试收起，提示高亮清除
      const applied = s.pendingEval
        ? afterMove(s, makeMove(s.game, s.pendingEval.from, s.pendingEval.to, s.pendingEval.promotion))
        : s;
      return { ...applied, coach: false, pendingEval: null, intercept: null, hint: null };
    }
    case 'coachEvalSent': {
      // 盖章 = 最后发出的请求 id（StrictMode 下效果会连发两次，以最后一次为准；
      // 旧 id 的回复在效果层按 coachEvalIdRef 丢弃，这里只需与最终请求一致）
      if (!s.pendingEval) return s;
      return { ...s, pendingEval: { ...s.pendingEval, reqId: action.id } };
    }
    case 'coachVerdict': {
      const pe = s.pendingEval;
      if (!pe || pe.reqId !== action.id) return s; // 过期回复（已重开/已悔棋/已被新请求替代）
      const { verdict } = action;
      // ❌ 大错：转入拦截卡（机制 2），该步不落子，等待重试 / 坚持
      if (verdict.grade === 'blunder') {
        return {
          ...s,
          pendingEval: null,
          intercept: { from: pe.from, to: pe.to, promotion: pe.promotion, verdict },
        };
      }
      // 🌟/✅/⚠️：照常落子并写评语（机制 1）
      const game = makeMove(s.game, pe.from, pe.to, pe.promotion);
      return {
        ...afterMove(s, game),
        pendingEval: null,
        comment: { ply: pe.ply, from: pe.from, to: pe.to, promotion: pe.promotion, verdict },
      };
    }
    case 'coachTimeout': {
      // 预评估超时：放行照走（不卡玩家）；迟到回复经 coachComment 补评语
      const pe = s.pendingEval;
      if (!pe) return s;
      const game = makeMove(s.game, pe.from, pe.to, pe.promotion);
      return { ...afterMove(s, game), pendingEval: null };
    }
    case 'coachComment': {
      // 迟到评语：局面仍停在该手（未悔棋 / 未续走）才写入
      const { game } = s;
      if (game.history.length !== action.ply) return s;
      if (game.lastFrom !== action.from || game.lastTo !== action.to) return s;
      return {
        ...s,
        comment: {
          ply: action.ply,
          from: action.from,
          to: action.to,
          promotion: action.promotion,
          verdict: action.verdict,
        },
      };
    }
    case 'interceptRetry':
      // 重试：恢复选子前状态（该步悔回，棋盘未动过，仅清选择与卡片）
      if (!s.intercept) return s;
      return { ...s, intercept: null, selected: -1, pendingEval: null };
    case 'interceptInsist': {
      // 坚持：照走并计数；❌ 评语照常写入（机制 1）
      const it = s.intercept;
      if (!it) return s;
      const game = makeMove(s.game, it.from, it.to, it.promotion);
      return {
        ...afterMove(s, game),
        intercept: null,
        comment: {
          ply: s.game.history.length + 1,
          from: it.from,
          to: it.to,
          promotion: it.promotion,
          verdict: it.verdict,
        },
        insisted: s.insisted + 1,
      };
    }
    case 'requestHint': {
      // 提示阶梯（机制 3）：教练开启 + 人类回合 + 对局进行中才可用；每按一次升一级（封顶 3）
      const { game } = s;
      if (!s.coach || s.pendingEval || s.intercept) return s;
      if (game.status !== 'playing' || game.current !== 1) return s;
      const samePly = s.hint && s.hint.ply === game.history.length ? s.hint : null;
      const level = (samePly ? Math.min(samePly.level + 1, 3) : 1) as 1 | 2 | 3;
      const hint3 = level === 3 ? s.hint3 + 1 : s.hint3;
      return {
        ...s,
        hint: {
          level,
          ply: game.history.length,
          best: samePly?.best ?? null,
          score: samePly?.score ?? 0,
          text: samePly?.text ?? '',
          asked: samePly ? samePly.best === null : false, // 同局面已请求在途：不重复发
        },
        hint3,
        teaching: s.teaching || hint3 >= 3, // 一局三次三级提示 → 教学局
      };
    }
    case 'hintBest': {
      const h = s.hint;
      if (!h || h.ply !== action.ply) return s; // 过期回复（已换手 / 已重置）
      return {
        ...s,
        hint: { ...h, best: action.best, score: action.score, text: hintText(s.game, action.best, action.score), asked: true },
      };
    }
  }
}

export function useChess() {
  const [state, dispatch] = useReducer(chessReducer, undefined, initialChessUiState);
  return { state, dispatch } as const;
}
