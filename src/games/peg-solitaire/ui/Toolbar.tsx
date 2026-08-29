interface ToolbarProps {
  canUndo: boolean;
  demo: boolean;
  thinking: boolean;
  over: boolean;
  onUndo: () => void;
  onHint: () => void;
  onDemo: () => void;
  onReset: () => void;
}

export default function Toolbar({
  canUndo,
  demo,
  thinking,
  over,
  onUndo,
  onHint,
  onDemo,
  onReset,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="btn" onClick={onUndo} disabled={!canUndo || demo || thinking}>
        悔棋
      </button>
      <button className="btn" onClick={onHint} disabled={thinking || demo || over}>
        提示
      </button>
      <button className="btn primary" onClick={onDemo} disabled={thinking || over}>
        {demo ? '停止演示' : '自动演示'}
      </button>
      <button className="btn" onClick={onReset} disabled={thinking}>
        重新开始
      </button>
    </div>
  );
}
