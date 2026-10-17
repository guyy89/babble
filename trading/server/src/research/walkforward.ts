import { listDates } from './data.js';
import { metrics, type Metrics } from './evaluate.js';
import { DEFAULT_COSTS, rulesForRisk, simulateStrategyDay } from './sim.js';
import type { Costs, ResearchTrade, Rules, Strategy } from './types.js';

/**
 * Walk-forward over the last six months: six monthly windows; for each of the last four, the configuration
 * with the best total R over the previous two months (≥ minTrainTrades trades) is traded in that month.
 * The result measures the whole procedure "pick the best recent config, trade it next month", so in-sample
 * luck in choosing a config is paid for out-of-sample.
 */
export const MONTHS = [
  { name: 'M1', from: '2026-04-16', to: '2026-05-15' },
  { name: 'M2', from: '2026-05-16', to: '2026-06-15' },
  { name: 'M3', from: '2026-06-16', to: '2026-07-15' },
  { name: 'M4', from: '2026-07-16', to: '2026-08-15' },
  { name: 'M5', from: '2026-08-16', to: '2026-09-15' },
  { name: 'M6', from: '2026-09-16', to: '2026-10-16' },
] as const;
const TRAIN = 2;
const MIN_TRAIN_TRADES = 10;

export type Params = Record<string, unknown>;

/** Grid keys starting with "rule." set account rules (riskPerTrade picks the tier); the rest go to the strategy. */
export function splitParams(cfg: Params): { params: Params; rules: Rules } {
  const params: Params = {};
  const ov: Record<string, number> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('rule.')) ov[k.slice(5)] = Number(v);
    else params[k] = v;
  }
  const { riskPerTrade = 50, ...rest } = ov;
  return { params, rules: rulesForRisk(riskPerTrade, rest as Partial<Rules>) };
}

/** Run every configuration over every date, loading each day once (memory stays flat). */
export function runAll(strategy: Strategy<Params>, configs: Params[], from: string, to: string, costs: Costs = DEFAULT_COSTS, onDay?: (i: number, n: number) => void) {
  const dates = listDates(from, to);
  const split = configs.map(splitParams);
  const out: ResearchTrade[][] = configs.map(() => []);
  dates.forEach((d, i) => {
    split.forEach(({ params, rules }, c) => out[c].push(...simulateStrategyDay(d, strategy, params, rules, costs)));
    onDay?.(i + 1, dates.length);
  });
  return { dates, trades: out };
}

const inRange = (t: ResearchTrade, m: { from: string; to: string }) => t.date >= m.from && t.date <= m.to;
const sumR = (ts: ResearchTrade[]) => ts.reduce((a, t) => a + t.r, 0);

export interface WalkForward {
  selections: { month: string; config: number; trainR: number; trainTrades: number }[];
  trades: ResearchTrade[];
  perMonth: { month: string; trades: number; netR: number; net: number }[];
  metrics: Metrics;
  totalR: number;
  /** t-statistic of daily R over the test months (≥ 2 ≈ unlikely to be luck at the 2.5% level). */
  tStat: number;
}

export function walkForward(trades: ResearchTrade[][], dates: string[]): WalkForward {
  const selections: WalkForward['selections'] = [];
  const picked: ResearchTrade[] = [];
  const perMonth: WalkForward['perMonth'] = [];
  for (let k = TRAIN; k < MONTHS.length; k++) {
    const train = { from: MONTHS[k - TRAIN].from, to: MONTHS[k - 1].to };
    let best = -1, bestR = -Infinity, bestN = 0;
    trades.forEach((ts, c) => {
      const tr = ts.filter((t) => inRange(t, train));
      if (tr.length < MIN_TRAIN_TRADES) return;
      const r = sumR(tr);
      if (r > bestR) { bestR = r; best = c; bestN = tr.length; }
    });
    const month = MONTHS[k];
    const test = best >= 0 ? trades[best].filter((t) => inRange(t, month)) : [];
    selections.push({ month: month.name, config: best, trainR: Math.round(bestR * 100) / 100, trainTrades: bestN });
    picked.push(...test);
    perMonth.push({ month: month.name, trades: test.length, netR: Math.round(sumR(test) * 100) / 100, net: Math.round(test.reduce((a, t) => a + t.net, 0) * 100) / 100 });
  }
  const testDates = dates.filter((d) => d >= MONTHS[TRAIN].from);
  const daily = testDates.map((d) => picked.filter((t) => t.date === d).reduce((a, t) => a + t.r, 0));
  const mean = daily.reduce((a, b) => a + b, 0) / Math.max(1, daily.length);
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  return {
    selections, trades: picked, perMonth,
    metrics: metrics(picked, testDates, Infinity),
    totalR: Math.round(sumR(picked) * 100) / 100,
    tStat: sd > 0 ? Math.round((mean / sd) * Math.sqrt(daily.length) * 100) / 100 : 0,
  };
}

/** Pre-registered pass criteria for round 2 (all must hold). Profit is measured in R so risk tiers compare. */
export function acceptWF(wf: WalkForward, stressR: number) {
  const pf = wf.metrics.profitFactor;
  const checks = {
    'walk-forward total R > 0': wf.totalR > 0,
    'at least 3 of 4 test months positive': wf.perMonth.filter((m) => m.netR > 0).length >= 3,
    'profit factor ≥ 1.2': pf >= 1.2,
    '≥ 60 test trades': wf.trades.length >= 60,
    't-statistic ≥ 2': wf.tStat >= 2,
    'still positive with double costs': stressR > 0,
    'no single trade > 25% of profit': wf.metrics.topTradeShare <= 0.25,
    'no single symbol > 40% of profit': wf.metrics.topSymbolShare <= 0.4,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
