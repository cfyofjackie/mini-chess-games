// 围棋对局页：同屏双人（黑先白后）。双方连续虚着进入标记模式，
// 整群点选死子后确认，按中国规则数子（活子 + 围空，黑贴 3¾ 子）出结果。
// 悔棋基于引擎快照栈，从对局 / 标记 / 终局任一阶段一键还原上一手。
// 学堂（chess.md 第十三节）：第三个视图 view: 'lessons'，入口 = 工具栏「🎓 学堂」；
// 关卡运行器在 ui/lessons/（独立 reducer + localStorage 进度 go-lessons-completed），
// 复用 Board 渲染，无 AI 对手——与国象学堂的交互形态一致。
import './go.css';
import { useCallback, useMemo, useState } from 'react';
import Board from './Board';
import Runner from './lessons/Runner';
import { useGo } from './useGo';
import { legalMoves } from '../engine/go';

export default function Game() {
  const { state, dispatch } = useGo();
  const [showResult, setShowResult] = useState(true);
  // 对局 / 学堂三视图中的前两个：学堂独占整页（运行器自带返回）
  const [view, setView] = useState<'play' | 'lessons'>('play');

  const playing = state.status === 'playing';
  const marking = state.status === 'marking';
  const done = state.status === 'done';
  const legal = useMemo(() => new Set(legalMoves(state)), [state]);
  const lastWasPass = playing && state.lastMove < 0 && state.history.length > 0;
  const [blackCaptures, whiteCaptures] = state.captures;

  const handlePick = useCallback(
    (idx: number) => {
      if (playing) dispatch({ type: 'place', idx });
      else if (marking) dispatch({ type: 'toggleDead', idx });
    },
    [playing, marking, dispatch],
  );

  const handleReset = useCallback(() => {
    setShowResult(true);
    dispatch({ type: 'reset' });
  }, [dispatch]);

  const handleConfirm = useCallback(() => {
    setShowResult(true);
    dispatch({ type: 'confirm' });
  }, [dispatch]);

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
        <p className="subtitle">Go · 9 路中国规则 · 同屏双人</p>
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
            轮到 <b>{state.current === 1 ? '黑方' : '白方'}</b>
          </span>
        )}
        {marking && <span className="chip">标记死子</span>}
        {done && result && (
          <span className="chip">
            {winnerText}：黑 <b>{result.black}</b> / 白 <b>{result.white}</b>
          </span>
        )}
        {lastWasPass && <span className="chip">上一手：虚着</span>}
        <span className="chip">
          第 <b>{state.history.length}</b> 手
        </span>
      </div>

      <Board state={state} legal={legal} onPick={handlePick} />

      <div className="toolbar">
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
          <button className="btn primary" onClick={() => dispatch({ type: 'pass' })} disabled={!playing}>
            虚着一手
          </button>
        )}
        <button className="btn" onClick={() => dispatch({ type: 'undo' })} disabled={state.history.length === 0}>
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
        {marking
          ? '双方连续虚着进入数子标记：点击棋子整群标记 / 取消死子（显示红叉），确认后按中国规则数子（活子＋围空，黑方贴 3¾ 子）。误入此步可点「悔棋」返回对局。'
          : '黑先白后轮流落子；无气的棋子会被提走（顶部「提」数即战果）；禁自杀；简单劫——被提一子后不得立即回提（虚线圆圈为劫禁点）。双方连续虚着则终局，点选死子后数子定胜负。点「🎓 学堂」进入围棋学堂：6 个互动关卡从气与提子一路学到两眼做活，每关必须亲手完成目标才能过关，通关进度保存在本地。'}
      </p>

      {done && result && showResult && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{result.winner === 0 ? '🤝' : '🏆'}</div>
            <div className="grade">{winnerText}</div>
            <p className="detail">
              黑 <b>{result.black}</b> 子 · 白 <b>{result.white}</b> 子（含贴 3¾ 子）
              <br />
              共 <b>{state.history.length}</b> 手
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
