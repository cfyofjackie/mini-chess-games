// 中国象棋游戏页（阶段二）：人类执红先行 vs AI 执黑，三档难度可选（默认中等）。
// AI 走子走同一个 reducer 的 aiMove 动作（悔棋快照 / 最后一手高亮 / 终局判定全部复用）；
// AI 思考在 Web Worker 中进行，AI 回合锁盘并显示"AI 思考中"；
// 过期回复（重开 / 悔棋 / 换难度）按请求 id 丢弃；
// 落子停顿：Worker 回复到达后延迟 AI_LAG_MS 再应用（"AI 想好了，正要落子"的节奏），
//   重开 / 悔棋 / 换难度会同步取消挂起的延迟与在途请求，过期着法不落地。
import './xiangqi.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Board from './Board';
import { useXiangqi } from './useXiangqi';
import type { AiReply, AiRequest } from './xiangqi.ai.worker';
import type { Difficulty } from '../engine/ai';

/** Worker 回复到达后到实际落子之间的固定停顿（毫秒，与 chess 一致） */
const AI_LAG_MS = 600;

const DIFFICULTY_OPTIONS: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

export default function Game() {
  const { state, dispatch } = useXiangqi();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [thinking, setThinking] = useState(false);
  const [applying, setApplying] = useState(false); // Worker 已回复，停顿等待落子
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0); // 请求自增 id
  const pendingRef = useRef(0); // 当前等待中的请求 id；0 = 无等待
  const applyTimerRef = useRef<number | null>(null); // 挂起落子延迟的定时器

  // 取消挂起的落子延迟（重开 / 悔棋 / 换难度 / 卸载时调用，过期着法不落地）
  const cancelAiApply = useCallback(() => {
    if (applyTimerRef.current !== null) {
      clearTimeout(applyTimerRef.current);
      applyTimerRef.current = null;
    }
    setApplying(false);
  }, []);

  const { game } = state;
  const over = game.status !== 'playing';
  const humanTurn = game.status === 'playing' && game.current === 1;
  const result = over ? (game.winner === 1 ? '你获胜' : 'AI 获胜') : '';
  const reasonText = game.reason === 'checkmate' ? '将死' : '困毙';

  // Worker 生命周期（与 reversi / gomoku / chess 相同的接入方式）
  useEffect(() => {
    const w = new Worker(new URL('./xiangqi.ai.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<AiReply>) => {
      const { id, from, to } = e.data;
      if (pendingRef.current !== id) return; // 过期回复（已重开 / 已悔棋 / 已换难度）直接丢弃
      pendingRef.current = 0;
      setThinking(false);
      if (from < 0) return; // 无合法步（防御；对局中不会发生）
      // 落子停顿：不立即落子，固定延迟后再应用，玩家可感知"AI 想好了，正要落子"
      setApplying(true);
      applyTimerRef.current = window.setTimeout(() => {
        applyTimerRef.current = null;
        setApplying(false);
        // AI 与人类共用同一 place 通路：最后一手高亮、悔棋快照、终局判定天然复用
        dispatch({ type: 'aiMove', from, to });
      }, AI_LAG_MS);
    };
    workerRef.current = w;
    return () => {
      cancelAiApply(); // 卸载时作废挂起延迟
      w.terminate();
      workerRef.current = null;
    };
  }, [dispatch, cancelAiApply]);

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
    } satisfies AiRequest);
    // 依赖变化（重开 / 悔棋 / 换难度）即作废挂起延迟，过期着法不落地
    return cancelAiApply;
  }, [game.status, game.current, game.board, difficulty, cancelAiApply]);

  const handleUndo = useCallback(() => {
    if (thinking || game.history.length === 0) return;
    pendingRef.current = 0; // 作废在途请求（防御：思考中按钮已禁用）
    cancelAiApply(); // 悔棋取消挂起延迟，过期着法不落地
    dispatch({ type: 'undoToHuman' }); // 连 AI 的应手一起回退，回到人类回合
  }, [thinking, game.history.length, cancelAiApply, dispatch]);

  const handleReset = useCallback(() => {
    pendingRef.current = 0; // 作废在途请求
    cancelAiApply(); // 重开取消挂起延迟
    setThinking(false);
    dispatch({ type: 'reset' });
  }, [cancelAiApply, dispatch]);

  const handleTap = useCallback(
    (idx: number) => {
      if (humanTurn) dispatch({ type: 'tap', idx }); // AI 回合锁盘：非人类回合不响应点击
    },
    [humanTurn, dispatch],
  );

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>中国象棋</h1>
        <p className="subtitle">Xiangqi · 楚河汉界，你执红先行，AI 执黑</p>
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
              <span className={`x-pc mini ${game.current === 1 ? 'red' : 'black'}`}>
                {game.current === 1 ? '帅' : '将'}
              </span>{' '}
              <b>{game.current === 1 ? '你' : 'AI'}</b>
            </span>
            {game.check && <span className="chip x-check">将军！</span>}
            {thinking && <span className="chip thinking">AI 思考中</span>}
            {applying && <span className="chip thinking">AI 落子中</span>}
          </>
        )}
      </div>

      <Board state={game} selected={state.selected} onTap={handleTap} />

      <div className="toolbar">
        <div className="x-seg" role="group" aria-label="AI 难度">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn x-seg-btn${difficulty === o.value ? ' active' : ''}`}
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
        你执红先行，AI 执黑，可在工具栏切换 AI 难度（简单＝只看一步的贪心；中等＝三层搜索＋吃子延伸；
        困难＝更深迭代搜索＋启发排序）。点击己方棋子后，所有合法落点以圆点标出（可吃之子带红圈），
        点击落点即完成走子。将帅不可照面；马有蹩马腿、相有塞象眼且不过河、炮吃子须隔一炮架、
        兵过河后才能横走。被将军必须应将；无子可动判负——正被将军为将死，否则为困毙。
        AI 思考时棋盘暂时锁定，悔棋会连 AI 的应手一起回退。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.winner === 1 ? '🏆' : '🤖'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {reasonText} · 共 <b>{game.history.length}</b> 手
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
