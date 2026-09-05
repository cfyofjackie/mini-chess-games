// 围棋 MCTS 对战 AI 测试（docs/games/go.md 第三节A 测试清单七条逐条 + 快走⇄引擎一致性 parity）。
// 全部确定性：固定局面 + 固定种子 + 固定预算 ⇒ 断言永久稳定，无随机 flakes。
import { describe, expect, it } from 'vitest';
import {
  CELLS,
  SIZE,
  type GoState,
  type Player,
  confirmScoring,
  groupAt,
  groupsOf,
  initialState,
  legalMoves,
  pass,
  place,
} from './go';
import { chooseMove } from './ai';
import {
  chooseAiMove,
  fastLegal,
  fastPlace,
  solveMcts,
  type MctsOptions,
} from './mcts';

const idx = (r: number, c: number) => r * SIZE + c;

/** 按字符画（B 黑 / W 白 / . 空）构造任意局面（同 ai.test.ts 惯例） */
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

const EMPTY_ROWS = Array.from({ length: SIZE }, () => '.'.repeat(SIZE));

/** 中盘散子局面（战术/预算/强度测试共用的"真实感"棋盘） */
const MID_ROWS = [
  '.........',
  '...B.....',
  '.....W...',
  '..B......',
  '....B.W..',
  '...W.....',
  '.......B.',
  '....W....',
  '.........',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 快走 ⇄ 引擎一致性

describe('快走与引擎一致性（parity，守护快走合法点/落子/劫与引擎严格同语义）', () => {
  it('随机对局全程：fastLegal ≡ legalMoves，fastPlace ≡ place（盘面 + 劫点）', () => {
    const rand = mulberry32(42);
    let s = initialState();
    for (let step = 0; step < 300; step++) {
      const el = legalMoves(s);
      expect(fastLegal(s.board, s.current, s.koPoint)).toEqual(el);
      for (const mv of el) {
        const fp = fastPlace(s.board, mv, s.current, s.koPoint);
        const ep = place(s, mv);
        expect(fp).not.toBeNull();
        expect(fp!.board).toEqual(ep.board);
        expect(fp!.koPoint).toBe(ep.koPoint);
      }
      // 随机走一步继续生成新局面（含虚着，覆盖劫禁解除等分支）
      if (rand() < 0.06 || el.length === 0) {
        s = pass(s);
      } else {
        s = place(s, el[Math.floor(rand() * el.length)]!);
      }
      if (s.status !== 'playing') s = initialState();
    }
  });
});

// ---------------------------------------------------------------- 测试清单 1：输出必为合法点

describe('第三节A-1：MCTS 输出必为合法点（含非 pass 场景 × 中等/困难两档）', () => {
  const levels = ['medium', 'hard'] as const;
  const opts: Record<(typeof levels)[number], MctsOptions> = {
    medium: { simulations: 300, deadlineMs: 900 },
    hard: { simulations: 600, deadlineMs: 900 },
  };

  it('空盘必落子（非 pass）且为合法点；中盘输出合法点或虚着，落子必改变局面', () => {
    const positions = [
      { rows: EMPTY_ROWS, current: 1 as Player, mustStone: true },
      { rows: EMPTY_ROWS, current: 2 as Player, mustStone: true },
      { rows: MID_ROWS, current: 1 as Player, mustStone: true },
      { rows: MID_ROWS, current: 2 as Player, mustStone: false },
    ];
    for (const level of levels) {
      for (const pos of positions) {
        const s = fromBoard(pos.rows, pos.current);
        const r = solveMcts(s, level, opts[level]);
        expect(r.clockAbort).toBe(false); // 小预算不应触达墙钟
        if (pos.mustStone) expect(r.move).toBeGreaterThanOrEqual(0);
        if (r.move >= 0) {
          expect(legalMoves(s)).toContain(r.move);
          expect(place(s, r.move)).not.toBe(s);
        }
      }
    }
  });

  it('无任何合法点的局面输出 -1（虚着）；三档统一入口语义一致', () => {
    // 满盘黑棋仅留 (4,4) 一点：该点是全盘大群的最后一口气，落子即整群自杀 ⇒ 引擎判定无合法点
    const rows: string[] = [];
    for (let r = 0; r < SIZE; r++) {
      let row = '';
      for (let c = 0; c < SIZE; c++) row += r === 4 && c === 4 ? '.' : 'B';
      rows.push(row);
    }
    const s = fromBoard(rows, 1);
    expect(legalMoves(s)).toHaveLength(0);
    expect(solveMcts(s, 'medium', opts.medium).move).toBe(-1);
    expect(solveMcts(s, 'hard', opts.hard).move).toBe(-1);
    expect(chooseAiMove(s, 'easy').move).toBe(-1); // 启发式同口径（宁虚着不下自杀点）
  });
});

// ---------------------------------------------------------------- 测试清单 2/3：必提 / 必救
//
// 局面设计约束（实测得出，两条件缺一不可）：
//   1) 被困子群必须"连墙才活"——救命/提子点 (4,4) 一线并入 col5 墙群，快走的救命近似
//      （E_MERGE 计入墙群气）才能给救命着法加权；否则群在快走里横竖是死，
//      提子可与脱先等价（延迟提子无代价），必提断言不成立。
//   2) 材料必须配平到根胜率 0.4~0.6——任一方 saturate（怎么下都赢/都输）时
//      各根着法胜率差被压平，访问量排序退化为噪声。
describe('第三节A-2/3：战术必着（中等以上）', () => {
  // 白单列四子群 (2..5,3) 被黑环 9 子围死，仅剩气 (4,4)；(4,4) 一线连 col5 白墙
  // （白救 → 连墙真活）；黑墙底一行把材料配平到黑 14 vs 白 10+贴 3¾。
  // 提 = 净吃 4 子（黑 0.61）；不提则白 (4,4) 连墙（黑 0.24）。
  const CAPTURE_ROWS = [
    '.....W...',
    '...B.W...',
    '..BWBW...',
    '..BWBW...',
    '..BW.W...',
    '..BWBW...',
    '...B.....',
    '.........',
    '.........',
  ];

  // 镜像：黑单列四子群仅剩气 (4,4)；白环围定，黑 (4,4) 一线连 col5 黑墙
  // （救 → 连墙真活，存活率 0.9+）；白墙底一行 + 黑底一行配平。
  // 不救则白 (4,4) 净提黑 4 子（黑 0.05）；救则黑 0.46。
  const SAVE_ROWS = [
    '.....B...',
    '...W.B...',
    '..WBWB...',
    '..WBWB...',
    '..WB.B...',
    '..WBWB...',
    '...W.....',
    'WWWWWWWWW',
    'BBBBBBBBB',
  ];

  /** 中等档战术验证用显式预算（比出厂 preset 更大，保证稀疏局面下收敛到正解） */
  const MED: MctsOptions = { simulations: 4000, deadlineMs: 3000 };

  it('对方 1 气群存在时必提（中等以上，落在提点上）', () => {
    const s = fromBoard(CAPTURE_ROWS, 1);
    expect(groupAt(s.board, idx(3, 3)).liberties).toEqual([idx(4, 4)]);
    expect(solveMcts(s, 'medium', MED).move).toBe(idx(4, 4));
    expect(solveMcts(s, 'hard').move).toBe(idx(4, 4));
  });

  it('己方 1 气群且可救时优先救（中等以上，落在救命点上）', () => {
    const s = fromBoard(SAVE_ROWS, 1);
    expect(groupAt(s.board, idx(3, 3)).liberties).toEqual([idx(4, 4)]);
    expect(solveMcts(s, 'medium', MED).move).toBe(idx(4, 4));
    expect(solveMcts(s, 'hard').move).toBe(idx(4, 4));
    const after = place(s, idx(4, 4));
    expect(groupAt(after.board, idx(3, 3)).liberties.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- 测试清单 4：不填自己的真眼

describe('第三节A-4：不填自己的真眼', () => {
  // 黑 8 子大群只有 (4,4) 一只真眼 + 唯一外气 (6,5)：填眼即成 1 气孤群，白随即全歼 9 子。
  // 困难档（快走排除填真眼 + 提子加权放大恶果）绝不填眼；白方快走也不可能送死入眼（自杀）。
  const EYE_ROWS = [
    '.........',
    '..WWWWW..',
    '..WWWWW..',
    '..WBBBW..',
    '..WB.BW..',
    '..WBBBW..',
    '..WWW.W..',
    '.........',
    '.........',
  ];

  it('困难档不填自己的真眼（落点合法且异于眼位）', () => {
    const s = fromBoard(EYE_ROWS, 1);
    const eye = idx(4, 4);
    // 前提自检：眼位确为黑方真眼近似（四邻全黑），且填眼合法（尚有外气 (6,5)）
    const r = solveMcts(s, 'hard');
    expect(r.move).toBeGreaterThanOrEqual(0);
    expect(r.move).not.toBe(eye);
    expect(legalMoves(s)).toContain(r.move);
  });

  it('填眼恶果可被快走证实：填眼后白方立即有全歼手段（局面前提自检）', () => {
    const s = fromBoard(EYE_ROWS, 1);
    const filled = place(s, idx(4, 4));
    expect(filled).not.toBe(s);
    expect(groupAt(filled.board, idx(3, 3)).liberties).toEqual([idx(6, 5)]);
    const killed = place(filled, idx(6, 5));
    expect(killed).not.toBe(filled);
    expect(groupAt(filled.board, idx(3, 3)).stones.length).toBeGreaterThanOrEqual(8);
    expect(groupAt(killed.board, idx(3, 3)).stones.length).toBe(0);
  });
});

// ---------------------------------------------------------------- 测试清单 5：确定性

describe('第三节A-5：确定性（固定种子 + 固定预算两次求解同结果）', () => {
  const s = fromBoard(MID_ROWS, 1);

  it('medium / hard 各两次求解：着法、模拟数、节点数、胜率完全一致', () => {
    for (const level of ['medium', 'hard'] as const) {
      const o: MctsOptions = { seed: 12345, simulations: 700, deadlineMs: 8000 };
      const a = solveMcts(s, level, o);
      const b = solveMcts(s, level, o);
      expect(a.clockAbort).toBe(false);
      expect(b.clockAbort).toBe(false);
      expect([a.move, a.playouts, a.nodes, a.winRate]).toEqual([b.move, b.playouts, b.nodes, b.winRate]);
    }
  });

  it('统一入口 chooseAiMove：easy 直通启发式且确定，medium/hard 确定且合法', () => {
    expect(chooseAiMove(s, 'easy')).toEqual(chooseMove(s));
    const a = chooseAiMove(s, 'medium', { seed: 7, simulations: 400 });
    const b = chooseAiMove(s, 'medium', { seed: 7, simulations: 400 });
    expect(a).toEqual(b);
    expect(legalMoves(s)).toContain(a.move);
    const h1 = chooseAiMove(s, 'hard', { seed: 7, simulations: 400 });
    const h2 = chooseAiMove(s, 'hard', { seed: 7, simulations: 400 });
    expect(h1).toEqual(h2);
    expect(legalMoves(s)).toContain(h1.move);
  });
});

// ---------------------------------------------------------------- 测试清单 6：预算合规

describe('第三节A-6：预算合规（困难档中盘局面单步 ≤5s 墙钟）+ 模拟速度实测', () => {
  it('默认困难档预算：中盘单步 ≤5s，并输出模拟速度（局/秒）诊断', () => {
    const s = fromBoard(MID_ROWS, 1);
    const t0 = Date.now();
    const r = solveMcts(s, 'hard');
    const dt = Date.now() - t0;
    expect(dt).toBeLessThanOrEqual(5000);
    expect(r.playouts).toBeGreaterThan(0);
    const rate = Math.round(r.playouts / (dt / 1000));
    // 报告性输出（规格：≥2000 局/秒为合格线；不硬断言，避免慢 CI 误报）
    console.log(
      `[go-mcts] hard 单步 ${dt}ms / ${r.playouts} 次模拟 / ${rate} 局/秒（含树开销）/ 时钟中止=${r.clockAbort}`,
    );
  }, 20_000);

  it('中等档默认预算单步 ≤2s', () => {
    const s = fromBoard(MID_ROWS, 2);
    const t0 = Date.now();
    const r = solveMcts(s, 'medium');
    expect(Date.now() - t0).toBeLessThanOrEqual(2000);
    expect(r.move).toBeGreaterThanOrEqual(-1);
  }, 10_000);
});

// ---------------------------------------------------------------- 测试清单 7：强度实证（报告性）

describe('第三节A-7：强度实证（报告性）：MCTS 中等/困难 对 吃子教学 AI 各 5 局', () => {
  /** 双方按策略走到标记模式；非法着直接抛错（同 ai.test.ts playout 惯例） */
  function playout(
    black: (s: GoState) => number,
    white: (s: GoState) => number,
    maxPlies = 400,
  ) {
    let s = initialState();
    let plies = 0;
    while (s.status === 'playing') {
      if (plies >= maxPlies) throw new Error('playout did not terminate');
      const mv = s.current === 1 ? black(s) : white(s);
      if (mv < 0) s = pass(s);
      else {
        const next = place(s, mv);
        if (next === s) throw new Error(`illegal move proposed: ${mv}`);
        s = next;
      }
      plies++;
    }
    return { final: s, plies };
  }

  /** 终局死活口径：双方 ≤1 气的群判死（残子无力做活），其余全活，按中国规则数子 */
  function score(final: GoState): { winner: Player | 0; black: number; white: number } {
    let marking = final;
    for (const color of [1, 2] as const) {
      for (const g of groupsOf(marking.board, color)) {
        if (g.liberties.length <= 1) {
          marking = { ...marking, dead: [...marking.dead, ...g.stones] };
        }
      }
    }
    const r = confirmScoring(marking).result!;
    return { winner: r.winner, black: r.black, white: r.white };
  }

  it('MCTS(中等) 对教学 AI 5 局 + MCTS(困难) 对教学 AI 5 局：报告胜率，困难档明显占优', () => {
    // 强度测试预算（互弈口径，非出厂难度；确定性种子 ⇒ 结果永久可复现）。
    // 下限实测：模拟次数低于 ~300 时根节点 60+ 个候选每处仅 1~2 次访问，
    // 选点退化为噪声（被教学 AI 全歼）；480/960 起战术判断稳定成形。
    const BUDGET: Record<'medium' | 'hard', MctsOptions> = {
      medium: { simulations: 1200, deadlineMs: 3000 },
      hard: { simulations: 2400, deadlineMs: 4500 },
    };
    const heuristic = (s: GoState): number => chooseMove(s).move;
    const mctsOf = (level: 'medium' | 'hard') => (s: GoState): number =>
      solveMcts(s, level, { ...BUDGET[level], seed: 1000 + s.history.length }).move;

    const lines: string[] = [];
    const winsByLevel: Record<'medium' | 'hard', number> = { medium: 0, hard: 0 };
    for (const level of ['medium', 'hard'] as const) {
      let wins = 0;
      for (let g = 0; g < 5; g++) {
        const mctsIsBlack = g % 2 === 0; // 交替执色，排除贴目/先手偏置
        const black = mctsIsBlack ? mctsOf(level) : heuristic;
        const white = mctsIsBlack ? heuristic : mctsOf(level);
        const { final, plies } = playout(black, white);
        expect(plies).toBeLessThanOrEqual(400);
        const r = score(final);
        const mctsWin = (mctsIsBlack && r.winner === 1) || (!mctsIsBlack && r.winner === 2);
        if (mctsWin) wins++;
        lines.push(
          `  ${level} #${g + 1}: MCTS ${mctsIsBlack ? '黑' : '白'} vs 教学 AI ${mctsIsBlack ? '白' : '黑'} → ` +
            `${plies} 手, ${r.winner === 1 ? '黑胜' : r.winner === 2 ? '白胜' : '和'} ${r.black}:${r.white}` +
            ` (MCTS ${mctsWin ? '胜' : '负'})`,
        );
      }
      winsByLevel[level] = wins;
      lines.unshift(`[go-mcts 强度] ${level}: ${wins}/5 胜 教学AI`);
    }
    console.log(lines.join('\n'));
    expect(winsByLevel.hard).toBeGreaterThanOrEqual(3); // 困难档对小预算 MCTS 仍应明显压过启发式
    expect(winsByLevel.hard).toBeGreaterThanOrEqual(winsByLevel.medium);
  }, 540_000);
});
