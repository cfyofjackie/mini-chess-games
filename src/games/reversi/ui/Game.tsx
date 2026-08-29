// 黑白棋游戏页：同屏双人轮流落子，自动 pass 提示与终局弹窗
import './reversi.css';
import { useEffect } from 'react';
import Board, { stoneName } from './Board';
import { useReversi } from './useReversi';
import { discCounts } from '../engine/reversi';

export default function Game() {
  const { state, dispatch } = useReversi();
  const over = state.status !== 'playing';
  const { black, white } = discCounts(state.board);
  const result = state.status === 'won' ? `${stoneName(state.winner === 1 ? 1 : 2)} 获胜` : '和棋';

  // pass 提示浮条 2.6s 后自动消失
  useEffect(() => {
    if (state.passedBy === 0) return;
    const t = window.setTimeout(() => dispatch({ type: 'clearPass' }), 2600);
    return () => window.clearTimeout(t);
  }, [state.passedBy, dispatch]);

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>黑白棋</h1>
        <p className="subtitle">Reversi · 夹住翻转，子多者胜</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="r-stone mini black" /> 黑 <b>{black}</b>
        </span>
        <span className="chip">
          <span className="r-stone mini white" /> 白 <b>{white}</b>
        </span>
        {state.status === 'playing' ? (
          <span className="chip">
            轮到 <span className={`r-stone mini ${state.current === 1 ? 'black' : 'white'}`} />{' '}
            <b>{stoneName(state.current)}</b>
          </span>
        ) : (
          <span className="chip">{result}</span>
        )}
        <span className="chip">
          第 <b>{state.history.length}</b> 手
        </span>
      </div>

      <Board state={state} onPlace={(idx) => dispatch({ type: 'place', idx })} />

      <div className="toolbar">
        <button
          className="btn"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={state.history.length === 0}
        >
          悔棋
        </button>
        <button
          className="btn"
          onClick={() => dispatch({ type: 'reset' })}
          disabled={state.history.length === 0}
        >
          重新开始
        </button>
      </div>

      <p className="rules">
        同屏双人：黑方先行，点击半透明圆点处落子。新落子与己方棋子夹住的对方棋子会被翻转；
        无合法落子时自动跳过并由对方继续；双方都无法落子（或棋盘下满）时，子多者获胜。
      </p>

      {state.passedBy !== 0 && (
        <div className="toast">{stoneName(state.passedBy === 1 ? 1 : 2)}无合法落子，自动跳过</div>
      )}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{state.status === 'won' ? '🏆' : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              黑 <b>{black}</b> : 白 <b>{white}</b> · 共 <b>{state.history.length}</b> 手
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => dispatch({ type: 'undo' })}>
                悔棋一步
              </button>
              <button className="btn primary" onClick={() => dispatch({ type: 'reset' })}>
                再来一局
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
