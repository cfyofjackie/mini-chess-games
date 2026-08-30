// 中国跳棋游戏页（阶段二）：人类执靛蓝（1 方）先行 vs AI 执玫红（2 方）。
// AI 走子走既有 reducer 的 tap 动作（选子 → 落子），悔棋快照、最后一手标记全部复用；
// AI 思考在 Web Worker 中进行，棋盘锁定并显示"AI 思考中"；过期回复按请求 id 丢弃。
import './chinese-checkers.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board from './Board';
import { useChineseCheckers } from './useChineseCheckers';
import { campProgress } from '../engine/chinese-checkers';
import { hasAnyMove } from '../engine/ai';
import type { AiReply, AiRequest } from './chinese-checkers.ai.worker';
import type { Difficulty } from '../engine/ai';

const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

export default function Game() {
  const { state, dispatch } = useChineseCheckers();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待

  const { game } = state;
  const over = game.status !== 'playing';
  const humanTurn = game.status === 'playing' && game.current === 1;
  const p1 = campProgress(game.board, 1);
  const p2 = campProgress(game.board, 2);
  const result = over ? (game.winner === 1 ? '你获胜' : 'AI 获胜') : '';

  // Worker 生命周期（与 peg-solitaire solver / reversi AI 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./chinese-checkers.ai.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const { id, from, to } = e.data;
      if (pendingRef.current !== id) return; // 过期回复（已重开 / 换难度重发）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      // AI 与人类共用同一 reducer tap 动作：选子 → 落子，悔棋快照与最后一手标记天然复用
      if (from >= 0 && to >= 0) {
        dispatch({ type: 'tap', idx: from });
        dispatch({ type: 'tap', idx: to });
      }
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch]);

  // AI 回合调度：轮到玫红方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素，clearHint 等 UI 状态更新不会重复触发。
  useEffect(() => {
    if (game.status !== 'playing' || game.current !== 2) return;
    // 防御：AI 无任何操作时不请求（引擎 v1 无 pass 规则，极端僵局只会停在原状）
    if (!hasAnyMove(game.board, 2)) return;
    const id = ++seqRef.current;
    pendingRef.current = id;
    setThinking(true);
    workerRef.current?.postMessage({
      type: 'choose',
      id,
      difficulty,
      board: Array.from(game.board),
      current: game.current,
    } satisfies AiRequest);
  }, [game.status, game.current, game.board, difficulty]);

  // 点击提示浮条 2.6s 后自动消失
  useEffect(() => {
    if (state.hint === '') return;
    const t = window.setTimeout(() => dispatch({ type: 'clearHint' }), 2600);
    return () => window.clearTimeout(t);
  }, [state.hint, dispatch]);

  const handleUndo = useCallback(() => {
    if (thinking || game.history.length === 0) return;
    dispatch({ type: 'undoToHuman' }); // 连 AI 的手一起回退，回到人类回合
  }, [thinking, game.history.length, dispatch]);

  const handleReset = useCallback(() => {
    pendingRef.current = 0; // 作废在途请求
    setThinking(false);
    dispatch({ type: 'reset' });
  }, [dispatch]);

  const handleTap = useCallback(
    (idx: number) => {
      if (humanTurn) dispatch({ type: 'tap', idx });
    },
    [humanTurn, dispatch],
  );

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>中国跳棋</h1>
        <p className="subtitle">Chinese Checkers · 你执靛蓝先行，AI 执玫红，先全员进驻对臂者胜</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="cc-piece mini indigo" /> 你（靛蓝） <b>{p1}</b>/10
        </span>
        <span className="chip">
          <span className="cc-piece mini rose" /> AI（玫红） <b>{p2}</b>/10
        </span>
        {game.status === 'playing' ? (
          <span className="chip">
            轮到 <span className={`cc-piece mini ${game.current === 1 ? 'indigo' : 'rose'}`} />{' '}
            <b>{game.current === 1 ? '你' : 'AI'}</b>
          </span>
        ) : (
          <span className="chip">{result}</span>
        )}
        {thinking && <span className="chip thinking">AI 思考中</span>}
        <span className="chip">
          第 <b>{game.history.length}</b> 手
        </span>
      </div>

      <Board state={game} selected={state.selected} locked={!humanTurn} onTap={handleTap} />

      <div className="toolbar">
        <div className="cc-seg" role="group" aria-label="AI 难度">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn cc-seg-btn${difficulty === o.value ? ' active' : ''}`}
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
          disabled={thinking || game.history.length === 0}
        >
          悔棋
        </button>
        <button className="btn" onClick={handleReset} disabled={game.history.length === 0}>
          重新开始
        </button>
      </div>

      <p className="rules">
        你执靛蓝先行（下方出发），AI 执玫红，可在工具栏切换 AI 难度（简单＝贪心推进；
        中等＝前瞻两层；困难＝三层搜索＋入营/堵门评估）。沿六个方向走一步，或跳过紧邻棋子落到其后
        空孔且可连续跳（链中可变向、不吃子）。点击棋子查看全部可达终点，再点终点完成操作；
        先把 10 颗棋子全部送进对面出发臂者获胜。
      </p>

      {state.hint !== '' && <div className="toast">{state.hint}</div>}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.winner === 1 ? '🏆' : '🤖'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              靛蓝 <b>{p1}</b>/10 · 玫红 <b>{p2}</b>/10 · 共 <b>{game.history.length}</b> 手
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
