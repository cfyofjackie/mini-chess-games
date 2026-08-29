// 国际象棋游戏页：同屏双人对弈（白先），将军提示与终局弹窗（将死 / 逼和 / 子力不足）
import './chess.css';
import Board, { sideName } from './Board';
import { useChess } from './useChess';

const REASON_TEXT: Record<string, string> = {
  checkmate: '将死',
  stalemate: '逼和：一方无子可动且未被将军',
  insufficient: '子力不足，双方均无法将杀',
};

export default function Game() {
  const { state, dispatch } = useChess();
  const { game } = state;
  const over = game.status !== 'playing';
  const result = over
    ? game.status === 'won'
      ? `${sideName(game.winner === 1 ? 1 : 2)} 获胜`
      : '和棋'
    : '';

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>国际象棋</h1>
        <p className="subtitle">Chess · 白先黑后，将死对方王者获胜</p>
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
              <b>{sideName(game.current)}</b>
            </span>
            {game.check && <span className="chip c-check">将军！</span>}
          </>
        )}
      </div>

      <Board state={game} selected={state.selected} onTap={(idx) => dispatch({ type: 'tap', idx })} />

      <div className="toolbar">
        <button
          className="btn"
          onClick={() => dispatch({ type: 'undo' })}
          disabled={game.history.length === 0}
        >
          悔棋
        </button>
        <button
          className="btn"
          onClick={() => dispatch({ type: 'reset' })}
          disabled={game.history.length === 0}
        >
          重新开始
        </button>
      </div>

      <p className="rules">
        同屏双人：白方先行。点击己方棋子后，合法落点以圆点标出（可吃之子与吃过路兵带红圈），点击落点即完成走子。
        兵直进斜吃、起始可走两格、到达底线自动升变为后；王车易位需权利未失、路径无子且不被将军；
        对方兵刚走两格时可用吃过路兵，机会仅一手。被将军必须应将；无合法步时被将军为将死（负）、
        否则为逼和（和）；双方仅剩王与少量轻子亦判和。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.status === 'won' ? '🏆' : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {REASON_TEXT[game.reason] ?? ''} · 共 <b>{game.history.length}</b> 手
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
