// 围棋规则引擎测试（docs/games/go.md 第四节测试清单 1~6）：
// 1 落子合法性与自杀禁着 2 提子（单子/整群/一子双提）3 劫 4 双虚着终局
// 5 数子（含标记死棋）6 悔棋快照一致性。
import { describe, expect, it } from 'vitest';
import {
  CELLS,
  KOMI,
  SIZE,
  type GoState,
  type Player,
  clearDead,
  confirmScoring,
  groupAt,
  initialState,
  isLegal,
  legalMoves,
  pass,
  place,
  toggleDead,
  undo,
} from './go';

const idx = (r: number, c: number) => r * SIZE + c;

/** 按字符画（B 黑 / W 白 / . 空）直接构造任意局面（绕过对局过程，便于规则单测） */
function fromBoard(rows: string[], current: Player = 1): GoState {
  if (rows.length !== SIZE || rows.some((row) => row.length !== SIZE)) throw new Error('bad rows');
  const board = new Int8Array(CELLS);
  rows.forEach((row, r) => {
    for (let c = 0; c < SIZE; c++) {
      const ch = row.charAt(c);
      board[idx(r, c)] = ch === 'B' ? 1 : ch === 'W' ? 2 : 0;
    }
  });
  return {
    board,
    history: [],
    current,
    status: 'playing',
    lastMove: -1,
    koPoint: -1,
    captures: [0, 0],
    passes: 0,
    dead: [],
    result: null,
  };
}

/** 数子测试局面：黑墙占满第 5 列（c=4），白棋填满右侧四列（36 子），白 (2,2) 打入黑方左侧 */
const SCORING_ROWS = [
  '....BWWWW',
  '....BWWWW',
  '..W.BWWWW',
  '....BWWWW',
  '....BWWWW',
  '....BWWWW',
  '....BWWWW',
  '....BWWWW',
  '....BWWWW',
];

describe('go rules 基础与合法性（清单 1）', () => {
  it('初始状态：空盘、黑先、无劫禁、无快照', () => {
    const s = initialState();
    expect(s.current).toBe(1);
    expect(s.status).toBe('playing');
    expect(s.lastMove).toBe(-1);
    expect(s.koPoint).toBe(-1);
    expect(s.captures).toEqual([0, 0]);
    expect(s.history).toHaveLength(0);
    expect(groupAt(s.board, idx(4, 4))).toEqual({ stones: [], liberties: [] });
  });

  it('空点落子合法：黑先白后轮流、记录最后一手与快照', () => {
    let s = initialState();
    const before = s;
    s = place(s, idx(4, 4));
    expect(s).not.toBe(before);
    expect(s.board[idx(4, 4)]).toBe(1);
    expect(s.current).toBe(2);
    expect(s.lastMove).toBe(idx(4, 4));
    expect(s.history).toHaveLength(1);
    s = place(s, idx(3, 3));
    expect(s.current).toBe(1);
    expect(s.history).toHaveLength(2);
  });

  it('拒绝占用已落子的点 / 出界（同引用拒绝）', () => {
    const s = place(initialState(), idx(4, 4));
    expect(place(s, idx(4, 4))).toBe(s);
    expect(place(s, -1)).toBe(s);
    expect(place(s, CELLS)).toBe(s);
  });

  it('气与棋群：flood-fill 计连通与气（角 2 气、边 3 气、竖链共享气）', () => {
    // 群只对棋子有意义：角子 2 气、边子 3 气
    const probe = initialState().board.slice();
    probe[idx(0, 0)] = 1;
    probe[idx(0, 4)] = 1;
    expect(groupAt(probe, idx(0, 0)).liberties).toHaveLength(2);
    expect(groupAt(probe, idx(0, 4)).liberties).toHaveLength(3);
    const empty = initialState().board;
    expect(groupAt(empty, idx(4, 4))).toEqual({ stones: [], liberties: [] });
    // 竖向黑链 (4,4)(5,4) 连成一群，共享外围气（(3,4) 为白）
    let s = place(initialState(), idx(4, 4));
    s = place(s, idx(3, 4));
    s = place(s, idx(5, 4));
    expect([...groupAt(s.board, idx(4, 4)).stones].sort()).toEqual([idx(4, 4), idx(5, 4)].sort());
    expect(groupAt(s.board, idx(4, 4)).liberties).toHaveLength(5);
  });

  it('自杀禁着反例：点自杀（角上最后一口气被围死）', () => {
    // 黑 (0,1)(1,0)，白走 (0,0) 无气且提不动任何黑子 → 禁着
    const s = fromBoard(
      [
        '.B.......',
        'B........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
      ],
      2,
    );
    expect(isLegal(s, idx(0, 0))).toBe(false);
    expect(place(s, idx(0, 0))).toBe(s);
  });

  it('自杀禁着反例：群自杀（落子连入己群后整群仍无气）', () => {
    // 白 (0,1) 仅剩气 (0,0)，黑 (0,2)(1,0)(1,1)；白走 (0,0) 与 (0,1) 连成一群仍无气 → 禁着
    const s = fromBoard(
      [
        '.WB......',
        'BB.......',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
      ],
      2,
    );
    expect(groupAt(s.board, idx(0, 1)).liberties).toEqual([idx(0, 0)]);
    expect(isLegal(s, idx(0, 0))).toBe(false);
    expect(place(s, idx(0, 0))).toBe(s);
  });

  it('提子使"看似自杀"的点变合法（先提后活的正例 / 倒扑形）', () => {
    // 白 (4,4) 仅剩一口气 (4,3)，且 (4,3) 的其余三邻 (3,3)(5,3)(4,2) 皆为白：
    // 黑走 (4,3) 本身四邻全白（若无提子即自杀），但恰提掉 (4,4) 获得气 → 合法
    const s = fromBoard([
      '.........',
      '.........',
      '.........',
      '...WB....',
      '..W.WB...',
      '...WB....',
      '.........',
      '.........',
      '.........',
    ]);
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 3)]);
    const after = place(s, idx(4, 3));
    expect(after).not.toBe(s);
    expect(after.board[idx(4, 4)]).toBe(0);
    expect(after.board[idx(4, 3)]).toBe(1);
    expect(after.captures).toEqual([1, 0]);
    // 提一子后新子单子单气（经典劫形）→ 白不能立即回提 (4,4)
    expect(after.koPoint).toBe(idx(4, 4));
    expect(place(after, idx(4, 4))).toBe(after);
  });
});

