// 应用根：hash 路由分发。#/gameId → 对应游戏；其他 → 大厅
import { Suspense, useEffect, useState } from 'react';
import { getGame, GAMES } from './games/registry';
import Hub from './hub/Hub';

function currentGameId(): string | null {
  const m = window.location.hash.match(/^#\/([\w-]+)/);
  return m ? m[1] : null;
}

export default function App() {
  const [gameId, setGameId] = useState<string | null>(currentGameId);

  useEffect(() => {
    const onHashChange = () => setGameId(currentGameId());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const game = gameId ? getGame(gameId) : null;

  useEffect(() => {
    document.title = game
      ? `${game.name} · Mini Chess Games`
      : 'Mini Chess Games · 游戏大厅';
  }, [game]);

  if (!gameId) return <Hub games={GAMES} />;

  if (!game) {
    return (
      <div className="app">
        <div className="loading">
          <p>没找到这款游戏（{gameId}）。</p>
          <p>
            <a href="#/">← 返回大厅</a>
          </p>
        </div>
      </div>
    );
  }

  const Game = game.component;
  return (
    <Suspense fallback={<div className="loading">加载中…</div>}>
      <Game />
    </Suspense>
  );
}
