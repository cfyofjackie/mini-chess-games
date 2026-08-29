import { Grade } from '../engine/score';

interface ResultModalProps {
  grade: Grade;
  pegsLeft: number;
  moves: number;
  canUndo: boolean;
  onUndo: () => void;
  onRestart: () => void;
}

export default function ResultModal({
  grade,
  pegsLeft,
  moves,
  canUndo,
  onUndo,
  onRestart,
}: ResultModalProps) {
  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label="本局结果">
        <div className="emoji">{grade.perfect ? '🎉' : pegsLeft === 1 ? '🏆' : '🤔'}</div>
        <div className="grade">{grade.label}</div>
        <p className="detail">
          剩余 <b>{pegsLeft}</b> 颗棋子 · 共 <b>{moves}</b> 步
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onUndo} disabled={!canUndo}>
            悔棋一步
          </button>
          <button className="btn primary" onClick={onRestart}>
            再来一局
          </button>
        </div>
      </div>
    </div>
  );
}
