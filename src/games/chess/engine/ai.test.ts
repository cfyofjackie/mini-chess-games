// 国际象棋 AI 引擎测试：直接测 engine/ai.ts（docs/games/chess.md 第四节九条测试清单，验收核心）。
// 覆盖：合法步（多场景 × 三档 + 与引擎 parity）、一步将杀、双车残局将死路径、
// 不白送子、等价换吃、优势避逼和、确定性、预算合规、hard vs medium 自对弈强度报告。
// 棋子编码速查：1兵 2马 3象 4车 5后 6王 / 8兵 9马 10象 11车 12后 13王
import { describe, expect, it } from 'vitest';
import {
  allLegalMoves,
  fromAlgebraic,
  initialState,
  makeMove,
  position,
  type ChessState,
} from './chess';
import {
  chooseMove,
  legalMovesOf,
  MATE_SCORE,
  NODE_BUDGET,
  type AiMove,
  type AiPosition,
  type Difficulty,
} from './ai';

const S = (sq: string) => fromAlgebraic(sq);
const DIFFS: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/** ChessState → AI 求解入参（结构兼容，共享同一 Int8Array 引用不改动） */
const aiPos = (s: ChessState): AiPosition => ({
  board: s.board,
  current: s.current,
  castling: s.castling,
  enPassant: s.enPassant,
  status: s.status,
});

/** 依次走子（代数坐标） */
function play(state: ChessState, ...moves: Array<[string, string]>): ChessState {
  let s = state;
  for (const [f, t] of moves) s = makeMove(s, S(f), S(t));
  return s;
}

const key = (m: AiMove) => `${m.from}-${m.to}`;

/** AI 输出必须被引擎接受（合法性最终裁决 = makeMove 不拒绝），且在引擎合法步集合内 */
function expectLegal(s: ChessState, m: AiMove | null): void {
  expect(m).not.toBeNull();
  expect(makeMove(s, m!.from, m!.to, m!.promotion)).not.toBe(s);
  const legal = allLegalMoves(s.board, s.current, s.enPassant, s.castling);
  expect(legal.some((l) => l.from === m!.from && l.to === m!.to)).toBe(true);
}

/**
 * 引擎 parity：AI 内部合法步生成的 from-to 集合（升变展开去重）与
 * 引擎 allLegalMoves 完全一致（牵制 / 将军 / 易位 / 过路兵全语义对齐）。
 */
function expectParity(s: ChessState): void {
  const mine = [...new Set(legalMovesOf(aiPos(s)).map(key))].sort();
  const engine = allLegalMoves(s.board, s.current, s.enPassant, s.castling)
    .map((m) => `${m.from}-${m.to}`)
    .sort();
  expect(mine).toEqual(engine);
}

/** 固定中盘局面（意大利开局，黑方刚走完 …Nf6 之前为白方回合）：测试 7/8 复用 */
const MIDGAME = play(
  initialState(),
  ['e2', 'e4'], ['e7', 'e5'],
  ['g1', 'f3'], ['b8', 'c6'],
  ['f1', 'c4'], ['g8', 'f6'],
);

