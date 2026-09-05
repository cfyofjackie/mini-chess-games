// 围棋对局页：双人对弈（同屏黑白）或人机对弈（人类执黑，AI 执白，三档难度）。
// 三档难度（docs/games/go.md 第三节A）：简单 = 吃子教学启发式；中等 = MCTS 加权快走；
// 困难 = MCTS + 战术聚焦 + 更大模拟预算。AI 求解在 Web Worker 中进行（go.ai.worker.ts，
// 模式同 chess / gomoku），思考时棋盘锁定并显示"AI 思考中"；过期回复（重开 / 悔棋 /
// 换难度）按请求 id 丢弃。双方连续虚着进入标记模式，整群点选死子后确认数子。
// 悔棋基于引擎快照栈；人机模式一键连退两手（AI 应手 + 己方上一手）回到己方回合。
// 学堂（chess.md 第十三节）：第三个视图 view: 'lessons'，入口 = 工具栏「🎓 学堂」；
// 关卡运行器在 ui/lessons/（独立 reducer + localStorage 进度 go-lessons-completed），
// 复用 Board 渲染，无 AI 对手——与国象学堂的交互形态一致。
import './go.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Board from './Board';
import Runner from './lessons/Runner';
import { useGo } from './useGo';
import { legalMoves } from '../engine/go';
import type { GoAiReply as AiReply, GoAiRequest } from './go.ai.worker';
import type { Difficulty } from '../engine/mcts';

/** 对局模式：pvp = 同屏双人；其余 = 人机对弈（AI 执白，值为难度档） */
type Mode = 'pvp' | Difficulty;

const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'pvp', label: '双人' },
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

