// 国际跳棋游戏页（阶段一）：同屏双人，红先白后，有吃必吃。
// chips 展示手数、双方子数、轮次、强制吃子提示与双王残局无进展计数；
// 终局弹窗给出胜方与原因（吃光 / 困毙 / 和棋），支持快照悔棋。
import './checkers.css';
import { useCallback, useEffect } from 'react';
import Board, { sideName } from './Board';
import { useCheckers } from './useCheckers';
import { DRAW_PLIES, type EndReason, isBareKings, mustCapture, pieceCount } from '../engine/checkers';

const REASON_TEXT: Readonly<Record<EndReason, string>> = {
  cleared: '吃光对方全部棋子',
  blocked: '对方无合法步（困毙）',
  'no-progress': '双方各剩一王，无进展判和',
  '': '',
};

export default function Game() {
  const { state, dispatch } = useCheckers();
  const { game } = state;
  const over = game.status !== 'playing';
  const must = !over && mustCapture(game);
  const bare = isBareKings(game.board);
  const n1 = pieceCount(game.board, 1);
  const n2 = pieceCount(game.board, 2);
  const result = over
    ? game.status === 'won'
      ? `${sideName(game.winner === 1 ? 1 : 2)} 获胜`
      : '和棋'
    : '';

  // 点击提示浮条 2.6s 后自动消失
  useEffect(() => {
    if (state.hint === '') return;
    const t = window.setTimeout(() => dispatch({ type: 'clearHint' }), 2600);
    return () => window.clearTimeout(t);
  }, [state.hint, dispatch]);

  const handleTap = useCallback((idx: number) => dispatch({ type: 'tap', idx }), [dispatch]);

  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/">← 游戏大厅</a>
      </nav>

      <header className="header">
        <h1>国际跳棋</h1>
        <p className="subtitle">Checkers · 英式规则 · 红先白后，有吃必吃</p>
      </header>

      <div className="status">
        <span className="chip">
          <span className="ck-pc mini red" /> 红方 <b>{n1}</b>/12
        </span>
        <span className="chip">
          <span className="ck-pc mini white" /> 白方 <b>{n2}</b>/12
        </span>
        {over ? (
          <span className="chip">{result}</span>
        ) : (
          <span className="chip">
            轮到 <span className={`ck-pc mini ${game.current === 1 ? 'red' : 'white'}`} />{' '}
            <b>{sideName(game.current)}</b>
          </span>
        )}
        {must && <span className="chip ck-must-chip">有吃必吃</span>}
        {bare && !over && (
          <span className="chip">
            无进展 <b>{game.noProgress}</b>/{DRAW_PLIES}
          </span>
        )}
        <span className="chip">
          第 <b>{game.history.length}</b> 手
        </span>
      </div>

      <Board state={game} selected={state.selected} onTap={handleTap} />

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
        同屏双人：红方先行（棋盘下方）。普通兵只能斜前走一格；斜跳过相邻敌子落到其后的空格即吃子，
        有吃必吃且连跳链必须走完（链中可变向）；到达对方底线升变为王（皇冠标记），
        王可沿斜向四方向走/跳。一方无子或无合法步判负；双方各剩一王且连续 {DRAW_PLIES}{' '}
        半步无吃子判和。点击棋子查看合法落点，点击落点即完成走子（连跳一步直达终点）。
      </p>

      {state.hint !== '' && <div className="toast">{state.hint}</div>}

      {over && (
        <div className="overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
            <div className="emoji">{game.status === 'won' ? '🏆' : '🤝'}</div>
            <div className="grade">{result}</div>
            <p className="detail">
              {REASON_TEXT[game.reason]} · 共 <b>{game.history.length}</b> 手
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
