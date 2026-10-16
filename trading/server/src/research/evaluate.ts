import { listDates } from './data.js';
import { DEFAULT_COSTS, DEFAULT_RULES, simulateStrategyDay } from './sim.js';
import type { Costs, ResearchTrade, Rules, Strategy } from './types.js';

/** Fixed periods. Tune ONLY on in-sample; out-of-sample is for a one-time check of chosen configs. */
export const PERIODS = {
  inSample: { from: '2025-10-16', to: '2026-04-15' },
  outOfSample: { from: '2026-04-16', to: '2026-10-16' },
  oosA: { from: '2026-04-16', to: '2026-07-15' },
  oosB: { from: '2026-07-16', to: '2026-10-16' },
} as const;

export interface Metrics {
  days: number;
  trades: number;
  winRate: number;
  net: number;
  gross: number;
  costs: number;
  avgNetPerTrade: number;
  avgR: number;
  profitFactor: number;
  avgPerDay: number;
  greenDayRate: number;
  worstDay: number;
  maxDrawdown: number;
  /** Annualised mean/stdev of daily net P&L. */
  sharpe: number;
  /** Largest single trade's share of total net profit (high = result hangs on one trade). */
  topTradeShare: number;
  /** Share of net profit from the best symbol. */
  topSymbolShare: number;
  /** Days on which the net loss exceeded the daily limit (should be ~0 with the risk guard). */
  daysOverLimit: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function metrics(trades: ResearchTrade[], dates: string[], dailyLimit = DEFAULT_RULES.dailyLossLimit): Metrics {
  const byDay = new Map(dates.map((d) => [d, 0]));
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net);
  const daily = [...byDay.values()];
  let eq = 0, peak = 0, dd = 0;
  for (const d of daily) { eq += d; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const net = trades.reduce((a, t) => a + t.net, 0);
  const winsSum = trades.filter((t) => t.net > 0).reduce((a, t) => a + t.net, 0);
  const lossSum = -trades.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0);
  const mean = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  const bySym = new Map<string, number>();
  for (const t of trades) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.net);
  const traded = daily.filter((_, i) => trades.some((t) => t.date === dates[i]));
  return {
    days: dates.length,
    trades: trades.length,
    winRate: trades.length ? r2(trades.filter((t) => t.net > 0).length / trades.length) : 0,
    net: r2(net),
    gross: r2(trades.reduce((a, t) => a + t.gross, 0)),
    costs: r2(trades.reduce((a, t) => a + t.costs, 0)),
    avgNetPerTrade: trades.length ? r2(net / trades.length) : 0,
    avgR: trades.length ? r2(trades.reduce((a, t) => a + t.r, 0) / trades.length) : 0,
    profitFactor: lossSum > 0 ? r2(winsSum / lossSum) : winsSum > 0 ? 99 : 0,
    avgPerDay: dates.length ? r2(net / dates.length) : 0,
    greenDayRate: traded.length ? r2(traded.filter((d) => d > 0).length / traded.length) : 0,
    worstDay: r2(Math.min(0, ...daily)),
    maxDrawdown: r2(dd),
    sharpe: sd > 0 ? r2((mean / sd) * Math.sqrt(252)) : 0,
    topTradeShare: net > 0 ? r2(Math.max(...trades.map((t) => t.net)) / net) : 1,
    topSymbolShare: net > 0 ? r2(Math.max(...bySym.values()) / net) : 1,
    daysOverLimit: daily.filter((d) => d < -dailyLimit * 1.1).length,
  };
}

export function runPeriod<P extends object>(strategy: Strategy<P>, params: P, period: { from: string; to: string }, rules: Rules = DEFAULT_RULES, costs: Costs = DEFAULT_COSTS) {
  const dates = listDates(period.from, period.to);
  const trades = dates.flatMap((d) => simulateStrategyDay(d, strategy, params, rules, costs));
  return { trades, metrics: metrics(trades, dates, rules.dailyLossLimit) };
}

/** Pre-registered acceptance criteria for a strategy configuration (all must hold). */
export function accept(is: Metrics, oos: Metrics, oosA: Metrics, oosB: Metrics, stress: Metrics) {
  const checks = {
    'in-sample net > 0': is.net > 0,
    'out-of-sample net > 0': oos.net > 0,
    'out-of-sample profit factor ≥ 1.15': oos.profitFactor >= 1.15,
    'out-of-sample ≥ 60 trades': oos.trades >= 60,
    'both out-of-sample quarters profitable': oosA.net > 0 && oosB.net > 0,
    'still profitable with double costs (out-of-sample)': stress.net > 0,
    'no single trade > 25% of profit': oos.topTradeShare <= 0.25,
    'no single symbol > 40% of profit': oos.topSymbolShare <= 0.4,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
