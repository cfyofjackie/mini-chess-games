// 国际象棋游戏页（阶段二）：人类执白 vs AI 执黑，三档难度可选（默认中等）。
// AI 走子走同一个 reducer 的 aiMove 动作（悔棋快照 / 最后一手高亮 / 升变语义全部复用）；
// AI 思考在 Web Worker 中进行，棋盘锁定并显示"AI 思考中"；
// 过期回复（重开 / 悔棋 / 换难度）按请求 id 丢弃；
// A1 落子停顿：Worker 回复到达后延迟 AI_LAG_MS 再应用（"AI 想好了，正要落子"的节奏），
//   重开 / 悔棋 / 换难度会同步取消挂起的延迟与在途请求，过期着法不落地；
// A5 上一手 chip：文案由 ui/moveText.ts 纯函数生成（你/AI 前缀在状态条拼接）。
// 复盘报告 v1（第八节）：对局视图 / 报告视图切换；入口 = 终局弹窗与工具栏"复盘本局"
//   （对局中亦可用，分析截至当前局面）；分析在 Worker 里逐局面跑并回报进度，
//   完成后存 localStorage（chess-review- 前缀，保留最近 10 局），历史列表可重看。
// 教练模式 v1（第十节，默认关）：工具栏 🎓 开关；开启后三机制生效——
//   逐步评注（选子落子前 Worker coachEval 预评估，回复即评语，❌ 转拦截卡），
//   大错拦截卡（重试 = 恢复选子前 / 坚持 = 照走并计数，等待 ≤1.5s 超时放行），
//   提示阶梯（💡 每按一次升一级，最佳着法由 Worker coachHint 提供，一局三次三级 → 教学局）；
//   教练请求 id 丢弃过期回复（同 AI 求解既有模式），教练关闭时零额外请求、零 UI 元素。
import './chess.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board, { sideName } from './Board';
import Report from './Report';
import { buildPositions, listReviews, saveReview, type SavedReview } from './reviewStore';
import { useChess, type PendingEval } from './useChess';
import { lastMoveInfo, moveText } from './moveText';
import { toastText } from './hints';
import type { AiReply, AiRequest } from './chess.ai.worker';
import type { Difficulty } from '../engine/ai';
import { extractMoves, type AnalysisMoveInput, type AnalysisReport } from '../engine/analysis';
import {
  COACH_EVAL_TIMEOUT_MS,
  hintHighlight,
  interceptMessage,
} from '../engine/coach';
import { isCapture, type Grade } from '../engine/judge';
import { algebraic, sideOf, type ChessState, type Promotion } from '../engine/chess';

/** A1：Worker 回复到达后到实际落子之间的固定停顿（毫秒，规格书定值） */
const AI_LAG_MS = 600;

/** 第九节：提示浮条自动消失时长（毫秒，同 reversi / gomoku 模式） */
const TOAST_MS = 2600;

const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

const REASON_TEXT: Record<string, string> = {
  checkmate: '将死',
  stalemate: '逼和：一方无子可动且未被将军',
  insufficient: '子力不足，双方均无法将杀',
};

/** 升变选项（规格顺序：后/车/象/马）。两色均用实心字形，白/黑观感由 .c-pc 上色区分（B1） */
const PROMOTION_CHOICES: ReadonlyArray<{ piece: Promotion; glyph: string; name: string }> = [
  { piece: 'q', glyph: '♛', name: '后' },
  { piece: 'r', glyph: '♜', name: '车' },
  { piece: 'b', glyph: '♝', name: '象' },
  { piece: 'n', glyph: '♞', name: '马' },
];

/** 教练评级 → 图标（规格书第十节：🌟 妙手 / ✅ 好棋 / ⚠️ 失误 / ❌ 大错） */
const COACH_EMOJI: Record<Grade, string> = {
  best: '🌟',
  good: '✅',
  mistake: '⚠️',
  blunder: '❌',
};

