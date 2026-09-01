// 新手学堂运行器状态机与进度存取测试：
// - reducer（纯状态机）：关卡选择 / 逐阶段推进 / 完成关卡进度、完成态锁盘、
//   选子-落子交互、悔棋、重玩本阶段、升变浮层挂起与取消、走错 toast（序列不合 / 逼和提醒）；
// - 进度（ui/lessons/progress.ts）：parseCompleted / markCompleted 纯函数 + localStorage 往返
//   （vi.stubGlobal 注入 mock 存储，node 环境可测）与隐私模式静默。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { W_QUEEN, fromAlgebraic } from '../../engine/chess';
import { loadCompleted, markCompleted, parseCompleted, saveCompleted } from './progress';
import { createLessonsState, lessonsReducer } from './state';

const sq = fromAlgebraic;

/** 模拟 localStorage（Map 存储，接口与浏览器一致） */
function fakeStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('关卡选择与阶段推进', () => {
  it('初始状态：menu 视图、无选中、进度为传入值', () => {
    const s = createLessonsState(['castling']);
    expect(s.view).toBe('menu');
    expect(s.lessonId).toBeNull();
    expect(s.completed).toEqual(['castling']);
  });

  it('openLesson 载入第 1 关第 1 阶段（b1 白马、白先行）；未知 id 原样忽略', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    expect(s.view).toBe('lesson');
    expect(s.lessonId).toBe('board-pieces');
    expect(s.stageIdx).toBe(0);
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[sq('b1')]).toBe(2); // W_KNIGHT
    expect(s.game.current).toBe(1);
    const same = lessonsReducer(s, { type: 'openLesson', id: 'no-such-lesson' });
    expect(same).toBe(s);
  });

  it('tap 选子 → 落子 → 达成目标（L1S1 走到 c3）→ 完成态锁盘', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b1') });
    expect(s.selected).toBe(sq('b1'));
    s = lessonsReducer(s, { type: 'tap', idx: sq('c3') });
    expect(s.moves).toEqual([{ from: sq('b1'), to: sq('c3') }]);
    expect(s.states).toHaveLength(1);
    expect(s.done).toBe(true);
    expect(s.selected).toBe(-1);
    // 完成态锁盘：点击被忽略
    const locked = lessonsReducer(s, { type: 'tap', idx: sq('d1') });
    expect(locked).toBe(s);
  });

  it('nextStage 进入下一阶段（全新局面）；最后一阶段后完成关卡并记录进度', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('c3') });
    s = lessonsReducer(s, { type: 'nextStage' });
    expect(s.stageIdx).toBe(1);
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[sq('d1')]).toBe(5); // W_QUEEN（阶段 2 初始局面）

    // 未完成时 completeLesson / nextStage 防御拒绝
    const guarded = lessonsReducer(s, { type: 'completeLesson' });
    expect(guarded).toBe(s);

    // 完成第 2 阶段（后 d1→h5）→ 完成关卡 → 回菜单 + 进度记录
    s = lessonsReducer(s, { type: 'tap', idx: sq('d1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('h5') });
    expect(s.done).toBe(true);
    s = lessonsReducer(s, { type: 'nextStage' });
    expect(s.view).toBe('menu');
    expect(s.completed).toEqual(['board-pieces']);

    // 重复完成不重复记录（经 completeLesson 动作）
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('c3') });
    s = lessonsReducer(s, { type: 'nextStage' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('d1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('h5') });
    s = lessonsReducer(s, { type: 'completeLesson' });
    expect(s.view).toBe('menu');
    expect(s.completed).toEqual(['board-pieces']);
  });

  it('backToMenu 回关卡列表并保留进度', () => {
    let s = createLessonsState(['mixed-quiz']);
    s = lessonsReducer(s, { type: 'openLesson', id: 'castling' });
    s = lessonsReducer(s, { type: 'backToMenu' });
    expect(s.view).toBe('menu');
    expect(s.lessonId).toBeNull();
    expect(s.completed).toEqual(['mixed-quiz']);
  });
});

