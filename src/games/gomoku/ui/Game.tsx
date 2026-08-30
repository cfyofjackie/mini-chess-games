// 五子棋游戏页（阶段二）：人类执黑 vs AI 执白。
// AI 落子走同一个 reducer place 动作（最后一手标记 / 悔棋快照 / 胜负判定全部复用）；
// AI 思考在 Web Worker 中进行，棋盘锁定并显示"AI 思考中"；
// 过期回复（重开 / 悔棋 / 换难度）按请求 id 丢弃。
import './gomoku.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board from './Board';
import { useGomoku } from './useGomoku';
import type { AiReply, AiRequest } from './gomoku.ai.worker';
import type { Difficulty } from '../engine/ai';

const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

export default function Game() {
  const { state, dispatch } = useGomoku();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待

  const over = state.status !== 'playing';
  const humanTurn = state.status === 'playing' && state.current === 1;
  const result = state.status === 'won' ? (state.winner === 1 ? '你获胜' : 'AI 获胜') : '和棋';

  // Worker 生命周期（与 reversi / peg-solitaire solver 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./gomoku.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const { id, move } = e.data;
      if (pendingRef.current !== id) return; // 过期回复（已重开 / 已悔棋 / 已换难度）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      // AI 与人类共用同一 place 动作：最后一手标记、悔棋快照、胜负判定天然复用
      if (move >= 0) dispatch({ type: 'place', idx: move });
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch]);

  // AI 回合调度：轮到白方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素；换难度会以新 id 重新请求，旧回复按 id 丢弃。
  useEffect(() => {
    if (state.status !== 'playing' || state.current !== 2) return;
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
        <h1>五子棋</h1>
        <p className="subtitle">Gomoku · 你执黑先行，AI 执白</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="g-stone mini black" /> 你（黑）
        </span>
        <span className="chip">
          <span className="g-stone mini white" /> AI（白）
        </span>
        {state.status === 'playing' ? (
          <span className="chip">
            轮到 <span className={`g-stone mini ${state.current === 1 ? 'black' : 'white'}`} />{' '}
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
        <div className="g-seg" role="group" aria-label="AI 难度">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn g-seg-btn${difficulty === o.value ? ' active' : ''}`}
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
        你执黑先行，AI 执白，可在下方切换 AI 难度（简单＝启发式单步；中等＝浅层搜索；困难＝深度搜索＋
        必杀必防规则）。点击交叉点落子，任意横、竖、斜方向连成五子即胜（自由规则：长连同样获胜，无禁手）；
        棋盘下满则为和棋。AI 思考时棋盘暂时锁定。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{state.status === 'won' ? (state.winner === 1 ? '🏆' : '🤖') : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              共 <b>{state.history.length}</b> 手 · 难度{' '}
              <b>{DIFFICULTY_OPTIONS.find((o) => o.value === difficulty)?.label}</b>
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
