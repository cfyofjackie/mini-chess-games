// 中国象棋 AI 引擎测试：直接测 engine/ai.ts（docs/games/xiangqi.md 第四节八条测试清单，验收核心）。
// 覆盖：合法步（多场景 × 三档 + 与引擎 parity）、一步绝杀、双车残局获胜路径、
// 不白送大子、等价换吃、确定性、预算合规、hard vs medium 自对弈强度报告。
// 棋子编码速查：1帅 2仕 3相 4马 5车 6炮 7兵 / 8将 9士 10象 11马 12车 13炮 14卒
import { describe, expect, it } from 'vitest';
import {
  allLegalMoves,
  B_A,
  B_C,
  B_K,
  B_N,
  B_P,
  B_R,
  CELLS,
  COLS,
  initialState,
  place,
  R_A,
  R_C,
  R_K,
  R_N,
  R_P,
  R_R,
  type Player,
  type XiangqiState,
} from './xiangqi';
import {
  chooseMove,
  legalMovesOf,
  MATE_SCORE,
  NODE_BUDGET,
  type AiMove,
  type AiPosition,
  type Difficulty,
} from './ai';

const at = (r: number, c: number) => r * COLS + c;
const DIFFS: readonly Difficulty[] = ['easy', 'medium', 'hard'];
const key = (m: AiMove) => `${m.from}-${m.to}`;

/** 构造任意测试局面（默认红先行） */
function mk(pieces: Array<[number, number, number]>, current: Player = 1): XiangqiState {
  const board = new Int8Array(CELLS);
  for (const [r, c, p] of pieces) board[at(r, c)] = p;
  return {
    board,
    history: [],
    current,
    status: 'playing',
    winner: 0,
    reason: '',
    check: false,
    lastFrom: -1,
    lastTo: -1,
  };
}

/** ChessState → AI 求解入参（结构兼容，共享同一 Int8Array 引用不改动） */
const aiPos = (s: XiangqiState): AiPosition => ({
  board: s.board,
  current: s.current,
  status: s.status,
});

/** 依次走子（引擎 place 会拒绝非法步，走错立即在断言处暴露） */
function play(state: XiangqiState, ...moves: Array<[number, number]>): XiangqiState {
  let s = state;
  for (const [f, t] of moves) {
    const next = place(s, f, t);
    expect(next).not.toBe(s);
    s = next;
  }
  return s;
}

/** AI 输出必须被引擎接受（合法性最终裁决 = place 不拒绝），且在引擎合法步集合内 */
function expectLegal(s: XiangqiState, m: AiMove | null): void {
  expect(m).not.toBeNull();
  expect(place(s, m!.from, m!.to)).not.toBe(s);
  const legal = allLegalMoves(s.board, s.current);
  expect(legal.some((l) => l.from === m!.from && l.to === m!.to)).toBe(true);
}

/**
 * 引擎 parity：AI 内部合法步生成的 from-to 集合与引擎 allLegalMoves 完全一致
 *（牵制 / 炮屏 / 马腿 / 飞将全语义对齐——AI 走法生成的正确性根基）。
 */
function expectParity(s: XiangqiState): void {
  const mine = legalMovesOf(aiPos(s)).map(key).sort();
  const engine = allLegalMoves(s.board, s.current).map((m) => key(m)).sort();
  expect(mine).toEqual(engine);
}

/** 固定中盘局面（中炮对屏风马 9 半回合后轮到黑方）：测试 1/6/7/8 复用 */
const MIDGAME = play(
  initialState(),
  [at(7, 7), at(7, 4)], // 炮二平五
  [at(2, 7), at(2, 4)], // 炮 8 平 5
  [at(9, 7), at(7, 6)], // 马二进三
  [at(0, 7), at(2, 6)], // 马 8 进 7
  [at(9, 8), at(9, 7)], // 车一平二
  [at(0, 1), at(2, 2)], // 马 2 进 3
  [at(6, 2), at(5, 2)], // 兵三进一
  [at(3, 2), at(4, 2)], // 卒 3 进 1
  [at(9, 0), at(8, 0)], // 车九进一（轮到黑方）
);