describe('走错不惩罚：toast 提示 + 悔棋 / 重玩本阶段', () => {
  it('选对方棋子 → 轮次提示；序列类目标走偏 → toast 提示，悔棋回到正轨', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'pawn-moves' }); // 阶段 1 = 序列 e3→e4
    // 点对方棋子：轮次提示 + 不选中
    s = lessonsReducer(s, { type: 'tap', idx: sq('e8') });
    expect(s.selected).toBe(-1);
    expect(s.toast).toContain('白方');
    // 走王（合法但不在提示剧本里）→ toast 提示，可悔棋
    s = lessonsReducer(s, { type: 'tap', idx: sq('e1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('d2') });
    expect(s.moves).toHaveLength(1);
    expect(s.done).toBe(false);
    expect(s.toast).toContain('提示');
    // 悔棋一步：快照回退、着法清空、toast 清除
    s = lessonsReducer(s, { type: 'undoMove' });
    expect(s.moves).toHaveLength(0);
    expect(s.toast).toBeNull();
    expect(s.game.board[sq('e1')]).toBe(6); // W_KING 回到 e1
    expect(s.game.current).toBe(1);
  });

  it('走错后局面保持可继续（L1S1 配黑兵垫底，避免子力不足判和打断练习）', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('a3') }); // 马跳去了别处
    expect(s.done).toBe(false);
    expect(s.game.status).toBe('playing'); // 可继续尝试或悔棋，而不是被判和
  });

  it('悔棋无着法可退时原样返回；空手数时悔棋按钮可安全触发', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'board-pieces' });
    const same = lessonsReducer(s, { type: 'undoMove' });
    expect(same).toBe(s);
  });

  it('阶段推进 + 将死达成 + 逼和提醒（toast）+ 重玩本阶段', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'checkmate-basics' });
    // 阶段 1：一手杀（Rh8#）→ 下一阶段
    s = lessonsReducer(s, { type: 'tap', idx: sq('h1') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('h8') });
    expect(s.done).toBe(true);
    s = lessonsReducer(s, { type: 'nextStage' });
    expect(s.stageIdx).toBe(1);
    expect(s.moves).toHaveLength(0);
    expect(s.game.board[sq('f6')]).toBe(6); // W_KING（阶段 2 初始局面）
    // 三步将死照提示走（黑方也由学员操纵）：Kg6 / Kg8 / Ra8#
    s = lessonsReducer(s, { type: 'tap', idx: sq('f6') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('g6') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('h8') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('g8') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('a7') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('a8') });
    expect(s.done).toBe(true);
    expect(s.game.reason).toBe('checkmate');
    // 重玩本阶段 → 走逼和支线：车直接贴 g7（受王保护、不给将）→ 黑王无子可动
    s = lessonsReducer(s, { type: 'restartStage' });
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    s = lessonsReducer(s, { type: 'tap', idx: sq('a7') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('g7') });
    expect(s.game.status).toBe('draw');
    expect(s.game.reason).toBe('stalemate');
    expect(s.done).toBe(false);
    expect(s.toast).toContain('逼和');
    // 逼和终局点棋盘：清提示不报错；重玩回到初始局面
    s = lessonsReducer(s, { type: 'tap', idx: sq('e4') });
    expect(s.toast).toBeNull();
    s = lessonsReducer(s, { type: 'restartStage' });
    expect(s.game.status).toBe('playing');
    expect(s.moves).toHaveLength(0);
  });
});

describe('升变浮层交互（L3）', () => {
  it('点到升变落点先挂起 pending，取消回到选子前；选择后落子并达成目标', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'pawn-promotion' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b7') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b8') });
    expect(s.pending).toEqual({ from: sq('b7'), to: sq('b8') });
    expect(s.game.history).toHaveLength(0); // 尚未落子
    // 取消：回到选子前状态，可改走别的步
    s = lessonsReducer(s, { type: 'cancelPromotion' });
    expect(s.pending).toBeNull();
    expect(s.selected).toBe(-1);
    // 重新走并选择升变子（后）
    s = lessonsReducer(s, { type: 'tap', idx: sq('b7') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b8') });
    s = lessonsReducer(s, { type: 'promote', piece: 'q' });
    expect(s.pending).toBeNull();
    expect(s.done).toBe(true);
    expect(s.game.board[sq('b8')]).toBe(W_QUEEN);
    expect(s.moves[0]).toEqual({ from: sq('b7'), to: sq('b8'), promotion: 'q' });
  });

  it('升变浮层期锁盘：tap 被忽略', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'pawn-promotion' });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b7') });
    s = lessonsReducer(s, { type: 'tap', idx: sq('b8') });
    const locked = lessonsReducer(s, { type: 'tap', idx: sq('f1') });
    expect(locked).toBe(s);
  });
});

describe('进度存取（localStorage mock）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parseCompleted：null / 空 / 损坏 JSON / 非数组 / 混入非字符串 → 过滤或空列表', () => {
    expect(parseCompleted(null)).toEqual([]);
    expect(parseCompleted('')).toEqual([]);
    expect(parseCompleted('not-json{')).toEqual([]);
    expect(parseCompleted('{"a":1}')).toEqual([]);
    expect(parseCompleted('["board-pieces","castling",3,{}]')).toEqual([
      'board-pieces',
      'castling',
    ]);
  });

  it('markCompleted：去重、保序、纯函数（不改入参）', () => {
    const base = ['a'];
    expect(markCompleted(base, 'b')).toEqual(['a', 'b']);
    expect(base).toEqual(['a']); // 入参未被修改
    expect(markCompleted(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(markCompleted([], 'castling')).toEqual(['castling']);
  });

  it('saveCompleted → loadCompleted 往返一致（可覆盖更新）', () => {
    vi.stubGlobal('localStorage', fakeStore());
    saveCompleted(['board-pieces', 'castling']);
    expect(loadCompleted()).toEqual(['board-pieces', 'castling']);
    saveCompleted(['board-pieces']);
    expect(loadCompleted()).toEqual(['board-pieces']);
  });

  it('localStorage 不可用（隐私模式）时读写均静默不抛错', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => saveCompleted(['a'])).not.toThrow();
    expect(loadCompleted()).toEqual([]);
  });
});
