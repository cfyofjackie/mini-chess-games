// 中国象棋游戏页：同屏双人对弈（红先），将军提示与终局弹窗
import './xiangqi.css';
import Board, { sideName } from './Board';
import { useXiangqi } from './useXiangqi';

export default function Game() {
  const { state, dispatch } = useXiangqi();
  const { game } = state;
  const over = game.status !== 'playing';
  const result = over ? `${sideName(game.winner === 1 ? 1 : 2)} 获胜` : '';
  const reasonText = game.reason === 'checkmate' ? '将死' : '困毙';

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>中国象棋</h1>
        <p className="subtitle">Xiangqi · 楚河汉界，红先黑后</p>
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
              <b>{sideName(game.current)}</b>
            </span>
            {game.check && <span className="chip x-check">将军！</span>}
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
        同屏双人：红方先行。点击己方棋子后，所有合法落点以圆点标出（可吃之子带红圈），点击落点即完成走子。
        将帅不可照面；马有蹩马腿、相有塞象眼且不过河、炮吃子须隔一炮架、兵过河后才能横走。
        被将军必须应将；无子可动判负——正被将军为将死，否则为困毙。
      </p>

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">🏆</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {reasonText} · 共 <b>{game.history.length}</b> 手
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
