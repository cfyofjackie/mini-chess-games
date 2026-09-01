// 围棋学堂运行器状态机与进度存取测试：
// - reducer（纯状态机）：关卡选择 / 逐阶段推进 / 完成关卡进度、完成态锁盘、
//   非法落点防御（占子）、悔棋（复用引擎快照）、重玩本阶段；
// - 进度（ui/lessons/progress.ts）：parseCompleted / markCompleted 纯函数 + localStorage 往返
//   （vi.stubGlobal 注入 mock 存储，node 环境可测）、独立 key go-lessons-completed、隐私模式静默。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pt } from './goals';
import { loadCompleted, markCompleted, parseCompleted, saveCompleted } from './progress';
import { createLessonsState, lessonsReducer } from './state';

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
  it('初始状态：menu 视图、进度为传入值', () => {
    const s = createLessonsState(['two-eyes']);
    expect(s.view).toBe('menu');
    expect(s.lessonId).toBeNull();
    expect(s.completed).toEqual(['two-eyes']);
  });

  it('openLesson 载入第 1 关第 1 阶段（E5 白子、黑先）；未知 id 原样忽略', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'capture-stones' });
    expect(s.view).toBe('lesson');
    expect(s.lessonId).toBe('capture-stones');
    expect(s.stageIdx).toBe(0);
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[pt('E5')]).toBe(2); // E5 白子（阶段初始局面）
    expect(s.game.current).toBe(1);
    const same = lessonsReducer(s, { type: 'openLesson', id: 'no-such-lesson' });
    expect(same).toBe(s);
  });

  it('tap 合法点落子 → 达成目标（L1S1 落 F5 提子）→ 完成态锁盘；占子等非法点被防御拒绝', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'capture-stones' });
    // 占子点（E5 白子）与劫外非法点：isLegal 过滤，原样返回
    const occupied = lessonsReducer(s, { type: 'tap', idx: pt('E5') });
    expect(occupied).toBe(s);
    // 落 F5 → 提掉 E5 白子 → 目标达成
    s = lessonsReducer(s, { type: 'tap', idx: pt('F5') });
    expect(s.moves).toEqual([pt('F5')]);
    expect(s.states).toHaveLength(1);
    expect(s.done).toBe(true);
    expect(s.game.board[pt('E5')]).toBe(0); // 白子被提
    // 完成态锁盘：再点被忽略
    const locked = lessonsReducer(s, { type: 'tap', idx: pt('A1') });
    expect(locked).toBe(s);
  });

  it('合法但未达成的着法照常落子（走错不惩罚），可悔棋回到正轨', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'escape' });
    s = lessonsReducer(s, { type: 'tap', idx: pt('A1') }); // 没去延气
    expect(s.done).toBe(false);
    expect(s.moves).toHaveLength(1);
    expect(s.game.status).toBe('playing'); // 可继续尝试或悔棋
    s = lessonsReducer(s, { type: 'undoMove' });
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[pt('A1')]).toBe(0); // A1 恢复为空
    expect(s.game.board[pt('E5')]).toBe(1); // 阶段初始局面还原
    // 无着法可退时悔棋原样返回
    const same = lessonsReducer(s, { type: 'undoMove' });
    expect(same).toBe(s);
  });

  it('nextStage 进入下一阶段（全新局面）；最后一阶段后完成关卡并记录进度', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'capture-stones' });
    s = lessonsReducer(s, { type: 'tap', idx: pt('F5') });
    expect(s.done).toBe(true);
    s = lessonsReducer(s, { type: 'nextStage' });
    expect(s.stageIdx).toBe(1);
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[pt('F5')]).toBe(2); // 阶段 2 初始局面（F5 换成了白子）

    // 未完成时 completeLesson / nextStage 防御拒绝
    const guarded = lessonsReducer(s, { type: 'completeLesson' });
    expect(guarded).toBe(s);

    // 完成第 2 阶段（G5 整群提两子）→ 完成关卡 → 回菜单 + 进度记录
    s = lessonsReducer(s, { type: 'tap', idx: pt('G5') });
    expect(s.done).toBe(true);
    s = lessonsReducer(s, { type: 'nextStage' });
    expect(s.view).toBe('menu');
    expect(s.completed).toEqual(['capture-stones']);

    // 重复完成不重复记录（经 completeLesson 动作）
    s = lessonsReducer(s, { type: 'openLesson', id: 'capture-stones' });
    s = lessonsReducer(s, { type: 'tap', idx: pt('F5') });
    s = lessonsReducer(s, { type: 'nextStage' });
    s = lessonsReducer(s, { type: 'tap', idx: pt('G5') });
    s = lessonsReducer(s, { type: 'completeLesson' });
    expect(s.view).toBe('menu');
    expect(s.completed).toEqual(['capture-stones']);
  });

  it('反提关完整流程：白先提两子（未达成）→ 黑反提（达成）→ 完成关卡', () => {
    let s = createLessonsState([]);
    s = lessonsReducer(s, { type: 'openLesson', id: 'counter-capture' });
    expect(s.game.current).toBe(2); // 白先
    s = lessonsReducer(s, { type: 'tap', idx: pt('D5') }); // 白提两颗黑子
    expect(s.done).toBe(false);
    expect(s.game.captures).toEqual([0, 2]);
    s = lessonsReducer(s, { type: 'tap', idx: pt('E5') }); // 黑立即反提（简单劫不拦截）
    expect(s.done).toBe(true);
    expect(s.game.captures).toEqual([1, 2]);
    s = lessonsReducer(s, { type: 'completeLesson' });
    expect(s.completed).toEqual(['counter-capture']);
  });

  it('backToMenu 回关卡列表并保留进度；restartStage 重玩本阶段', () => {
    let s = createLessonsState(['double-atari']);
    s = lessonsReducer(s, { type: 'openLesson', id: 'atari' });
    s = lessonsReducer(s, { type: 'tap', idx: pt('A1') });
    s = lessonsReducer(s, { type: 'restartStage' });
    expect(s.moves).toHaveLength(0);
    expect(s.done).toBe(false);
    expect(s.game.board[pt('E5')]).toBe(2);
    s = lessonsReducer(s, { type: 'backToMenu' });
    expect(s.view).toBe('menu');
    expect(s.lessonId).toBeNull();
    expect(s.completed).toEqual(['double-atari']);
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
    expect(parseCompleted('["capture-stones","atari",3,{}]')).toEqual([
      'capture-stones',
      'atari',
    ]);
  });

  it('markCompleted：去重、保序、纯函数（不改入参）', () => {
    const base = ['a'];
    expect(markCompleted(base, 'b')).toEqual(['a', 'b']);
    expect(base).toEqual(['a']); // 入参未被修改
    expect(markCompleted(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(markCompleted([], 'two-eyes')).toEqual(['two-eyes']);
  });

  it('saveCompleted → loadCompleted 往返一致（可覆盖更新），且写入独立 key go-lessons-completed', () => {
    const store = fakeStore();
    const written: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.getItem(k),
      setItem: (k: string, v: string) => {
        written.push(k);
        store.setItem(k, v);
      },
    });
    saveCompleted(['capture-stones', 'atari']);
    expect(loadCompleted()).toEqual(['capture-stones', 'atari']);
    saveCompleted(['capture-stones']);
    expect(loadCompleted()).toEqual(['capture-stones']);
    // 与国象学堂（chess-lessons-completed）互不影响：写的是 go 专属 key
    expect(written).toEqual(['go-lessons-completed', 'go-lessons-completed']);
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