describe('go rules 提子（清单 2）', () => {
  it('单子提：提一子、提子数 +1、新子多气非劫形不设劫禁', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....B....',
        '....WB...',
        '....B....',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    // 白 (4,4) 仅剩气 (4,3)，黑走 (4,3) 提一子；新子 (4,3) 另有三邻空点 → 多气，非劫形
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 3)]);
    const after = place(s, idx(4, 3));
    expect(after.board[idx(4, 4)]).toBe(0);
    expect(after.board[idx(4, 3)]).toBe(1);
    expect(after.captures).toEqual([1, 0]);
    expect(after.koPoint).toBe(-1);
    expect(after.current).toBe(2);
  });

  it('整群提：两子棋群最后一口气被整体提取', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....BB...',
        '....WWB..',
        '....BB...',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    // 白群 (4,4)(4,5) 气仅 (4,3)；黑走 (4,3) 提两子
    expect(groupAt(s.board, idx(4, 4)).stones.sort()).toEqual([idx(4, 4), idx(4, 5)].sort());
    expect(groupAt(s.board, idx(4, 4)).liberties).toEqual([idx(4, 3)]);
    const after = place(s, idx(4, 3));
    expect(after.board[idx(4, 4)]).toBe(0);
    expect(after.board[idx(4, 5)]).toBe(0);
    expect(after.captures).toEqual([2, 0]);
    expect(after.koPoint).toBe(-1); // 提两子不成劫
  });

  it('一子双提：一手同时提掉两处各一子', () => {
    // 白 (4,3) 与 (3,4) 各只剩 (4,4) 一口气，黑走 (4,4) 一子双提
    const s = fromBoard(
      [
        '.........',
        '.........',
        '....B....',
        '...BWB...',
        '..BW.....',
        '...B.....',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    expect(groupAt(s.board, idx(4, 3)).liberties).toEqual([idx(4, 4)]);
    expect(groupAt(s.board, idx(3, 4)).liberties).toEqual([idx(4, 4)]);
    const after = place(s, idx(4, 4));
    expect(after.board[idx(4, 3)]).toBe(0);
    expect(after.board[idx(3, 4)]).toBe(0);
    expect(after.captures).toEqual([2, 0]);
    expect(after.koPoint).toBe(-1);
  });
});

