// 中国跳棋游戏页：同屏双人对角竞速（靛蓝方先行，目标为上方对臂）
import './chinese-checkers.css';
import { useEffect } from 'react';
import Board, { sideName } from './Board';
import { useChineseCheckers } from './useChineseCheckers';
import { campProgress } from '../engine/chinese-checkers';

export default function Game() {
  const { state, dispatch } = useChineseCheckers();
  const { game } = state;
  const over = game.status !== 'playing';
  const p1 = campProgress(game.board, 1);
  const p2 = campProgress(game.board, 2);
  const result = over ? `${sideName(game.winner === 1 ? 1 : 2)} 获胜` : '';

  // 点击提示浮条 2.6s 后自动消失
  useEffect(() => {
    if (state.hint === '') return;
    const t = window.setTimeout(() => dispatch({ type: 'clearHint' }), 2600);
    return () => window.clearTimeout(t);
  }, [state.hint, dispatch]);

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>中国跳棋</h1>
        <p className="subtitle">Chinese Checkers · 对角竞速，先全员进驻对臂者胜</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="cc-piece mini indigo" /> 靛蓝 <b>{p1}</b>/10
        </span>
        <span className="chip">
          <span className="cc-piece mini rose" /> 玫红 <b>{p2}</b>/10
        </span>
        {game.status === 'playing' ? (
          <span className="chip">
            轮到 <span className={`cc-piece mini ${game.current === 1 ? 'indigo' : 'rose'}`} />{' '}
            <b>{sideName(game.current)}</b>
          </span>
        ) : (
          <span className="chip">{result}</span>
        )}
        <span className="chip">
          第 <b>{game.history.length}</b> 手
        </span>
      </div>

      <Board
        state={game}
        selected={state.selected}
        onTap={(idx) => dispatch({ type: 'tap', idx })}
      />

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
        同屏双人：靛蓝方先行（下方出发），双方沿六个方向走一步，或跳过紧邻棋子落到其后空孔且可连续跳
        （链中可变向、不吃子）。点击棋子查看全部可达终点，再点终点完成操作；先把 10 颗棋子全部送进对面出发臂者获胜。
      </p>

      {state.hint !== '' && <div className="toast">{state.hint}</div>}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">🏆</div>
            <div className="grade">{result}</div>
            <p className="detail">
              靛蓝 <b>{p1}</b>/10 · 玫红 <b>{p2}</b>/10 · 共 <b>{game.history.length}</b> 手
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