export default function Game() {
  const { state, dispatch } = useChess();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const [applying, setApplying] = useState(false); // A1：Worker 已回复，停顿等待落子
  // 复盘报告 v1：对局 / 报告双视图与分析会话状态
  const [view, setView] = useState<'play' | 'review'>('play');
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [positions, setPositions] = useState<ChessState[]>([]); // 报告视图的局面序列（分析时冻结）
  const [saved, setSaved] = useState<SavedReview[]>(() => listReviews());
  const [commentOpen, setCommentOpen] = useState(false); // 教练评语条点击展开详情
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id（AI 求解 / 复盘 / 教练共用）
  const pendingRef = useRef(0); // 当前等待中的 AI 求解请求 id；0 = 无等待
  const applyTimerRef = useRef<number | null>(null); // A1：挂起落子延迟的定时器
  const analysisIdRef = useRef(0); // 在途复盘分析请求 id；0 = 无
  // 教练模式在途请求（第十节）：预评估 id / 迟到评语 id / 挂起载荷；提示请求 id / ply
  const coachEvalIdRef = useRef(0);
  const coachLateIdRef = useRef(0);
  const coachPendingRef = useRef<PendingEval | null>(null);
  const hintIdRef = useRef(0);
  const hintPlyRef = useRef(0);
  // 本次复盘的数据源（初始局面 + 着法），报告完成后随报告一并入库
  const reviewSourceRef = useRef<{ initial: ChessState; moves: AnalysisMoveInput[] } | null>(null);

  // A1：取消挂起的落子延迟（重开 / 悔棋 / 换难度 / 卸载时调用，过期着法不落地）
  const cancelAiApply = useCallback(() => {
    if (applyTimerRef.current !== null) {
      clearTimeout(applyTimerRef.current);
      applyTimerRef.current = null;
    }
    setApplying(false);
  }, []);

  // 教练在途请求全部作废（重开 / 悔棋 / 卸载；迟到回复按 id 丢弃）
  const cancelCoachRequests = useCallback(() => {
    coachEvalIdRef.current = 0;
    coachLateIdRef.current = 0;
    coachPendingRef.current = null;
    hintIdRef.current = 0;
  }, []);

  const { game } = state;
  const over = game.status !== 'playing';
  const humanTurn = game.status === 'playing' && game.current === 1;
  const coachBusy = !!state.pendingEval || !!state.intercept; // 教练评估/拦截期：锁工具栏危险操作
  const result = over
    ? game.status === 'won'
      ? game.winner === 1 ? '你获胜' : 'AI 获胜'
      : '和棋'
    : '';

  // A5：最近一手文案 chip——"你/AI："前缀 + moveText 纯函数生成的着法文案，随新着法替换
  const lastInfo = lastMoveInfo(game);
  const lastChip = lastInfo
    ? `${sideOf(lastInfo.piece) === 1 ? '你' : 'AI'}：${moveText(lastInfo, sideOf(lastInfo.piece))}`
    : '';

  // 教练评语条（机制 1）：最近一手人类着法的评级 + 原因，点击展开评估详情
  const comment = state.coach ? state.comment : null;
  const commentVerdict = comment?.verdict ?? null;

  // 教练拦截卡文案（机制 2）："这步会丢后（白后 d1×e4），建议重试"
  const intercept = state.coach ? state.intercept : null;
  const interceptText = intercept
    ? interceptMessage(
        intercept.verdict.reason,
        moveText(
          {
            from: intercept.from,
            to: intercept.to,
            piece: game.board[intercept.from],
            capture: isCapture(game, intercept.from, intercept.to),
            promotion: intercept.promotion,
          },
          game.current,
        ),
      )
    : '';

  // 提示阶梯高亮（机制 3）：二级起点/被吃目标，三级起点+终点；教练关闭时不传（零 UI 变化）
  const hintHl = state.coach ? hintHighlight(game, state.hint) : null;

  // Worker 生命周期（与 reversi / gomoku / peg-solitaire solver 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./chess.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const msg = e.data;
      if (msg.type === 'result') {
        if (pendingRef.current !== msg.id) return; // 过期回复（已重开 / 已悔棋 / 已换难度）直接丢弃
        pendingRef.current = 0;
        setThinking(false);
        if (msg.from < 0) return; // 无合法步（防御；对局中不会发生）
        // A1 停顿：不立即落子，固定延迟后再应用，玩家可感知"AI 想好了，正要落子"
        setApplying(true);
        applyTimerRef.current = window.setTimeout(() => {
          applyTimerRef.current = null;
          setApplying(false);
          // AI 与人类共用同一 makeMove 通路：最后一手高亮、悔棋快照、终局判定天然复用
          dispatch({ type: 'aiMove', from: msg.from, to: msg.to, promotion: msg.promotion });
        }, AI_LAG_MS);
        return;
      }
      if (msg.type === 'coachVerdict') {
        if (coachEvalIdRef.current !== msg.id) return; // 过期预评估（已重开 / 已悔棋 / 已被新请求替代）
        if (coachLateIdRef.current === msg.id) {
          // 超时放行后的迟到回复 → 补写评语（reducer 校验局面仍停在该手）
          const pe = coachPendingRef.current;
          coachEvalIdRef.current = 0;
          coachLateIdRef.current = 0;
          coachPendingRef.current = null;
          if (pe) {
            dispatch({
              type: 'coachComment',
              ply: pe.ply,
              from: pe.from,
              to: pe.to,
              promotion: pe.promotion,
              verdict: msg.verdict,
            });
          }
          return;
        }
        coachEvalIdRef.current = 0;
        coachPendingRef.current = null;
        dispatch({ type: 'coachVerdict', id: msg.id, verdict: msg.verdict }); // ❌ → 拦截卡；其余 → 落子+评语
        return;
      }
      if (msg.type === 'coachHint') {
        if (hintIdRef.current !== msg.id) return; // 过期提示（已换手 / 已重置 / 已被新请求替代）
        hintIdRef.current = 0;
        dispatch({ type: 'hintBest', ply: hintPlyRef.current, best: msg.best, score: msg.score });
        return;
      }
      if (msg.type === 'progress') {
        if (analysisIdRef.current !== msg.id) return; // 过期分析（已重发 / 已退出重看）直接丢弃
        setProgress({ done: msg.done, total: msg.total });
        return;
      }
      // msg.type === 'report'：复盘完成 → 展示 + 本地保存（chess-review- 前缀，保留最近 10 局）
      if (analysisIdRef.current !== msg.id) return;
      analysisIdRef.current = 0;
      setProgress(null);
      setReport(msg.report);
      const src = reviewSourceRef.current;
      if (src) {
        saveReview({
          report: msg.report,
          initial: {
            board: Array.from(src.initial.board),
            current: src.initial.current,
            castling: src.initial.castling,
            enPassant: src.initial.enPassant,
          },
          moves: src.moves,
        });
        setSaved(listReviews());
      }
    };
    workerRef.current = w;
    return () => {
      cancelAiApply(); // 卸载时作废挂起延迟
      cancelCoachRequests();
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch, cancelAiApply, cancelCoachRequests]);

  // AI 回合调度：轮到黑方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素（board 引用随每次走子更新）；
  // 换难度会以新 id 重新请求，旧回复按 id 丢弃。
  useEffect(() => {
    if (game.status !== 'playing' || game.current !== 2) return;
    cancelAiApply(); // 新请求前作废挂起延迟（换难度重发场景）
    const id = ++seqRef.current;
    pendingRef.current = id;
    setThinking(true);
    workerRef.current?.postMessage({
      type: 'choose',
      id,
      difficulty,
      board: Array.from(game.board),
      current: game.current,
      castling: game.castling,
      enPassant: game.enPassant,
    } satisfies AiRequest);
    // 依赖变化（重开 / 悔棋 / 换难度）即作废挂起延迟，过期着法不落地
    return cancelAiApply;
  }, [game.status, game.current, game.board, game.castling, game.enPassant, difficulty, cancelAiApply]);

  // 教练预评估（机制 2）：挂起待评着法出现 → Worker coachEval；1.5s 超时放行（不卡玩家）
  // 依赖用原始值而非 pendingEval 对象：coachEvalSent 盖章会生成新对象，
  // 若以对象为依赖，盖章 → 依赖变化 → effect 重跑 → 再盖章，形成请求死循环。
  const peFrom = state.pendingEval?.from ?? -1;
  const peTo = state.pendingEval?.to ?? -1;
  const pePromo = state.pendingEval?.promotion ?? '';
  useEffect(() => {
    const pe = state.pendingEval;
    const w = workerRef.current;
    if (!state.coach || !pe || !w) return;
    const id = ++seqRef.current;
    coachEvalIdRef.current = id;
    coachLateIdRef.current = 0;
    coachPendingRef.current = pe;
    w.postMessage({
      type: 'coachEval',
      id,
      board: Array.from(game.board),
      current: game.current,
      castling: game.castling,
      enPassant: game.enPassant,
      from: pe.from,
      to: pe.to,
      promotion: pe.promotion,
    } satisfies AiRequest);
    dispatch({ type: 'coachEvalSent', id });
    const timer = window.setTimeout(() => {
      coachLateIdRef.current = id; // 超时放行；迟到回复转评语
      dispatch({ type: 'coachTimeout' });
    }, COACH_EVAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [peFrom, peTo, pePromo, state.coach, game.board, game.current, game.castling, game.enPassant, dispatch]);

  // 提示阶梯（机制 3）：同局面缓存未命中时请求 Worker coachHint 求最佳着法
  useEffect(() => {
    const h = state.hint;
    const w = workerRef.current;
    if (!state.coach || !h || h.best || h.asked || !w) return;
    if (h.ply !== game.history.length) return;
    const id = ++seqRef.current;
    hintIdRef.current = id;
    hintPlyRef.current = h.ply;
    w.postMessage({
      type: 'coachHint',
      id,
      board: Array.from(game.board),
      current: game.current,
      castling: game.castling,
      enPassant: game.enPassant,
    } satisfies AiRequest);
  }, [state.hint, state.coach, game.history.length, game.board, game.current, game.castling, game.enPassant, dispatch]);

  const handleUndo = useCallback(() => {
    if (thinking || coachBusy || game.history.length === 0) return;
    pendingRef.current = 0; // 作废在途请求（防御：思考中按钮已禁用）
    cancelAiApply(); // A1：悔棋取消挂起延迟，过期着法不落地
    cancelCoachRequests(); // 教练在途预评估/提示作废，迟到回复按 id 丢弃
    dispatch({ type: 'undoToHuman' }); // 连 AI 的手一起回退，回到人类回合
  }, [thinking, coachBusy, game.history.length, cancelAiApply, cancelCoachRequests, dispatch]);

  const handleReset = useCallback(() => {
    if (coachBusy) return;
    pendingRef.current = 0; // 作废在途请求
    cancelAiApply(); // A1：重开取消挂起延迟
    cancelCoachRequests();
    setThinking(false);
    dispatch({ type: 'reset' });
  }, [coachBusy, cancelAiApply, cancelCoachRequests, dispatch]);

  const handleTap = useCallback(
    (idx: number) => {
      if (humanTurn) dispatch({ type: "tap", idx }); // AI 思考中锁盘：非人类回合不响应点击
    },
    [humanTurn, dispatch],
  );

  // 第九节提示浮条：2.6s 后自动消失（每次新提示重置计时；纯 UI 状态，不触引擎）
  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: 'clearToast' }), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [state.toast, dispatch]);

  // 复盘本局（对局中亦可用，分析截至当前局面）：history[0] 即初始局面，history[i]
  // 即第 i 手走完的快照——局面序列直接冻结为 [...history, game]，随后在 Worker 里
  // 逐局面分析（进度回报 x/N），完成后展示报告并存入 localStorage。
  const startReview = useCallback(() => {
    const w = workerRef.current;
    if (!w || coachBusy || game.history.length === 0) return;
    const initial = game.history[0];
    const moves = extractMoves(game);
    reviewSourceRef.current = { initial, moves };
    setPositions([...game.history, game]);
    setReport(null);
    setProgress({ done: 0, total: moves.length + 1 });
    setView('review');
    const id = ++seqRef.current;
    analysisIdRef.current = id;
    w.postMessage({
      type: 'analyze',
      id,
      initial: {
        board: Array.from(initial.board),
        current: initial.current,
        castling: initial.castling,
        enPassant: initial.enPassant,
      },
      moves,
    } satisfies AiRequest);
  }, [game, coachBusy]);

  // 重看历史复盘：按保存的初始局面 + 着法重建局面序列（零重新分析）
  const loadSaved = useCallback(
    (id: string) => {
      const rec = saved.find((s) => s.id === id);
      if (!rec) return;
      analysisIdRef.current = 0; // 作废在途分析（若有）
      setReport(rec.report);
      setPositions(buildPositions(rec));
      setProgress(null);
      setView('review');
    },
    [saved],
  );

  if (view === 'review') {
    return (
      <div className="app">
        <nav className="topnav">
          <a href="#/">← 游戏大厅</a>
        </nav>

        <header className="header">
          <h1>国际象棋</h1>
          <p className="subtitle">Chess · 复盘报告 · 本地逐局面分析，找出胜负手</p>
        </header>

        <Report
          report={report}
          progress={progress}
          positions={positions}
          saved={saved}
          onBack={() => setView('play')}
          onLoadSaved={loadSaved}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>国际象棋</h1>
        <p className="subtitle">Chess · 你执白先行，AI 执黑，将死对方王者获胜</p>
      </header>

      <div className="status">
        <span className="chip">
          第 <b>{game.history.length}</b> 手
        </span>
        {lastChip && <span className="chip c-lastmove">{lastChip}</span>}
        {state.coach && state.teaching && <span className="chip c-teaching">🎓 教学局</span>}
        {state.coach && state.insisted > 0 && (
          <span className="chip">坚持大错 ×{state.insisted}</span>
        )}
        {over ? (
          <span className="chip">{result}</span>
        ) : (
          <>
            <span className="chip">
              轮到{' '}
              <span className={`c-pc mini ${game.current === 1 ? 'white' : 'black'}`}>♚</span>{' '}
              <b>{game.current === 1 ? '你' : 'AI'}</b>
            </span>
            {game.check && <span className="chip c-check">将军！</span>}
            {thinking && <span className="chip thinking">AI 思考中</span>}
            {applying && <span className="chip thinking">AI 落子中</span>}
            {state.pendingEval && <span className="chip thinking">教练评估中</span>}
          </>
        )}
      </div>

      {comment && commentVerdict && (
        <div
          className={`c-coach-bar${commentOpen ? ' open' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={commentOpen}
          onClick={() => setCommentOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setCommentOpen((o) => !o);
          }}
        >
          <span className="c-coach-emoji" aria-hidden="true">
            {COACH_EMOJI[commentVerdict.grade]}
          </span>
          <span className="c-coach-text">{commentVerdict.reason}</span>
          {commentOpen && (
            <span className="c-coach-detail">
              评估 {(commentVerdict.bestScore / 100).toFixed(1)} →{' '}
              {(commentVerdict.playerValue / 100).toFixed(1)}
              {commentVerdict.loss > 0 &&
                `，损失约 ${(commentVerdict.loss / 100).toFixed(1)} 兵`}
              {commentVerdict.best &&
                `，引擎首选 ${algebraic(commentVerdict.best.from)}-${algebraic(commentVerdict.best.to)}`}
            </span>
          )}
        </div>
      )}

      {intercept && (
        <div className="c-coach-card" role="alert">
          <div className="c-coach-card-main">
            <span className="c-coach-card-title">❌ 教练</span>
            <span className="c-coach-card-text">{interceptText}</span>
          </div>
          <div className="c-coach-card-actions">
            <button className="btn" onClick={() => dispatch({ type: 'interceptRetry' })}>
              🔄 重试这步
            </button>
            <button className="btn primary" onClick={() => dispatch({ type: 'interceptInsist' })}>
              ▶️ 坚持走
            </button>
          </div>
        </div>
      )}

      <Board state={game} selected={state.selected} hint={hintHl} onTap={handleTap} />

      <div className="toolbar">
        <div className="c-seg" role="group" aria-label="AI 难度">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn c-seg-btn${difficulty === o.value ? ' active' : ''}`}
              aria-pressed={difficulty === o.value}
              onClick={() => setDifficulty(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button
          className="btn"
          onClick={handleUndo}
          disabled={thinking || coachBusy || game.history.length === 0}
        >
          悔棋
        </button>
        <button
          className="btn"
          onClick={handleReset}
          disabled={coachBusy || game.history.length === 0}
        >
          重新开始
        </button>
        {state.coach && !over && humanTurn && !coachBusy && (
          <button className="btn c-hint-btn" onClick={() => dispatch({ type: 'requestHint' })}>
            💡 提示{state.hint ? ` · ${state.hint.level}/3` : ''}
          </button>
        )}
        <button
          className={`btn c-coach-btn${state.coach ? ' active' : ''}`}
          aria-pressed={state.coach}
          onClick={() => dispatch({ type: 'toggleCoach' })}
        >
          🎓 教练{state.coach ? '开' : '关'}
        </button>
        <button
          className="btn primary"
          onClick={startReview}
          disabled={coachBusy || game.history.length === 0}
        >
          复盘本局
        </button>
      </div>

      <p className="rules">
        你执白先行，AI 执黑，可在工具栏切换 AI 难度（简单＝只看一步的贪心；中等＝三层搜索＋吃子延伸；
        困难＝更深迭代搜索＋启发排序）。点击己方棋子后，合法落点以圆点标出（可吃之子与吃过路兵带红圈），
        点击落点即完成走子；没有落点时会提示原因（被牵制 / 无路可走），点对方的子会提示当前轮次；
        选中王时，走不过去的邻格会标注"己 / 攻 / 守"。兵抵达底线弹出浮层自选升变棋子，取消可改走别的步。
        王车易位需权利未失、路径无子且不被将军；对方兵刚走两格时可用吃过路兵，机会仅一手。
        AI 思考时棋盘暂时锁定，悔棋会连 AI 的应手一起回退。
        打开「🎓 教练」后：每步落子会收到 🌟/✅/⚠️/❌ 评语（点击评语条看损失详情），
        大错着法会被拦截（可选重试或坚持），「💡 提示」每按一次多透露一点（文字 → 高亮棋子 → 显示着法），
        一局用满三次三级提示即标记为教学局。对局中或结束后点「复盘本局」，
        AI 在本地逐局面复评每一手，给出 🟢⚪🟡🔴 评级、原因与评估曲线，最近 10 局可随时重看。
      </p>

      {state.toast && <div className="toast">{toastText(state.toast)}</div>}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.status === 'won' ? (game.winner === 1 ? '🏆' : '🤖') : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {REASON_TEXT[game.reason] ?? ''} · 共 <b>{game.history.length}</b> 手
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={startReview}>
                复盘本局
              </button>
              <button className="btn" onClick={handleUndo}>
                悔棋一步
              </button>
              <button className="btn primary" onClick={handleReset}>
                再来一局
              </button>
            </div>
          </div>
        </div>
      )}

      {!over && state.pending && (
        <div className="overlay">
          <div className="modal c-promo" role="dialog" aria-modal="true" aria-label="选择升变棋子">
            <div className="emoji" aria-hidden="true">
              ♛
            </div>
            <div className="grade">兵升变</div>
            <p className="detail">{sideName(game.current)} 的兵抵达底线，请选择升变棋子</p>
            <div className="c-promo-choices">
              {PROMOTION_CHOICES.map((choice) => (
                <button
                  key={choice.piece}
                  className="btn c-promo-btn"
                  onClick={() => dispatch({ type: 'promote', piece: choice.piece })}
                >
                  <span className={`c-pc ${game.current === 1 ? 'white' : 'black'}`} aria-hidden="true">
                    {choice.glyph}
                  </span>
                  {choice.name}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => dispatch({ type: 'cancelPromotion' })}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
