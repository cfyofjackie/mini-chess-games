// 临时基准：对比三种走法排序策略在标准开局上的求解耗时与节点数
import { it } from 'vitest';
import { START, pegCount } from '../engine/board';
import { applyMove } from '../engine/rules';
import { DEMO_BUDGET, solve, OrderVariant } from './solver';

const VARIANTS: OrderVariant[] = ['toCenter', 'toEdge', 'clearPeriphery'];

it(
  'benchmark orderings',
  { timeout: 600_000 },
  () => {
    for (const v of VARIANTS) {
      const t0 = performance.now();
      const r = solve(START, { nodeBudget: DEMO_BUDGET, order: v });
      const ms = Math.round(performance.now() - t0);
      if (r.status !== 'solved') {
        console.log(`${v}: ${r.status} in ${ms}ms`);
        continue;
      }
      let b = START;
      for (const m of r.moves) b = applyMove(b, m);
      console.log(`${v}: solved ${r.moves.length} moves in ${ms}ms, final pegs=${pegCount(b)}`);
    }
  },
);
