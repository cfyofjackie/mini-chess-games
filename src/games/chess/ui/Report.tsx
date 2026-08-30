// 复盘报告页（docs/games/chess.md 第八节）：对局页内切换的第二个视图。
// - 分析中：进度条（x/N，Worker 逐局面回报），期间不渲染报告内容；
// - 报告：评估曲线（内联 SVG 折线，白方视角，将死钳制到两端）+ 着法时间线
//   （按 🟢 最佳 / ⚪ 好棋 / 🟡 失误 / 🔴 大错 评级着色，点击任一手跳转该局面）
//   + 棋盘（复用 Board 渲染选中局面，最后一手自动高亮）+ 该手详情（评级/原因/引擎首选/评估变化）
//   + 本地历史复盘列表（localStorage 最近 10 局，可重看）。
import { useEffect, useState } from 'react';
import Board from './Board';
import { moveText } from './moveText';
import type { SavedReview } from './reviewStore';
import { MATE_SCORE, MATE_WIN } from '../engine/ai';
import type { AnalysisReport, Grade } from '../engine/analysis';
import { B_PAWN, W_PAWN, type ChessState, type Promotion } from '../engine/chess';

/** 评级 → 圆点 emoji（规格书用色）与中文名 */
const GRADE_DOT: Record<Grade, string> = {
  best: '🟢',
  good: '⚪',
  mistake: '🟡',
  blunder: '🔴',
};
const GRADE_LABEL: Record<Grade, string> = {
  best: '最佳',
  good: '好棋',
  mistake: '失误',
  blunder: '大错',
};