describe('xiangqi AI', () => {
  it(
    '0. 合法步生成与引擎 parity：牵制/炮屏/马腿/飞将构造局面 + easy 自对弈全程逐步校验',
    () => {
      const states: XiangqiState[] = [
        initialState(),
        MIDGAME,
        // 车牵制炮（炮只能沿牵制线滑动）
        mk([[9, 4, R_K], [5, 4, R_C], [0, 4, B_R], [0, 0, B_K]], 1),
        // 车牵制车 + 身后再有保护子：吃牵制子后仍有遮挡，合法
        mk([[9, 4, R_K], [5, 4, R_R], [2, 4, B_R], [0, 4, B_R], [0, 8, B_K]], 1),
        // 炮恰两屏：两屏子腾开会新开炮将军，沿炮线平移合法、横移/吃屏非法
        mk([[9, 4, R_K], [5, 4, R_R], [2, 4, B_P], [0, 4, B_C], [0, 8, B_K]], 1),
        // 炮双屏（双兵）：前兵沿线推进仍双屏合法
        mk([[9, 4, R_K], [8, 4, R_P], [7, 4, R_P], [0, 4, B_C], [0, 0, B_K]], 1),
        // 马腿腾格 discovered 将军：腿上兵唯一着法是吃马
        mk([[9, 4, R_K], [8, 3, R_P], [7, 3, B_N], [0, 4, B_K]], 1),
        // 飞将牵制：遮挡兵横移非法、沿线前进合法
        mk([[9, 4, R_K], [0, 4, B_K], [5, 4, R_P]], 1),
      ];
      for (const s of states) expectParity(s);

      // easy 自对弈 60 半回合：每步 parity + 引擎接受（覆盖大量随机可达局面）
      let s = initialState();
      let plies = 0;
      for (; plies < 60 && s.status === 'playing'; plies++) {
        expectParity(s);
        const { move } = chooseMove(aiPos(s), 'easy');
        expectLegal(s, move);
        s = place(s, move!.from, move!.to);
      }
      expect(plies).toBeGreaterThan(10);
    },
  );

  it('1. AI 输出必为合法步（多场景 × 三档）；终局返回 null', () => {
    const scenarios: XiangqiState[] = [
      initialState(), // 开局红先
      MIDGAME, // 中盘黑方回合
      // 黑方正被车将军须应将（红车 (2,4) 沿 4 列将军）
      mk([[0, 4, B_K], [0, 3, B_A], [2, 4, R_R], [9, 4, R_K], [6, 3, B_C]], 2),
      // 隔一炮架的炮吃可用（黑炮 (7,4) 隔红炮 (4,4) 打红兵 (2,4)）
      mk([[9, 4, R_K], [0, 4, B_K], [7, 4, B_C], [4, 4, R_C], [2, 4, R_P], [1, 4, R_N]], 2),
      // 两将照面被兵遮挡的中残局面
      mk([[9, 4, R_K], [0, 4, B_K], [5, 4, R_P]], 2),
    ];
    for (const s of scenarios) {
      for (const d of DIFFS) expectLegal(s, chooseMove(aiPos(s), d).move);
    }

    // 终局（将死 / 困毙）→ move = null
    // (6,4) 红兵遮挡两将照面（否则局面本身违反飞将规则、底车叫将一步不解除照面会被 place 拒绝）
    const mated = play(
      mk([[9, 4, R_K], [6, 4, R_P], [0, 4, B_K], [8, 0, B_R], [4, 8, B_R]], 2),
      [at(4, 8), at(9, 8)],
    );
    expect(mated.status).toBe('won');
    expect(mated.reason).toBe('checkmate');
    const staled = play(mk([[9, 0, R_K], [2, 4, R_P], [0, 3, B_K]], 1), [at(2, 4), at(1, 4)]);
    expect(staled.status).toBe('won');
    expect(staled.reason).toBe('stalemate');
    for (const d of DIFFS) {
      expect(chooseMove(aiPos(mated), d).move).toBeNull();
      expect(chooseMove(aiPos(staled), d).move).toBeNull();
    }
  });

  it('2. 一步绝杀必找到（三档）：底线双车错杀', () => {
    // 黑车 (4,8)→(9,8) 沿底线叫将：红帅三路逃生格全被 (8,0) 黑车封锁，一步绝杀。
    // (6,4) 红兵仅作两将照面遮挡（无法拦挡底线将军或吃车，不影响杀法成立）
    const A = mk([[9, 4, R_K], [6, 4, R_P], [0, 4, B_K], [8, 0, B_R], [4, 8, B_R]], 2);
    expect(place(A, at(4, 8), at(9, 8)).reason).toBe('checkmate'); // 前提：确为一步绝杀
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(A), d).move!;
      expect(m.from).toBe(at(4, 8));
      expect(m.to).toBe(at(9, 8));
    }
    expect(chooseMove(aiPos(A), 'hard').score).toBe(MATE_SCORE - 1);
  });

  it(
    '3. 必胜残局（双车挫）：困难档预算内找到获胜路径并完成将杀/困毙',
    { timeout: 180_000 },
    () => {
      // 双车挫两步杀：首着不唯一（沉底封锁 / 沉底叫将 / 贴身叫将等均可构成
      // "任意红方应对 → 黑再一手即胜"，将死与困毙同为获胜）。先用引擎真值
      // 枚举全部两步杀首着，再断言 hard 的选择必在其中且分值为 MATE−3——
      // 即规格语义"困难档在预算内找到获胜路径"，不绑定具体哪一个首着。
      const near = mk([[9, 4, R_K], [0, 4, B_K], [5, 0, B_R], [5, 8, B_R]], 2);
      const winningFirst: string[] = [];
      for (const bm of allLegalMoves(near.board, 2)) {
        const s1 = place(near, bm.from, bm.to);
        if (s1.status === 'won') continue; // 一步杀直接胜（本局面不存在）
        const allLose = allLegalMoves(s1.board, 1).every((rm) => {
          const s2 = place(s1, rm.from, rm.to);
          if (s2.status === 'won') return s2.winner === 2;
          return allLegalMoves(s2.board, 2).some((bm2) => {
            const s3 = place(s2, bm2.from, bm2.to);
            return s3.status === 'won' && s3.winner === 2;
          });
        });
        if (allLose) winningFirst.push(`${bm.from}-${bm.to}`);
      }
      expect(winningFirst.length).toBeGreaterThan(0); // 前提：确有两步杀
      const r = chooseMove(aiPos(near), 'hard');
      expect(r.move).not.toBeNull();
      expect(winningFirst).toContain(`${r.move!.from}-${r.move!.to}`);
      expect(r.score).toBe(MATE_SCORE - 3);

      // 自对弈：黑（hard）双车对红单王+单仕（hard 最强防守），必须在预算内拿下
      let s = mk([[9, 4, R_K], [9, 5, R_A], [0, 4, B_K], [3, 0, B_R], [3, 8, B_R]], 2);
      let plies = 0;
      let totalNodes = 0;
      const t0 = Date.now();
      for (; plies < 60 && s.status === 'playing'; plies++) {
        const res = chooseMove(aiPos(s), 'hard');
        expect(res.move).not.toBeNull();
        expect(res.nodes).toBeLessThanOrEqual(NODE_BUDGET);
        totalNodes += res.nodes;
        expectLegal(s, res.move);
        s = place(s, res.move!.from, res.move!.to);
      }
      expect(s.status).toBe('won');
      expect(s.winner).toBe(2);
      console.log(
        `[双车残局] ${plies} 半回合取胜，累计节点 ${totalNodes}，总耗时 ${Date.now() - t0}ms`,
      );
    },
  );

  it('4. 不白送大子：中等/困难档避开"送车"陷阱，简单档会踩坑（难度梯度）', () => {
    // 黑车 (2,4) 可吃 (5,4) 红兵，但红车 (5,0) 同线保护：车吃兵被车反吃，白送 800 分
    const s = mk([[9, 4, R_K], [5, 0, R_R], [5, 4, R_P], [0, 4, B_K], [2, 4, B_R]], 2);
    const trap = `${at(2, 4)}-${at(5, 4)}`;
    expect(key(chooseMove(aiPos(s), 'easy').move!)).toBe(trap); // 只看一步：贪吃保护兵
    for (const d of ['medium', 'hard'] as const) {
      expect(key(chooseMove(aiPos(s), d).move!)).not.toBe(trap); // 静态搜索看见反吃
    }
  });

  it('5. 白吃必吃：己方马被捉，等价换吃（马换马）是三档共同最优', () => {
    // 黑马 (5,4) 被红兵 (6,4) 捉死；可吃红马 (4,6)（红兵 (5,6) 保护，回吃成等价交换）。
    // 其余马步全被蹩/被封或落点被捉：(3,3)/(3,5) 腿被 (4,4) 塞、(4,2)/(6,2) 腿被 (5,3) 塞、
    // (7,3)/(7,5) 腿被 (6,4) 塞、(6,6) 落点被红车 (9,6) 捉——不吃必白丢马（-400）。
    const s = mk(
      [
        [9, 4, R_K], [4, 6, R_N], [4, 4, R_P], [5, 6, R_P], [6, 4, R_P], [9, 6, R_R],
        [0, 4, B_K], [5, 4, B_N], [5, 3, B_P],
      ],
      2,
    );
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(s), d).move!;
      expect(m.from).toBe(at(5, 4));
      expect(m.to).toBe(at(4, 6));
    }
  });

  it('6. 确定性：同一局面两次求解，步 / 节点数 / 深度 / 分值完全一致', () => {
    const positions: Array<[string, XiangqiState]> = [
      ['开局', initialState()],
      ['中盘', MIDGAME],
    ];
    for (const [name, s] of positions) {
      for (const d of DIFFS) {
        const a = chooseMove(aiPos(s), d);
        const b = chooseMove(aiPos(s), d);
        expect(a.move).not.toBeNull();
        expect(a.move).toEqual(b.move);
        expect(a.nodes).toBe(b.nodes);
        expect(a.depth).toBe(b.depth);
        expect(a.score).toBe(b.score);
        expect(a.nodes).toBeGreaterThan(0);
        console.log(`[确定性] ${name} ${d}: nodes=${a.nodes}, depth=${a.depth}, score=${a.score}`);
      }
    }
  });

  it(
    '7. 预算合规：困难档最复杂中盘局面单步 ≤3s（墙钟）',
    { timeout: 60_000 },
    () => {
      for (const [name, s] of [
        ['开局', initialState()],
        ['中盘', MIDGAME],
      ] as const) {
        const t0 = performance.now();
        const r = chooseMove(aiPos(s), 'hard');
        const ms = performance.now() - t0;
        expect(r.move).not.toBeNull();
        expect(r.nodes).toBeLessThanOrEqual(NODE_BUDGET);
        expect(ms).toBeLessThan(3000);
        console.log(`[预算] hard ${name}: ${Math.round(ms)}ms, nodes=${r.nodes}, depth=${r.depth}`);
      }
    },
  );

  it(
    '8. 强度梯度：固定开局 hard vs medium 自对弈（报告性，不作硬断言）',
    { timeout: 600_000 },
    () => {
      const openings: Array<{ name: string; start: XiangqiState }> = [
        { name: '初始局面', start: initialState() },
        {
          name: '中炮对屏风马',
          start: play(
            initialState(),
            [at(7, 7), at(7, 4)],
            [at(2, 7), at(2, 4)],
            [at(9, 7), at(7, 6)],
            [at(0, 7), at(2, 6)],
          ),
        },
      ];
      let hardWins = 0;
      let mediumWins = 0;
      let undecided = 0;
      const lines: string[] = [];
      for (const { name, start } of openings) {
        for (const hardAsRed of [true, false]) {
          let s = start;
          let plies = 0;
          const t0 = Date.now();
          for (; plies < 120 && s.status === 'playing'; plies++) {
            const hardTurn = hardAsRed ? s.current === 1 : s.current === 2;
            const { move } = chooseMove(aiPos(s), hardTurn ? 'hard' : 'medium');
            if (!move) break;
            expectLegal(s, move);
            s = place(s, move.from, move.to);
          }
          let outcome: string;
          if (s.status === 'won') {
            const hardWon = hardAsRed ? s.winner === 1 : s.winner === 2;
            if (hardWon) hardWins++;
            else mediumWins++;
            outcome = `${s.winner === 1 ? '红' : '黑'}胜（${s.reason === 'checkmate' ? '将死' : '困毙'}）`;
          } else {
            undecided++;
            outcome = '步数上限未分胜负';
          }
          lines.push(
            `${name} · hard 执${hardAsRed ? '红' : '黑'} vs medium 执${hardAsRed ? '黑' : '红'}：` +
              `${outcome}，${plies} 半回合，${Date.now() - t0}ms`,
          );
        }
      }
      for (const line of lines) console.log(`[自对弈] ${line}`);
      const total = hardWins + mediumWins + undecided;
      console.log(
        `[自对弈] hard ${hardWins} 胜 / medium ${mediumWins} 胜 / 未分胜负 ${undecided}` +
          `（hard 胜率 ${total > 0 ? Math.round((hardWins / total) * 100) : 0}%）`,
      );
    },
  );
});
