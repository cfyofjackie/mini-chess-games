// 围棋学堂运行器 UI（docs/games/chess.md 第十三节）：关卡选择列表 → 进入关卡 →
// 逐阶段（说明文案 + 棋盘交互 + 目标判定）→ 完成语 → 下一阶段 / 下一关。
// 与国象学堂同一交互形态（对局页 🎓 学堂入口 → 卡片列表 → 闯关），逻辑全部在纯 reducer
// ui/lessons/state.ts（可单测）；本组件只做渲染与副作用：进度 localStorage 持久化
//（go-lessons-completed，与国象互不影响）。棋盘复用围棋 Board 渲染（合法落点 /
// 最后一手 / 劫禁点全部沿用）；黑白双方都由学员操纵（轮到谁就落谁）；走错不惩罚：
// 悔棋 / 重玩本阶段随时可用。
import { useEffect, useMemo, useReducer } from 'react';
import Board from '../Board';
import { legalMoves } from '../../engine/go';
import { LESSONS } from './lessons';
import { loadCompleted, saveCompleted } from './progress';
import { createLessonsState, getLesson, getStage, lessonsReducer } from './state';

/** 学堂标题与导航措辞（与对局页 header 风格一致） */
const TITLE = '围棋学堂';

export default function Runner({ onBack }: { onBack: () => void }) {
  const [state, dispatch] = useReducer(lessonsReducer, undefined, () =>
    createLessonsState(loadCompleted()),
  );

  // 进度持久化：completed 变化即写回 localStorage（reducer 保持纯函数）
  useEffect(() => {
    saveCompleted(state.completed);
  }, [state.completed]);

  // 完成态 / 菜单不开放任何落点（Board 只有 legal 集合内的空点可点）
  const legal = useMemo(
    () => new Set(state.view === 'lesson' && !state.done ? legalMoves(state.game) : []),
    [state],
  );

  if (state.view === 'menu') {
    const doneCount = LESSONS.filter((l) => state.completed.includes(l.id)).length;
    return (
      <section className="g-ls">
        <div className="g-ls-top">
          <button className="btn" onClick={onBack}>
            ← 返回对局
          </button>
          <h2 className="g-ls-title">{TITLE}</h2>
          <span className="chip">
            <b>
              {doneCount}/{LESSONS.length}
            </b>{' '}
            已通关
          </span>
        </div>
        <p className="g-ls-lead">
          零基础闯关：从提子一路学到两眼做活。黑白双方都由你操纵（轮到谁就落谁），
          必须亲手完成任务才能过关，通关进度自动保存在本地。
        </p>
        <div className="g-ls-grid">
          {LESSONS.map((lesson, i) => {
            const done = state.completed.includes(lesson.id);
            return (
              <button
                key={lesson.id}
                className={`g-ls-card${done ? ' done' : ''}`}
                onClick={() => dispatch({ type: 'openLesson', id: lesson.id })}
              >
                <span className={`g-ls-no${done ? ' ok' : ''}`} aria-hidden="true">
                  {done ? '✓' : i + 1}
                </span>
                <span className="g-ls-name">{lesson.title}</span>
                <span className="g-ls-desc">{lesson.intro}</span>
                <span className="g-ls-meta">
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
  const turnName = state.game.current === 1 ? '黑方' : '白方';

  return (
    <section className="g-ls">
      <div className="g-ls-top">
        <button className="btn" onClick={() => dispatch({ type: 'backToMenu' })}>
          ← 关卡列表
        </button>
        <h2 className="g-ls-title">{lesson.title}</h2>
        <span className="chip">
          阶段 <b>{state.stageIdx + 1}</b> / {lesson.stages.length}
        </span>
        {!state.done && (
          <span className="chip">
            轮到 <b>{turnName}</b>
          </span>
        )}
      </div>

      <div className="g-ls-panel">
        <p className="g-ls-brief">{stage.brief}</p>
        {!state.done && <p className="g-ls-task">🎯 {stage.goal.describe}</p>}
      </div>

      <Board
        state={state.game}
        legal={legal}
        onPick={(idx) => dispatch({ type: 'tap', idx })}
      />

      {state.done ? (
        <div className="g-ls-done" role="status">
          <p className="g-ls-done-text">✅ {stage.complete}</p>
          <div className="g-ls-done-actions">
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

      <p className="g-ls-hint">
        走错了不扣分：悔棋一手回到正轨，或重玩本阶段；随时可返回关卡列表换一关。
      </p>
    </section>
  );
}
