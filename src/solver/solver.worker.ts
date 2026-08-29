// 求解器 Web Worker：提示与演示共用，避免搜索阻塞界面
import { Bits } from '../engine/board';
import { DEMO_BUDGET, HINT_BUDGET, solve } from './solver';

type SolveRequest = { kind: 'hint' | 'demo'; lo: number; hi: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SolveRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const { kind, lo, hi } = e.data;
  const pegs: Bits = { lo, hi };
  const result = solve(pegs, {
    nodeBudget: kind === 'demo' ? DEMO_BUDGET : HINT_BUDGET,
  });
  ctx.postMessage({ kind, result });
};