/** 评估分（白方视角厘兵）→ 文案：将死显示剩余步数，其余显示 +x.xx */
function evalText(cp: number): string {
  if (cp >= MATE_WIN) return `白方 ${Math.max(1, Math.ceil((MATE_SCORE - cp) / 2))} 步将杀`;
  if (cp <= -MATE_WIN) return `黑方 ${Math.max(1, Math.ceil((MATE_SCORE + cp) / 2))} 步将杀`;
  const v = cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** 引擎首选着法 → 中文文案（-piece 从走子前局面反查，吃子含吃过路兵） */
function bestMoveText(state: ChessState, best: { from: number; to: number; promotion?: Promotion }): string {
  const piece = state.board[best.from];
  if (piece === 0) return '—';
  const ep =
    (piece === W_PAWN || piece === B_PAWN) &&
    best.to === state.enPassant &&
    best.from % 8 !== best.to % 8;
  return moveText(
    {
      from: best.from,
      to: best.to,
      piece,
      capture: state.board[best.to] !== 0 || ep,
      promotion: best.promotion,
    },
    state.current,
  );
}

/** 评估曲线：x = 手数均分，y = 白方优势（logistic，0..100），将死钳制到 ±2000 厘兵 */
function EvalCurve({
  curve,
  grades,
  sel,
  onPick,
}: {
  curve: number[];
  grades: Array<Grade | null>;
  sel: number;
  onPick: (i: number) => void;
}) {
  const W = 320;
  const H = 100;
  const PAD = 8;
  const n = curve.length;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));
  const y = (cp: number) => {
    const clamped =
      cp >= MATE_WIN ? 2000 : cp <= -MATE_WIN ? -2000 : Math.max(-2000, Math.min(2000, cp));
    const ratio = 100 / (1 + Math.exp(-clamped / 400)); // 0..100，50 = 均势
    return PAD + (1 - ratio / 100) * (H - PAD * 2);
  };
  const line = curve.map((cp, i) => `${x(i).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
  return (
    <svg
      className="c-rv-curve"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="白方视角评估曲线"
    >
      <rect x={0} y={0} width={W} height={H / 2} className="c-rv-curve-white" />
      <rect x={0} y={H / 2} width={W} height={H / 2} className="c-rv-curve-black" />
      <line x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} className="c-rv-curve-mid" />
      <polyline points={line} className="c-rv-curve-line" />
      {sel > 0 && sel < n && (
        <line x1={x(sel)} x2={x(sel)} y1={PAD} y2={H - PAD} className="c-rv-cursor" />
      )}
      {curve.map((cp, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(cp)}
          r={3.2}
          className={`c-rv-pt${grades[i] ? ` g-${grades[i]}` : ''}${sel === i ? ' sel' : ''}`}
          onClick={() => onPick(i)}
        >
          <title>{`第 ${i} 手后 · ${evalText(cp)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export interface ReportProps {
  /** 完整报告；null = 分析进行中（显示进度条） */
  report: AnalysisReport | null;
  /** 分析进度（done / total，total = 手数 + 1） */
  progress: { done: number; total: number } | null;
  /** 局面序列（长度 = 手数 + 1）：positions[i] 为第 i 手走完的局面 */
  positions: ChessState[];
  saved: SavedReview[];
  onBack: () => void;
  onLoadSaved: (id: string) => void;
}

export default function Report({ report, progress, positions, saved, onBack, onLoadSaved }: ReportProps) {
  const [sel, setSel] = useState(0);
  // 新报告载入（新分析完成 / 重看历史）时定位到最后一手（复盘通常最关心终局）
  useEffect(() => {
    setSel(Math.max(0, positions.length - 1));
  }, [report, positions]);

  // 防御：局面序列与报告手数不一致（存储损坏）时夹紧选中下标
  const selIdx = positions.length > 0 ? Math.min(sel, positions.length - 1) : 0;
  const selState = positions[selIdx];

  if (!report) {
    const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
    return (
      <section className="c-rv">
        <div className="c-rv-top">
          <button className="btn" onClick={onBack}>
            ← 返回对局
          </button>
          <h2 className="c-rv-title">复盘报告</h2>
        </div>
        <div className="c-rv-card c-rv-analyzing">
          <div
            className="c-rv-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress?.total ?? 0}
            aria-valuenow={progress?.done ?? 0}
          >
            <div className="c-rv-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="c-rv-progtext">
            正在逐局面分析 {progress ? `${progress.done} / ${progress.total}` : '…'}（{pct}%），
            全程在本地完成，约需几秒
          </p>
        </div>
      </section>
    );
  }

  const grades: Array<Grade | null> = report.curve.map((_, i) =>
    i === 0 ? null : report.moves[i - 1]?.grade ?? null,
  );
  const selMove = selIdx >= 1 ? report.moves[selIdx - 1] : null;
  const prevState = selIdx >= 1 ? positions[selIdx - 1] : null;

  return (
    <section className="c-rv">
      <div className="c-rv-top">
        <button className="btn" onClick={onBack}>
          ← 返回对局
        </button>
        <h2 className="c-rv-title">复盘报告</h2>
        <span className="chip">共 <b>{report.moves.length}</b> 手</span>
        <span className="chip">
          白方 {GRADE_DOT.best}{report.white.best} {GRADE_DOT.good}{report.white.good}{' '}
          {GRADE_DOT.mistake}{report.white.mistake} {GRADE_DOT.blunder}{report.white.blunder}
        </span>
        <span className="chip">
          黑方 {GRADE_DOT.best}{report.black.best} {GRADE_DOT.good}{report.black.good}{' '}
          {GRADE_DOT.mistake}{report.black.mistake} {GRADE_DOT.blunder}{report.black.blunder}
        </span>
      </div>

      <div className="c-rv-card">
        <p className="c-rv-cardtitle">评估曲线（白方视角，越上白优 / 越下黑优）</p>
        <EvalCurve
          curve={report.curve}
          grades={grades}
          sel={selIdx}
          onPick={(i) => setSel(i)}
        />
      </div>

      <div className="c-rv-grid">
        <div className="c-rv-left">
          {selState && <Board state={selState} selected={-1} onTap={() => undefined} />}
          <div className="c-rv-card c-rv-detail">
            {selIdx === 0 || !selMove || !prevState ? (
              <>
                <div className="c-rv-dhead">
                  <span className="c-rv-dtitle">初始局面</span>
                  <span className="chip">评估 {evalText(report.curve[0])}</span>
                </div>
                <p className="c-rv-why">点击右侧任一着法查看该手评级与原因</p>
              </>
            ) : (
              <>
                <div className="c-rv-dhead">
                  <span className="c-rv-dtitle">
                    第 {Math.ceil(selMove.ply / 2)} 手 · {selMove.side === 1 ? '白' : '黑'}方{' '}
                    <b>{moveText(selMove, selMove.side)}</b>
                  </span>
                  <span className={`c-rv-grade g-${selMove.grade}`}>
                    {GRADE_DOT[selMove.grade]} {GRADE_LABEL[selMove.grade]}
                  </span>
                </div>
                <p className="c-rv-why">{selMove.reason}</p>
                <p className="c-rv-meta">
                  引擎首选：{selMove.best ? bestMoveText(prevState, selMove.best) : '—（终局）'}
                  <span className="c-rv-sep">·</span>
                  评估 {evalText(report.curve[selMove.ply - 1])} → {evalText(report.curve[selMove.ply])}
                  {selMove.loss > 0 && (
                    <>
                      <span className="c-rv-sep">·</span>损失约 {(selMove.loss / 100).toFixed(1)} 兵
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </div>

        <ol className="c-rv-card c-rv-list" aria-label="着法时间线">
          <li
            className={`c-rv-row${selIdx === 0 ? ' sel' : ''}`}
            onClick={() => setSel(0)}
          >
            <span className="c-rv-no">开局</span>
            <span className="c-rv-mv">初始局面</span>
            <span className="c-rv-dot" aria-hidden="true" />
            <span className="c-rv-why">评估 {evalText(report.curve[0])}</span>
          </li>
          {report.moves.map((am) => (
            <li
              key={am.ply}
              className={`c-rv-row g-${am.grade}${selIdx === am.ply ? ' sel' : ''}`}
              onClick={() => setSel(am.ply)}
            >
              <span className="c-rv-no">
                {Math.ceil(am.ply / 2)}
                {am.side === 1 ? '.' : '…'}
              </span>
              <span className="c-rv-mv">{moveText(am, am.side)}</span>
              <span className="c-rv-dot" aria-hidden="true">
                {GRADE_DOT[am.grade]}
              </span>
              <span className="c-rv-why">{am.reason}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="c-rv-card c-rv-saved">
        <p className="c-rv-cardtitle">历史复盘（保留最近 10 局）</p>
        {saved.length === 0 ? (
          <p className="c-rv-why">暂无保存的复盘，完成一次分析后自动保存</p>
        ) : (
          <ul>
            {saved.map((s) => (
              <li key={s.id}>
                <span className="c-rv-slabel">{s.label}</span>
                <button className="btn" onClick={() => onLoadSaved(s.id)}>
                  重看
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
