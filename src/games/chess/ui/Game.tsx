// 国际象棋游戏页（阶段二）：人类执白 vs AI 执黑，三档难度可选（默认中等）。
// AI 走子走同一个 reducer 的 aiMove 动作（悔棋快照 / 最后一手高亮 / 升变语义全部复用）；
// AI 思考在 Web Worker 中进行，棋盘锁定并显示"AI 思考中"；
// 过期回复（重开 / 悔棋 / 换难度）按请求 id 丢弃。
import './chess.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board, { sideName } from './Board';
import { useChess } from './useChess';
import type { AiReply, AiRequest } from './chess.ai.worker';
import type { Difficulty } from '../engine/ai';
import type { Promotion } from '../engine/chess';

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

/** 升变选项（规格顺序：后/车/象/马），按行棋方取白/黑字形 */
const PROMOTION_CHOICES: ReadonlyArray<{ piece: Promotion; white: string; black: string; name: string }> = [
  { piece: 'q', white: '♕', black: '♛', name: '后' },
  { piece: 'r', white: '♖', black: '♜', name: '车' },
  { piece: 'b', white: '♗', black: '♝', name: '象' },
  { piece: 'n', white: '♘', black: '♞', name: '马' },
];

export default function Game() {
  const { state, dispatch } = useChess();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待

  const { game } = state;
  const over = game.status !== 'playing';
  const humanTurn = game.status === 'playing' && game.current === 1;
  const result = over
    ? game.status === 'won'
      ? game.winner === 1 ? '你获胜' : 'AI 获胜'
      : '和棋'
    : '';

  // Worker 生命周期（与 reversi / gomoku / peg-solitaire solver 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./chess.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const { id, from, to, promotion } = e.data;
      if (pendingRef.current !== id) return; // 过期回复（已重开 / 已悔棋 / 已换难度）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      // AI 与人类共用同一 makeMove 通路：最后一手高亮、悔棋快照、终局判定天然复用
      if (from >= 0) dispatch({ type: 'aiMove', from, to, promotion });
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch]);

  // AI 回合调度：轮到黑方且对局进行中时向 Worker 请求求解。
  // 依赖只含影响求解的局面要素（board 引用随每次走子更新）；
  // 换难度会以新 id 重新请求，旧回复按 id 丢弃。
  useEffect(() => {
    if (game.status !== 'playing' || game.current !== 2) return;
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
  }, [game.status, game.current, game.board, game.castling, game.enPassant, difficulty]);

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
      if (humanTurn) dispatch({ type: 'tap', idx }); // AI 思考中锁盘：非人类回合不响应点击
    },
    [humanTurn, dispatch],
  );

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
        {over ? (
          <span className="chip">{result}</span>
        ) : (
          <>
            <span className="chip">
              轮到{' '}
              <span className={`c-pc mini ${game.current === 1 ? 'white' : 'black'}`}>
                {game.current === 1 ? '♔' : '♚'}
              </span>{' '}
              <b>{game.current === 1 ? '你' : 'AI'}</b>
            </span>
            {game.check && <span className="chip c-check">将军！</span>}
            {thinking && <span className="chip thinking">AI 思考中</span>}
          </>
        )}
      </div>

      <Board state={game} selected={state.selected} onTap={handleTap} />

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
          disabled={thinking || game.history.length === 0}
        >
          悔棋
        </button>
        <button
          className="btn"
          onClick={handleReset}
          disabled={game.history.length === 0}
        >
          重新开始
        </button>
      </div>

      <p className="rules">
        你执白先行，AI 执黑，可在工具栏切换 AI 难度（简单＝只看一步的贪心；中等＝三层搜索＋吃子延伸；
        困难＝更深迭代搜索＋启发排序）。点击己方棋子后，合法落点以圆点标出（可吃之子与吃过路兵带红圈），
        点击落点即完成走子；兵抵达底线弹出浮层自选升变棋子，取消可改走别的步。
        王车易位需权利未失、路径无子且不被将军；对方兵刚走两格时可用吃过路兵，机会仅一手。
        AI 思考时棋盘暂时锁定，悔棋会连 AI 的应手一起回退。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.status === 'won' ? (game.winner === 1 ? '🏆' : '🤖') : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {REASON_TEXT[game.reason] ?? ''} · 共 <b>{game.history.length}</b> 手
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

      {!over && state.pending && (
        <div className="overlay">
          <div className="modal c-promo" role="dialog" aria-modal="true" aria-label="选择升变棋子">
            <div className="emoji">{game.current === 1 ? '♕' : '♛'}</div>
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
                    {game.current === 1 ? choice.white : choice.black}
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