describe('go rules 简单劫（清单 3）', () => {
  // 经典劫形（贴边）：白 (0,2) 仅剩气 (0,1)；(0,0)(1,1) 为白、(0,3)(1,2) 为黑
  // —— 黑提 (0,2) 后新子恰为单子单气，构成劫
  const koBoard = () =>
    fromBoard(
      [
        'W.WB.....',
        '.WB......',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );

  it('黑提劫成功后，白立即回提被拒（同引用）', () => {
    let s = koBoard();
    s = place(s, idx(0, 1));
    expect(s.board[idx(0, 2)]).toBe(0); // 白子被提
    expect(s.koPoint).toBe(idx(0, 2)); // 白方下一手禁着点
    expect(s.current).toBe(2);
    expect(isLegal(s, idx(0, 2))).toBe(false);
    expect(place(s, idx(0, 2))).toBe(s); // 立即回提 → 同引用拒绝
  });

  it('隔一手后允许回提，并再次形成劫禁', () => {
    let s = koBoard();
    s = place(s, idx(0, 1)); // 黑提劫，koPoint=(0,2)
    s = place(s, idx(8, 8)); // 白寻劫（他处落子，劫禁解除）
    expect(s.koPoint).toBe(-1);
    s = place(s, idx(8, 7)); // 黑应劫（不提子）
    expect(s.koPoint).toBe(-1);
    const back = place(s, idx(0, 2)); // 白此时回提 → 合法
    expect(back).not.toBe(s);
    expect(back.board[idx(0, 1)]).toBe(0); // 黑 (0,1) 被提
    expect(back.captures).toEqual([1, 1]);
    // 白回提的新子同样单子单气 → 劫禁再度指向 (0,1)，黑不能立即再提
    expect(back.koPoint).toBe(idx(0, 1));
    expect(place(back, idx(0, 1))).toBe(back);
  });
});

describe('go rules 虚着与终局（清单 4）', () => {
  it('单方虚着：换手、清空最后一手、连续虚着计数 +1；落子清零计数', () => {
    let s = place(initialState(), idx(4, 4));
    s = pass(s);
    expect(s.status).toBe('playing');
    expect(s.passes).toBe(1);
    expect(s.current).toBe(1);
    expect(s.lastMove).toBe(-1);
    expect(s.history).toHaveLength(2);
    s = place(s, idx(3, 3));
    expect(s.passes).toBe(0); // 落子打断连续虚着
  });

  it('双方连续虚着 → 进入标记模式（默认全活），终局后落子/虚着均为空操作', () => {
    let s = pass(initialState());
    s = pass(s);
    expect(s.status).toBe('marking');
    expect(s.passes).toBe(2);
    expect(s.dead).toEqual([]);
    expect(pass(s)).toBe(s);
    expect(legalMoves(s)).toEqual([]); // 标记阶段没有"落子"
    expect(place(s, idx(4, 4))).toBe(s);
  });

  it('未进入标记模式时数子被同引用拒绝；终局后重复数子亦然', () => {
    const s = initialState();
    expect(confirmScoring(s)).toBe(s);
    const done = confirmScoring(pass(pass(s)));
    expect(done.status).toBe('done');
    expect(confirmScoring(done)).toBe(done);
  });
});

describe('go rules 数子（清单 5）', () => {
  const scoringBoard = () => fromBoard(SCORING_ROWS);

  it('贴目为 3¾ 子', () => {
    expect(KOMI).toBe(3.75);
  });

  it('不标记（打入子视为活棋）：其周边空域成公气不计，白大胜', () => {
    const marking: GoState = { ...scoringBoard(), status: 'marking' };
    const done = confirmScoring(marking);
    expect(done.status).toBe('done');
    // 黑：9 子 + 0 空（左侧 31 个空点同时邻白 (2,2)，整片为公气）
    // 白：37 子 + 0 空 + 贴 3.75
    expect(done.result).toEqual({ black: 9, white: 40.75, winner: 2 });
  });

  it('标记打入白子为死棋后：该点并入黑空，黑反败为胜', () => {
    let marking: GoState = { ...scoringBoard(), status: 'marking' };
    marking = toggleDead(marking, idx(2, 2));
    expect(marking.dead).toEqual([idx(2, 2)]);
    const done = confirmScoring(marking);
    // 黑：9 子 + 36 空 = 45；白：36 子 + 贴 3.75 = 39.75
    expect(done.result).toEqual({ black: 45, white: 39.75, winner: 1 });
  });

  it('再点一次取消死子标记（整群切换），确认结果回到活棋口径', () => {
    let marking: GoState = { ...scoringBoard(), status: 'marking' };
    marking = toggleDead(marking, idx(2, 2));
    marking = toggleDead(marking, idx(2, 2));
    expect(marking.dead).toEqual([]);
    expect(confirmScoring(marking).result).toEqual({ black: 9, white: 40.75, winner: 2 });
  });

  it('死子标记、清空与非标记阶段的同引用拒绝', () => {
    const s = scoringBoard();
    expect(toggleDead(s, idx(2, 2))).toBe(s); // 对局中不可标记
    expect(clearDead(s)).toBe(s);
    let marking: GoState = { ...s, status: 'marking' };
    expect(toggleDead(marking, idx(0, 0))).toBe(marking); // 空点无可标记
    const marked = toggleDead(marking, idx(2, 2));
    expect(marked.dead).toEqual([idx(2, 2)]);
    expect(clearDead(marked).dead).toEqual([]);
    expect(clearDead(marking)).toBe(marking); // 无标记可清（同引用）
  });
});

describe('go rules 悔棋快照（清单 6）', () => {
  it('空历史悔棋是空操作', () => {
    const s = initialState();
    expect(undo(s)).toBe(s);
  });

  it('普通落子悔棋：盘面、轮次、最后一手整体还原', () => {
    let s = place(initialState(), idx(4, 4));
    s = place(s, idx(3, 3));
    const back = undo(s);
    expect(back.history).toHaveLength(1);
    expect(back.board[idx(3, 3)]).toBe(0);
    expect(back.board[idx(4, 4)]).toBe(1);
    expect(back.current).toBe(2);
    expect(back.lastMove).toBe(idx(4, 4));
    expect(back.status).toBe('playing');
  });

  it('提子后悔棋：被提棋群与提子数完整还原', () => {
    const s = fromBoard(
      [
        '.........',
        '.........',
        '.........',
        '....BB...',
        '....WWB..',
        '....BB...',
        '.........',
        '.........',
        '.........',
      ],
      1,
    );
    const after = place(s, idx(4, 3)); // 黑提两子
    expect(after.captures).toEqual([2, 0]);
    const back = undo(after);
    expect(back.board[idx(4, 4)]).toBe(2);
    expect(back.board[idx(4, 5)]).toBe(2);
    expect(back.board[idx(4, 3)]).toBe(0);
    expect(back.captures).toEqual([0, 0]);
    expect(back.current).toBe(1);
    expect(back).toEqual(s);
  });

  it('劫争悔棋：劫禁点随快照还原', () => {
    const ko = fromBoard([
      'W.WB.....',
      '.WB......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ]);
    const took = place(ko, idx(0, 1));
    expect(took.koPoint).toBe(idx(0, 2));
    const back = undo(took);
    expect(back.koPoint).toBe(-1);
    expect(back).toEqual(ko);
  });

  it('跨虚着悔棋：连续虚着计数与轮次还原', () => {
    let s = place(initialState(), idx(4, 4));
    s = pass(s);
    const back = undo(s);
    expect(back.passes).toBe(0);
    expect(back.current).toBe(2);
    expect(back.lastMove).toBe(idx(4, 4));
  });

  it('双虚着悔棋：退回对局阶段且只保留一次虚着', () => {
    let s = place(initialState(), idx(4, 4));
    s = pass(s);
    s = pass(s);
    expect(s.status).toBe('marking');
    const back = undo(s);
    expect(back.status).toBe('playing');
    expect(back.passes).toBe(1);
    expect(back.current).toBe(1);
  });

  it('确认数子后悔棋：退回标记模式且死子标记保留', () => {
    let marking: GoState = { ...fromBoard(SCORING_ROWS), status: 'marking' };
    marking = toggleDead(marking, idx(2, 2));
    const done = confirmScoring(marking);
    expect(done.status).toBe('done');
    const back = undo(done);
    expect(back.status).toBe('marking');
    expect(back.dead).toEqual([idx(2, 2)]);
  });
});
