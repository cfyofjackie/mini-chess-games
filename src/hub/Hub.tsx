// 游戏大厅：从注册表渲染所有可玩棋类的入口卡片
import type { GameModule } from '../games/registry';

interface HubProps {
  games: GameModule[];
}

export default function Hub({ games }: HubProps) {
  return (
    <div className="app">
      <header className="header">
        <h1>Mini Chess Games</h1>
        <p className="subtitle">选一款棋，开始对局</p>
      </header>

      <div className="hub-grid">
        {games.map((g) => (
          <a key={g.id} className="hub-card" href={`#/${g.id}`}>
            <span className="hub-card-icon" aria-hidden="true">
              {g.icon}
            </span>
            <span className="hub-card-name">{g.name}</span>
            <span className="hub-card-desc">{g.description}</span>
            <span className="hub-card-go">进入 →</span>
          </a>
        ))}
      </div>
    </div>
  );
}
