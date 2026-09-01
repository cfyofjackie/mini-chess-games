// 新手学堂运行器 UI（docs/games/chess.md 第十一节第一步）：关卡选择列表 → 进入关卡 →
// 逐阶段（说明文案 + 棋盘交互 + 目标判定）→ 完成语 → 下一阶段 / 下一关。
// 逻辑全部在纯 reducer ui/lessons/state.ts（可单测）；本组件只做渲染与副作用：
// 进度 localStorage 持久化（chess-lessons- 前缀，loadCompleted/saveCompleted）+ toast 2.6s 自清。
// 棋盘复用 Board 渲染（合法落点 / 最后一手高亮 / 棋子上色全部沿用）；
// 升变浮层复用对局的 overlay/modal 模式；走错不惩罚：toast 提示 + 悔棋 / 重玩本阶段。
import { useEffect, useReducer } from 'react';
import Board, { sideName } from '../Board';
import type { Promotion } from '../../engine/chess';
import { LESSONS } from './lessons';
import { loadCompleted, saveCompleted } from './progress';
import { createLessonsState, getLesson, getStage, lessonsReducer } from './state';

/** 提示浮条自动消失时长（毫秒，同对局 / reversi / gomoku 模式） */
const TOAST_MS = 2600;

/** 升变选项（与对局浮层一致：后/车/象/马；两色均实心字形，白/黑观感由 .c-pc 上色区分） */
const PROMOTION_CHOICES: ReadonlyArray<{ piece: Promotion; glyph: string; name: string }> = [
  { piece: 'q', glyph: '♛', name: '后' },
  { piece: 'r', glyph: '♜', name: '车' },
  { piece: 'b', glyph: '♝', name: '象' },
  { piece: 'n', glyph: '♞', name: '马' },
];

export default function Runner({ onBack }: { onBack: () => void }) {
  const [state, dispatch] = useReducer(lessonsReducer, undefined, () =>
    createLessonsState(loadCompleted()),
  );

  // 进度持久化：completed 变化即写回 localStorage（reducer 保持纯函数）
  useEffect(() => {
    saveCompleted(state.completed);
  }, [state.completed]);

  // 提示浮条 2.6s 自动消失（每次新提示重置计时）
  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: 'clearToast' }), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [state.toast]);

  if (state.view === 'menu') {
    const doneCount = LESSONS.filter((l) => state.completed.includes(l.id)).length;
    return (
      <section className="c-ls">
        <div className="c-ls-top">
          <button className="btn" onClick={onBack}>
            ← 返回对局
          </button>
          <h2 className="c-ls-title">新手学堂</h2>
          <span className="chip">
            <b>
              {doneCount}/{LESSONS.length}
            </b>{' '}
            已通关
          </span>
        </div>
        <p className="c-ls-lead">
          零基础闯关：每关一个知识点，必须亲手完成任务才能过关。棋子双方都由你操纵（轮到谁就走谁），
          通关进度自动保存在本地。
        </p>
        <div className="c-ls-grid">
          {LESSONS.map((lesson, i) => {
            const done = state.completed.includes(lesson.id);
            return (
              <button
                key={lesson.id}
                className={`c-ls-card${done ? ' done' : ''}`}
                onClick={() => dispatch({ type: 'openLesson', id: lesson.id })}
              >
                <span className={`c-ls-no${done ? ' ok' : ''}`} aria-hidden="true">
                  {done ? '✓' : i + 1}
                </span>
                <span className="c-ls-name">{lesson.title}</span>
                <span className="c-ls-desc">{lesson.intro}</span>
                <span className="c-ls-meta">
                  {lesson.stages.length} 个任务{done ? ' · 已通关' : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  const lesson = getLesson(state.lessonId);
  const stage = getStage(lesson, state.stageIdx);
  if (!lesson || !stage) return null; // 防御：id/下标损坏时渲染空

  const lastStage = state.stageIdx + 1 >= lesson.stages.length;

  return (
    <section className="c-ls">
      <div className="c-ls-top">
        <button className="btn" onClick={() => dispatch({ type: 'backToMenu' })}>
          ← 关卡列表
        </button>
        <h2 className="c-ls-title">{lesson.title}</h2>
        <span className="chip">
          阶段 <b>{state.stageIdx + 1}</b> / {lesson.stages.length}
        </span>
      </div>

      <div className="c-ls-panel">
        <p className="c-ls-brief">{stage.brief}</p>
        {!state.done && <p className="c-ls-task">🎯 {stage.goal.describe}</p>}
      </div>

      <Board
        state={state.game}
        selected={state.selected}
        onTap={(idx) => dispatch({ type: 'tap', idx })}
      />

      {state.done ? (
        <div className="c-ls-done" role="status">
          <p className="c-ls-done-text">✅ {stage.complete}</p>
          <div className="c-ls-done-actions">
            <button className="btn" onClick={() => dispatch({ type: 'restartStage' })}>
              重玩本阶段
            </button>
            {lastStage ? (
              <button className="btn primary" onClick={() => dispatch({ type: 'completeLesson' })}>
                完成关卡 🎉
              </button>
            ) : (
              <button className="btn primary" onClick={() => dispatch({ type: 'nextStage' })}>
                下一阶段 →
              </button>
            )}
          </div>
        </div>
      ) : state.game.status !== 'playing' ? (
        <div className="c-ls-done warn" role="status">
          <p className="c-ls-done-text">
            🤝 和棋（{state.game.reason === 'stalemate' ? '逼和：对方无子可动且未被将军' : '子力不足'}
            ）——本阶段还没完成，重来一次吧
          </p>
          <div className="c-ls-done-actions">
            <button className="btn primary" onClick={() => dispatch({ type: 'restartStage' })}>
              重玩本阶段
            </button>
          </div>
        </div>
      ) : (
        <div className="toolbar">
          <button
            className="btn"
            onClick={() => dispatch({ type: 'undoMove' })}
            disabled={state.moves.length === 0}
          >
            悔棋一步
          </button>
          <button className="btn" onClick={() => dispatch({ type: 'restartStage' })}>
            重玩本阶段
          </button>
        </div>
      )}

      <p className="c-ls-hint">
        走错了不扣分：悔棋一步回到正轨，或重玩本阶段；随时可返回关卡列表换一关。
      </p>

      {state.toast && <div className="toast">{state.toast}</div>}

      {state.pending && (
        <div className="overlay">
          <div className="modal c-promo" role="dialog" aria-modal="true" aria-label="选择升变棋子">
            <div className="emoji" aria-hidden="true">
              ♛
            </div>
            <div className="grade">兵升变</div>
            <p className="detail">{sideName(state.game.current)} 的兵抵达底线，请选择升变棋子</p>
            <div className="c-promo-choices">
              {PROMOTION_CHOICES.map((choice) => (
                <button
                  key={choice.piece}
                  className="btn c-promo-btn"
                  onClick={() => dispatch({ type: 'promote', piece: choice.piece })}
                >
                  <span
                    className={`c-pc ${state.game.current === 1 ? 'white' : 'black'}`}
                    aria-hidden="true"
                  >
                    {choice.glyph}
                  </span>
                  {choice.name}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => dispatch({ type: 'cancelPromotion' })}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
