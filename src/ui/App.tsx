import { useCallback, useEffect, useMemo, useRef } from 'react';
import { pegCount } from '../engine/board';
import { legalMoves } from '../engine/rules';
import { grade, Grade } from '../engine/score';
import { SolveResult } from '../solver/solver';
import Board from './Board';
import ResultModal from './ResultModal';
import StatusBar from './StatusBar';
import Toolbar from './Toolbar';
import { useGame } from './useGame';

type SolveReply = { kind: 'hint' | 'demo'; result: SolveResult };

export default function App() {
  const { state: game, dispatch } = useGame();
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const w = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<SolveReply>) => {
      const { kind, result } = e.data;
      const note =
        result.status === 'timeout'
          ? '局面太复杂，暂时算不出来'
          : result.status === 'unsolvable'
            ? '当前局面已无法只剩一颗棋子'
            : undefined;
      const moves = result.status === 'solved' ? result.moves : null;
      dispatch(kind === 'hint' ? { type: 'hintDone', moves, note } : { type: 'demoDone', moves, note });
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!game.toast) return;
    const t = window.setTimeout(() => dispatch({ type: 'clearToast' }), 2600);
    return () => window.clearTimeout(t);
  }, [game.toast]);

  useEffect(() => {
    if (!game.demo) return;
    if (game.demo.index >= game.demo.moves.length) {
      dispatch({ type: 'stopDemo' });
      return;
    }
    const t = window.setTimeout(() => dispatch({ type: 'demoStep' }), 640);
    return () => window.clearTimeout(t);
  }, [game.demo]);

  const requestSolve = useCallback(
    (kind: 'hint' | 'demo') => {
      const w = workerRef.current;
      if (!w || game.thinking || game.demo || game.status === 'over') return;
      dispatch({ type: 'solveStart' });
      w.postMessage({ kind, lo: game.pegs.lo, hi: game.pegs.hi });
    },
    [game.thinking, game.demo, game.status, game.pegs],
  );

  const targets = useMemo(
    () =>
      game.selected == null
        ? []
        : legalMoves(game.pegs)
            .filter((m) => m.from === game.selected)
            .map((m) => m.to),
    [game.pegs, game.selected],
  );

  const handleCell = useCallback((cell: number) => dispatch({ type: 'select', cell }), []);

  const finalGrade: Grade | null = game.status === 'over' ? grade(game.pegs) : null;

  return (
    <div className="app">
      <header className="header">
        <h1>独立钻石</h1>
        <p className="subtitle">Peg Solitaire · 跳过邻子，只留一颗</p>
      </header>

      <StatusBar moveCount={game.moveCount} pegsLeft={pegCount(game.pegs)} thinking={game.thinking} />

      <Board
        pegs={game.pegs}
        selected={game.selected}
        targets={targets}
        hint={game.hint}
        lastMove={game.lastMove}
        interactive={!game.demo && !game.thinking && game.status !== 'over'}
        onSelect={handleCell}
      />

      <Toolbar
        canUndo={game.history.length > 0}
        demo={game.demo !== null}
        thinking={game.thinking}
        over={game.status === 'over'}
        onUndo={() => dispatch({ type: 'undo' })}
        onHint={() => requestSolve('hint')}
        onDemo={() => (game.demo ? dispatch({ type: 'stopDemo' }) : requestSolve('demo'))}
        onReset={() => dispatch({ type: 'reset' })}
      />

      <p className="rules">
        棋子沿横竖方向跳过紧邻的一颗棋子落入空位，被跳过的棋子移除；无法移动时游戏结束。
        剩得越少越强——只剩 1 子且落在中心即为「天才」。
      </p>

      {finalGrade && (
        <ResultModal
          grade={finalGrade}
          pegsLeft={pegCount(game.pegs)}
          moves={game.moveCount}
          canUndo={game.history.length > 0}
          onUndo={() => dispatch({ type: 'undo' })}
          onRestart={() => dispatch({ type: 'reset' })}
        />
      )}

      {game.toast && <div className="toast">{game.toast}</div>}
    </div>
  );
}