describe('chess AI', () => {
  it('1. AI 输出必为合法步（多场景 × 三档）；终局 / 无合法步返回 null', () => {
    const scenarios: ChessState[] = [
      initialState(), // 开局白先
      MIDGAME, // 中盘黑方回合
      // 黑方正被将军须应将（白车 e1 沿 e 线将军）
      position([['g1', 'K'], ['e1', 'R'], ['e8', 'k'], ['d8', 'r'], ['g6', 'b']], { current: 2 }),
      // 吃过路兵可用（白兵刚两格 d2-d4）
      position([['h1', 'K'], ['h8', 'k'], ['e4', 'p'], ['d4', 'P']], { current: 2, enPassant: 'd3' }),
      // 双侧可易位
      position(
        [['e1', 'K'], ['a1', 'R'], ['h1', 'R'], ['e8', 'k'], ['a8', 'r'], ['h8', 'r']],
        { current: 2 },
      ),
    ];
    for (const s of scenarios) {
      for (const d of DIFFS) expectLegal(s, chooseMove(aiPos(s), d).move);
    }

    // 升变局面：黑方唯一合法步 = c2 兵四种升变，AI 必须显式携带升变子
    const promo = position([['h2', 'K'], ['a5', 'R'], ['g1', 'R'], ['h4', 'k'], ['c2', 'p']], {
      current: 2,
    });
    expect(legalMovesOf(aiPos(promo))).toHaveLength(4); // 前提：仅四种升变
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(promo), d).move!;
      expect(m.from).toBe(S('c2'));
      expect(m.to).toBe(S('c1'));
      expect(['q', 'r', 'b', 'n']).toContain(m.promotion);
      expectLegal(promo, m);
    }

    // 终局（将死 / 逼和）→ move = null
    const mated = play(
      initialState(),
      ['e2', 'e4'], ['e7', 'e5'],
      ['f1', 'c4'], ['b8', 'c6'],
      ['d1', 'h5'], ['g8', 'f6'],
      ['h5', 'f7'],
    );
    expect(mated.status).toBe('won');
    const stale = position([['b6', 'K'], ['c7', 'Q'], ['a8', 'k']], { current: 2 });
    for (const d of DIFFS) {
      expect(chooseMove(aiPos(mated), d).move).toBeNull();
      expect(chooseMove(aiPos(stale), d).move).toBeNull();
    }
  });

  it('1b. 合法步生成与引擎 parity：战术局面 + 自对弈全程逐步校验', () => {
    // 覆盖牵制 / 将军 / 易位 / 过路兵 / 升变 / 残局的构造局面
    const states: ChessState[] = [
      initialState(),
      MIDGAME,
      position([['g1', 'K'], ['e1', 'R'], ['e8', 'k'], ['d8', 'r'], ['g6', 'b']], { current: 2 }),
      position([['h1', 'K'], ['h8', 'k'], ['e4', 'p'], ['d4', 'P']], { current: 2, enPassant: 'd3' }),
      position([['e1', 'K'], ['a1', 'R'], ['h1', 'R'], ['e8', 'k'], ['a8', 'r'], ['h8', 'r']], { current: 2 }),
      position([['h2', 'K'], ['a5', 'R'], ['g1', 'R'], ['h4', 'k'], ['c2', 'p']], { current: 2 }),
      // 测试 4 / 5 / 6 的战术局面
      position(
        [['e1', 'K'], ['e5', 'P'], ['d4', 'P'], ['e2', 'P'], ['g1', 'N'], ['e8', 'k'], ['d6', 'q']],
        { current: 2 },
      ),
      position(
        [
          ['e1', 'K'], ['a1', 'R'], ['d5', 'B'], ['d2', 'N'], ['g1', 'N'],
          ['a4', 'P'], ['b2', 'P'], ['e4', 'P'],
          ['e8', 'k'], ['c3', 'n'], ['a7', 'p'], ['b7', 'p'], ['g7', 'p'], ['h7', 'p'],
        ],
        { current: 2 },
      ),
      position([['a8', 'K'], ['b6', 'k'], ['d7', 'q']], { current: 2 }),
    ];
    for (const s of states) expectParity(s);

    // easy 自对弈 60 半回合：每步 parity + 引擎接受（覆盖大量随机可达局面）
    let s = initialState();
    let plies = 0;
    for (; plies < 60 && s.status === 'playing'; plies++) {
      expectParity(s);
      const { move } = chooseMove(aiPos(s), 'easy');
      expectLegal(s, move);
      s = makeMove(s, move!.from, move!.to, move!.promotion);
    }
    expect(plies).toBeGreaterThan(10);
  });

  it('2. 一步将杀必找到（三档）', () => {
    // A：底线将杀，黑车 a8→a1#
    const A = position(
      [['g1', 'K'], ['f2', 'P'], ['g2', 'P'], ['h2', 'P'], ['a8', 'r'], ['g8', 'k']],
      { current: 2 },
    );
    expect(makeMove(A, S('a8'), S('a1')).reason).toBe('checkmate'); // 前提：确为一步将杀
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(A), d).move!;
      expect(m.from).toBe(S('a8'));
      expect(m.to).toBe(S('a1'));
    }
    // B：后底线将杀，黑后 d8→d1#
    const B = position(
      [['g1', 'K'], ['f2', 'P'], ['g2', 'P'], ['h2', 'P'], ['d8', 'q'], ['g8', 'k']],
      { current: 2 },
    );
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(B), d).move!;
      expect(m.from).toBe(S('d8'));
      expect(m.to).toBe(S('d1'));
    }
  });

  it(
    '3. 必胜残局：双车杀困难档预算内找到将死路径（含将死分值与自对弈终局）',
    { timeout: 120_000 },
    () => {
      // 两步杀（Rb7 Kg8 Ra8# / Ra7 Kg8 Rb8#），困难档应选中其一且分值 = MATE − 3
      const mate2 = position([['h8', 'K'], ['a6', 'r'], ['b1', 'r'], ['a1', 'k']], { current: 2 });
      const r = chooseMove(aiPos(mate2), 'hard');
      const winning = [
        [S('a6'), S('a7')],
        [S('b1'), S('b7')],
      ];
      expect(winning.some(([f, t]) => r.move!.from === f && r.move!.to === t)).toBe(true);
      expect(r.score).toBe(MATE_SCORE - 3);

      // 将死路径自对弈：双车（黑，hard）对单王（白，hard 最强防守）必须完成将死
      let s = position([['e5', 'K'], ['a8', 'r'], ['h8', 'r'], ['a1', 'k']], { current: 2 });
      let plies = 0;
      let totalNodes = 0;
      const t0 = Date.now();
      for (; plies < 60 && s.status === 'playing'; plies++) {
        const res = chooseMove(aiPos(s), 'hard');
        expect(res.move).not.toBeNull();
        expect(res.nodes).toBeLessThanOrEqual(NODE_BUDGET);
        totalNodes += res.nodes;
        expectLegal(s, res.move);
        s = makeMove(s, res.move!.from, res.move!.to, res.move!.promotion);
      }
      expect(s.status).toBe('won');
      expect(s.reason).toBe('checkmate');
      expect(s.winner).toBe(2);
      console.log(
        `[残局将死] ${plies} 半回合收将，累计节点 ${totalNodes}，总耗时 ${Date.now() - t0}ms`,
      );
    },
  );

  it('4. 不白送子：中等/困难档避开"送后"陷阱，简单档会踩坑（难度梯度）', () => {
    // 黑后 d6 可吃 e5 兵，但该兵有 d4 兵保护：Qxe5?? dxe5 白送整个后（-800）
    const s = position(
      [['e1', 'K'], ['e5', 'P'], ['d4', 'P'], ['e2', 'P'], ['g1', 'N'], ['e8', 'k'], ['d6', 'q']],
      { current: 2 },
    );
    const trap = `${S('d6')}-${S('e5')}`;
    expect(key(chooseMove(aiPos(s), 'easy').move!)).toBe(trap); // 只看一步：贪吃保护兵
    for (const d of ['medium', 'hard'] as const) {
      expect(key(chooseMove(aiPos(s), d).move!)).not.toBe(trap); // 静态搜索看见 dxe5 回吃
    }
  });

  it('5. 等价换吃：目标子（象）有保护，AI 仍敢于换吃', () => {
    // 黑马 c3 吃白象 d5（e4 兵保护），Nx d5 exd5 = 马(320) 换象(330) 净 +10；
    // 不吃则白 bxc3 白丢马（-320）。换吃是三档共同的明确最优。
    const s = position(
      [
        ['e1', 'K'], ['a1', 'R'], ['d5', 'B'], ['d2', 'N'], ['g1', 'N'],
        ['a4', 'P'], ['b2', 'P'], ['e4', 'P'],
        ['e8', 'k'], ['c3', 'n'], ['a7', 'p'], ['b7', 'p'], ['g7', 'p'], ['h7', 'p'],
      ],
      { current: 2 },
    );
    for (const d of DIFFS) {
      const m = chooseMove(aiPos(s), d).move!;
      expect(m.from).toBe(S('c3'));
      expect(m.to).toBe(S('d5'));
    }
  });

  it('6. 优势避逼和：困难档不选导致逼和的随手棋，直接一步将杀', () => {
    // 黑 Kb6 + Qd7 对白 Ka8：Qc7?? 逼和（0 分），Qd8# / Qb7# 直接获胜
    const s = position([['a8', 'K'], ['b6', 'k'], ['d7', 'q']], { current: 2 });
    const stalemate = `${S('d7')}-${S('c7')}`;
    for (const d of ['medium', 'hard'] as const) {
      const m = chooseMove(aiPos(s), d).move!;
      expect(key(m)).not.toBe(stalemate);
      expect(m.to === S('d8') || m.to === S('b7')).toBe(true); // 找到一步将杀
    }
    expect(chooseMove(aiPos(s), 'hard').score).toBe(MATE_SCORE - 1);
  });

  it('7. 确定性：同一局面两次求解，步 / 节点数 / 深度 / 分值完全一致', () => {
    for (const d of DIFFS) {
      const a = chooseMove(aiPos(MIDGAME), d);
      const b = chooseMove(aiPos(MIDGAME), d);
      expect(a.move).not.toBeNull();
      expect(a.move).toEqual(b.move);
      expect(a.nodes).toBe(b.nodes);
      expect(a.depth).toBe(b.depth);
      expect(a.score).toBe(b.score);
    }
  });

  it(
    '8. 预算合规：困难档最复杂中盘局面单步 ≤3s（墙钟）',
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
    '9. 强度梯度：固定开局 hard vs medium 自对弈（报告性，不作硬断言）',
    { timeout: 600_000 },
    () => {
      const openings: Array<{ name: string; moves: Array<[string, string]> }> = [
        { name: '初始局面', moves: [] },
        { name: '意大利开局', moves: [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']] },
        { name: '后翼弃兵', moves: [['d2', 'd4'], ['d7', 'd5'], ['c2', 'c4'], ['e7', 'e6']] },
      ];
      let hardWins = 0;
      let mediumWins = 0;
      let draws = 0;
      const lines: string[] = [];
      for (const { name, moves } of openings) {
        for (const hardAsWhite of [true, false]) {
          let s = play(initialState(), ...moves);
          let plies = 0;
          const t0 = Date.now();
          for (; plies < 100 && s.status === 'playing'; plies++) {
            const isHardTurn = hardAsWhite ? s.current === 1 : s.current === 2;
            const { move } = chooseMove(aiPos(s), isHardTurn ? 'hard' : 'medium');
            if (!move) break;
            expectLegal(s, move);
            s = makeMove(s, move.from, move.to, move.promotion);
          }
          let outcome: string;
          if (s.status === 'won') {
            const hardWon = hardAsWhite ? s.winner === 1 : s.winner === 2;
            if (hardWon) hardWins++;
            else mediumWins++;
            outcome = `${s.winner === 1 ? '白' : '黑'}胜（将死）`;
          } else if (s.status === 'draw') {
            draws++;
            outcome = `和棋（${s.reason}）`;
          } else {
            outcome = '步数上限未分胜负';
          }
          lines.push(
            `${name} · hard 执${hardAsWhite ? '白' : '黑'} vs medium 执${hardAsWhite ? '黑' : '白'}：` +
              `${outcome}，${plies} 半回合，${Date.now() - t0}ms`,
          );
        }
      }
      for (const line of lines) console.log(`[自对弈] ${line}`);
      console.log(
        `[自对弈] hard ${hardWins} 胜 / medium ${mediumWins} 胜 / 和 ${draws}` +
          `（hard 胜率 ${Math.round((hardWins / (hardWins + mediumWins + draws)) * 100)}%）`,
      );
    },
  );
});
