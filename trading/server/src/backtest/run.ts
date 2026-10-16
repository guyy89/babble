// Backtest the opening-range breakout on Alpaca history.
//   npm run backtest -w server -- --from 2026-04-01 --to 2026-10-16
// Writes data/backtest/report-<from>-<to>.json and prints a summary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { bucket, stats, type JournalTrade } from '../journal.js';
import { alpacaSymbols } from '../market/symbolDirectory.js';
import { DEFAULT_ORB, selectCandidates, type OrbParams } from '../strategy/orb.js';
import { AlpacaHistory } from './history.js';
import { simulateDay, type DayResult } from './simulate.js';
import { candidateRows, dayKey } from './universe.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const today = new Date().toISOString().slice(0, 10);
const from = arg('from', new Date(Date.now() - 182 * 86400_000).toISOString().slice(0, 10));
const to = arg('to', today);
const params: OrbParams = { ...DEFAULT_ORB };

async function main() {
  if (config.dataSource !== 'alpaca' || !config.alpaca.keyId) throw new Error('The backtest needs Alpaca keys in .env (DATA_SOURCE=alpaca)');
  const history = new AlpacaHistory(config.alpaca, resolve(config.dataDir, 'backtest-cache'));

  const assets = await alpacaSymbols(config.alpaca)();
  const names = new Map(assets.map((a) => [a.symbol, a.name]));
  console.log(`universe: ${assets.length} listed symbols`);

  // 20 trading days of look-back for average volume (~30 calendar days, plus holidays).
  const lookbackStart = new Date(Date.parse(from) - 45 * 86400_000).toISOString().slice(0, 10);
  const daily = await history.daily(assets.map((a) => a.symbol), lookbackStart, to, (d, t) => process.stdout.write(`\rdaily bars ${d}/${t}`));
  process.stdout.write('\n');

  const dates = [...new Set(Object.values(daily).flatMap((bars) => bars.map((b) => dayKey(b.t))))]
    .filter((d) => d >= from && d <= to)
    .sort();

  const days: DayResult[] = [];
  for (const date of dates) {
    const candidates = selectCandidates(candidateRows(daily, names, date), params);
    if (!candidates.length) {
      days.push({ date, candidates, trades: [] });
      continue;
    }
    const minutes = await history.minutes(candidates.map((c) => c.symbol), date);
    const day = simulateDay(date, candidates, minutes, params, {
      fees: config.paper.fees, slippagePct: 0.0005, minSlippage: 0.01, buyingPower: config.paper.startingCash * 4,
    });
    days.push(day);
    const net = day.trades.reduce((a, t) => a + t.netPnl, 0);
    console.log(`${date}  candidates ${candidates.length}  trades ${day.trades.length}  net ${net.toFixed(2)}`);
  }

  const trades: JournalTrade[] = days.flatMap((d) => d.trades);
  const s = stats(trades);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const dailyPnl = days.map((d) => {
    const net = Math.round(d.trades.reduce((a, t) => a + t.netPnl, 0) * 100) / 100;
    equity += net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
    return { date: d.date, net, trades: d.trades.length, equity: Math.round(equity * 100) / 100 };
  });
  const traded = dailyPnl.filter((d) => d.trades > 0);
  const report = {
    from, to, params,
    summary: {
      ...s,
      days: days.length,
      tradingDays: traded.length,
      greenDays: traded.filter((d) => d.net > 0).length,
      redDays: traded.filter((d) => d.net < 0).length,
      avgPerDay: days.length ? Math.round((equity / days.length) * 100) / 100 : 0,
      bestDay: Math.max(0, ...dailyPnl.map((d) => d.net)),
      worstDay: Math.min(0, ...dailyPnl.map((d) => d.net)),
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      longs: trades.filter((t) => t.direction === 'long').length,
      shorts: trades.filter((t) => t.direction === 'short').length,
    },
    byHour: bucket(trades, (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t.openedAt)) + ':00'),
    dailyPnl,
    days,
  };
  const dir = resolve(config.dataDir, 'backtest');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `report-${from}-${to}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log('\nSUMMARY', JSON.stringify(report.summary, null, 1));
  console.log('by hour', JSON.stringify(report.byHour));
  console.log(`report: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