export default function Game() {
  const { state, dispatch } = useGo();
  const [showResult, setShowResult] = useState(true);
  // 对局 / 学堂三视图中的前两个：学堂独占整页（运行器自带返回）
  const [view, setView] = useState<'play' | 'lessons'>('play');
  const [mode, setMode] = useState<Mode>('pvp');
  const [thinking, setThinking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待

  const playing = state.status === 'playing';
  const marking = state.status === 'marking';
  const done = state.status === 'done';
  const humanTurn = playing && (mode === 'pvp' || state.current === 1);
  // AI 思考中传空集合锁盘（悬停预览与可点性一并关闭）；人机模式白方回合同样锁定
  const legal = useMemo(() => new Set(humanTurn ? legalMoves(state) : []), [state, humanTurn]);
  const lastWasPass = playing && state.lastMove < 0 && state.history.length > 0;
  const [blackCaptures, whiteCaptures] = state.captures;

  // Worker 生命周期（与 chess / gomoku / reversi 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./go.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const msg = e.data;
      if (pendingRef.current !== msg.id) return; // 过期回复（已重开 / 已悔棋 / 已换难度）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      // AI 与人类共用同一 place / pass 动作：最后一手标记、悔棋快照、终局判定天然复用
      if (msg.move >= 0) dispatch({ type: 'place', idx: msg.move });
      else dispatch({ type: 'pass' });
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch]);

  // AI 回合调度：人机模式下轮到白方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素；换难度会以新 id 重新请求，旧回复按 id 丢弃。
  useEffect(() => {
    if (mode === 'pvp' || state.status !== 'playing' || state.current !== 2) return;
    const id = ++seqRef.current;
    pendingRef.current = id;
    setThinking(true);
    workerRef.current?.postMessage({
      type: 'choose',
      id,
      difficulty: mode,
      board: Array.from(state.board),
      current: state.current,
      koPoint: state.koPoint,
      passes: state.passes,
      ply: state.history.length,
    } satisfies GoAiRequest);
  }, [state.status, state.current, state.board, state.koPoint, state.passes, mode]);

  const cancelPending = useCallback(() => {
    pendingRef.current = 0; // 作废在途请求（防切回双人 / 重开后迟到回复落地）
    setThinking(false);
  }, []);

  const handlePick = useCallback(
    (idx: number) => {
      if (playing && humanTurn) dispatch({ type: 'place', idx });
      else if (marking) dispatch({ type: 'toggleDead', idx });
    },
    [playing, humanTurn, marking, dispatch],
  );

  const handleMode = useCallback(
    (m: Mode) => {
      cancelPending(); // 换模式作废在途请求
      setMode(m);
    },
    [cancelPending],
  );

  const handleReset = useCallback(() => {
    setShowResult(true);
    cancelPending();
    dispatch({ type: 'reset' });
  }, [dispatch, cancelPending]);

  const handleConfirm = useCallback(() => {
    setShowResult(true);
    dispatch({ type: 'confirm' });
  }, [dispatch]);

  const handleUndo = useCallback(() => {
    if (thinking || state.history.length === 0) return;
    if (mode === 'pvp') {
      dispatch({ type: 'undo' });
      return;
    }
    // 人机：连退两手（AI 应手 + 己方上一手）回到己方回合，避免退完又轮到 AI 原样重下
    dispatch({ type: 'undo' });
    dispatch({ type: 'undo' });
  }, [thinking, state.history.length, mode, dispatch]);

  const result = state.result;
  const winnerText = result
    ? result.winner === 1
      ? '黑胜'
      : result.winner === 2
        ? '白胜'
        : '和棋'
    : '';

  if (view === 'lessons') {
    return (
      <div className="app">
        <nav className="topnav">
          <a href="#/">← 游戏大厅</a>
        </nav>

        <header className="header">
          <h1>围棋</h1>
          <p className="subtitle">Go · 围棋学堂 · 闯关式互动教学，从提子学到两眼做活</p>
        </header>

        <Runner onBack={() => setView('play')} />
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>围棋</h1>
        <p className="subtitle">Go · 9 路中国规则 · 双人对弈 / 人机对弈</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="go-stone mini black" /> 黑 · 提 <b>{blackCaptures}</b>
        </span>
        <span className="chip">
          <span className="go-stone mini white" /> 白 · 提 <b>{whiteCaptures}</b>
        </span>
        {playing && (
          <span className="chip">
            轮到{' '}
            <b>
              {mode === 'pvp'
                ? state.current === 1
                  ? '黑方'
                  : '白方'
                : state.current === 1
                  ? '你（黑）'
                  : 'AI（白）'}
            </b>
          </span>
        )}
        {marking && <span className="chip">标记死子</span>}
        {done && result && (
          <span className="chip">
            {winnerText}：黑 <b>{result.black}</b> / 白 <b>{result.white}</b>
          </span>
        )}
        {lastWasPass && <span className="chip">上一手：虚着</span>}
        {thinking && <span className="chip thinking">AI 思考中</span>}
        <span className="chip">
          第 <b>{state.history.length}</b> 手
        </span>
      </div>

      <Board state={state} legal={legal} onPick={handlePick} />

      <div className="toolbar">
        <div className="go-seg" role="group" aria-label="对局模式与 AI 难度">
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn go-seg-btn${mode === o.value ? ' active' : ''}`}
              aria-pressed={mode === o.value}
              onClick={() => handleMode(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {marking ? (
          <>
            <button className="btn primary" onClick={handleConfirm}>
              确认数子
            </button>
            <button
              className="btn"
              onClick={() => dispatch({ type: 'clearDead' })}
              disabled={state.dead.length === 0}
            >
              全部恢复活棋
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => dispatch({ type: 'pass' })} disabled={!humanTurn}>
            虚着一手
          </button>
        )}
        <button
          className="btn"
          onClick={handleUndo}
          disabled={thinking || state.history.length === 0}
        >
          悔棋
        </button>
        {done && !showResult && (
          <button className="btn" onClick={() => setShowResult(true)}>
            查看结果
          </button>
        )}
        <button className="btn" onClick={handleReset} disabled={state.history.length === 0}>
          重新开始
        </button>
        <button className="btn" onClick={() => setView('lessons')}>
          🎓 学堂
        </button>
      </div>

      <p className="rules">
        {mode === 'pvp'
          ? '双人对弈：黑先白后轮流落子；无气的棋子会被提走（顶部「提」数即战果）；禁自杀；简单劫——被提一子后不得立即回提（虚线圆圈为劫禁点）。双方连续虚着则终局，点选死子后数子定胜负。点「🎓 学堂」进入围棋学堂：6 个互动关卡从气与提子一路学到两眼做活，每关必须亲手完成目标才能过关，通关进度保存在本地。'
          : '人机对弈：你执黑先行，AI 执白。难度分三档——简单＝吃子教学启发式（抓吃 / 救子 / 打吃，适合新手）；中等＝蒙特卡洛树搜索（MCTS 加权快走）；困难＝MCTS＋战术聚焦＋更大模拟预算（最强）。AI 思考时棋盘暂时锁定，可随时换难度（当前思考按新档重算）；悔棋会连 AI 的应手一起回退。终局数子仍由双方手工标记死子。'}
      </p>

      {done && result && showResult && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{result.winner === 0 ? '🤝' : '🏆'}</div>
            <div className="grade">
              {winnerText}
              {mode !== 'pvp' && (result.winner === 1 ? '（你赢了！）' : result.winner === 2 ? '（AI 获胜）' : '')}
            </div>
            <p className="detail">
              黑 <b>{result.black}</b> 子 · 白 <b>{result.white}</b> 子（含贴 3¾ 子）
              <br />
              共 <b>{state.history.length}</b> 手 · 模式{' '}
              <b>{MODE_OPTIONS.find((o) => o.value === mode)?.label}</b>
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowResult(false)}>
                查看棋盘
              </button>
              <button className="btn primary" onClick={handleReset}>
                再来一局
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
