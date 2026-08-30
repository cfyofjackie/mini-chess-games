// 黑白棋游戏页（阶段二）：人类执黑 vs AI 执白。
// AI 走子走同一个 reducer place 动作（悔棋/最后一手/翻转动画全部复用）；
// AI 思考在 Web Worker 中进行，棋盘锁定并显示"AI 思考中"；
// pass 自动流转依赖引擎 place 的折叠语义（轮到方恒有步），UI 层只负责提示与请求调度。
import './reversi.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board, { stoneName } from './Board';
import { useReversi } from './useReversi';
import { discCounts, legalMoves } from '../engine/reversi';
import type { AiReply, AiRequest } from './reversi.ai.worker';
import type { Difficulty } from '../engine/ai';

const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

export default function Game() {
  const { state, dispatch } = useReversi();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待

  const over = state.status !== 'playing';
  const humanTurn = state.status === 'playing' && state.current === 1;
  const { black, white } = discCounts(state.board);
  const result = state.status === 'won' ? (state.winner === 1 ? '你获胜' : 'AI 获胜') : '和棋';

  // Worker 生命周期（与 peg-solitaire solver 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./reversi.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const { id, move } = e.data;
      if (pendingRef.current !== id) return; // 过期回复（已重开 / 已悔棋）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      // AI 与人类共用同一 place 动作：悔棋快照、最后一手标记、翻转动画天然复用
      if (move >= 0) dispatch({ type: 'place', idx: move });
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch]);

  // AI 回合调度：轮到白方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素，clearPass 等 UI 状态更新不会重复触发。
  useEffect(() => {
    if (state.status !== 'playing' || state.current !== 2) return;
    // 引擎保证 status==='playing' 时轮到方必有合法步（pass 被折叠进 place），
    // 这里仍防御性检查：AI 无步时无需请求。
    if (legalMoves(state).length === 0) return;
    const id = ++seqRef.current;
    pendingRef.current = id;
    setThinking(true);
    workerRef.current?.postMessage({
      type: 'choose',
      id,
      difficulty,
      board: Array.from(state.board),
      current: state.current,
    } satisfies AiRequest);
  }, [state.status, state.current, state.board, difficulty]);

  // pass 提示浮条 2.6s 后自动消失
  useEffect(() => {
    if (state.passedBy === 0) return;
    const t = window.setTimeout(() => dispatch({ type: 'clearPass' }), 2600);
    return () => window.clearTimeout(t);
  }, [state.passedBy, dispatch]);

  const handleUndo = useCallback(() => {
    if (thinking || state.history.length === 0) return;
    dispatch({ type: 'undoToHuman' }); // 连 AI 的手一起回退，回到人类回合
  }, [thinking, state.history.length, dispatch]);

  const handleReset = useCallback(() => {
    pendingRef.current = 0; // 作废在途请求
    setThinking(false);
    dispatch({ type: 'reset' });
  }, [dispatch]);

  const handlePlace = useCallback(
    (idx: number) => {
      if (humanTurn) dispatch({ type: 'place', idx });
    },
    [humanTurn, dispatch],
  );

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>黑白棋</h1>
        <p className="subtitle">Reversi · 你执黑先行，AI 执白</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="r-stone mini black" /> 你（黑） <b>{black}</b>
        </span>
        <span className="chip">
          <span className="r-stone mini white" /> AI（白） <b>{white}</b>
        </span>
        {state.status === 'playing' ? (
          <span className="chip">
            轮到 <span className={`r-stone mini ${state.current === 1 ? 'black' : 'white'}`} />{' '}
            <b>{state.current === 1 ? '你' : 'AI'}</b>
          </span>
        ) : (
          <span className="chip">{result}</span>
        )}
        {thinking && <span className="chip thinking">AI 思考中</span>}
        <span className="chip">
          第 <b>{state.history.length}</b> 手
        </span>
      </div>

      <Board state={state} locked={!humanTurn} onPlace={handlePlace} />

      <div className="toolbar">
        <div className="r-seg" role="group" aria-label="AI 难度">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn r-seg-btn${difficulty === o.value ? ' active' : ''}`}
              aria-pressed={difficulty === o.value}
              onClick={() => setDifficulty(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={handleUndo} disabled={thinking || state.history.length === 0}>
          悔棋
        </button>
        <button className="btn" onClick={handleReset} disabled={state.history.length === 0}>
          重新开始
        </button>
      </div>

      <p className="rules">
        你执黑先行，AI 执白，可在上方切换 AI 难度（简单＝贪心翻子最多；中等＝浅层搜索＋位置权重；
        困难＝更深搜索＋终局精确计算）。点击半透明圆点处落子，新落子与己方棋子夹住的对方棋子会被翻转；
        一方无合法落子时自动跳过，双方都无法落子（或棋盘下满）时子多者获胜。
      </p>

      {state.passedBy !== 0 && (
        <div className="toast">{stoneName(state.passedBy === 1 ? 1 : 2)}无合法落子，自动跳过</div>
      )}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{state.status === 'won' ? (state.winner === 1 ? '🏆' : '🤖') : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              黑 <b>{black}</b> : 白 <b>{white}</b> · 共 <b>{state.history.length}</b> 手
            </p>
            <div className="modal-actions">
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
    </div>
  );
}
