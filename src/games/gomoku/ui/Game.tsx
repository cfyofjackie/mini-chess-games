// 五子棋游戏页：同屏双人轮流落子
import './gomoku.css';
import Board, { stoneName } from './Board';
import { useGomoku } from './useGomoku';

export default function Game() {
  const { state, dispatch } = useGomoku();
  const over = state.status !== 'playing';
  const result =
    state.status === 'won' ? `${state.winner === 1 ? '黑方' : '白方'} 获胜` : '和棋';

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>五子棋</h1>
        <p className="subtitle">Gomoku · 黑白对弈，先连五子者胜</p>
      </header>

      <div className="status">
        <span className="chip">
          第 <b>{state.history.length}</b> 手
        </span>
        {state.status === 'playing' ? (
          <span className="chip">
            轮到{' '}
            <span className={`g-stone mini ${state.current === 1 ? 'black' : 'white'}`} />{' '}
            <b>{stoneName(state.current)}</b>
          </span>
        ) : (
          <span className="chip">{result}</span>
        )}
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
        同屏双人：两位玩家轮流点击交叉点落子，黑方先行。任意横、竖、斜方向连成五子即胜
        （自由规则：长连同样获胜，无禁手）；棋盘下满则为和棋。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{state.status === 'won' ? '🏆' : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              共 <b>{state.history.length}</b> 手
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
