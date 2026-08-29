interface StatusBarProps {
  moveCount: number;
  pegsLeft: number;
  thinking: boolean;
}

export default function StatusBar({ moveCount, pegsLeft, thinking }: StatusBarProps) {
  return (
    <div className="status">
      <span className="chip">
        第 <b>{moveCount}</b> 步
      </span>
      <span className="chip">
        剩余 <b>{pegsLeft}</b> 子
      </span>
      {thinking && <span className="chip thinking">AI 思考中…</span>}
    </div>
  );
}
