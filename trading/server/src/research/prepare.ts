// Builds the research dataset: a year of daily bars for the liquid universe and, for every trading
// day, regular-session 1-minute bars for ~40 symbols (the day's biggest gappers + the most liquid
// names + SPY/QQQ). Output (compact, read by research/data.ts):
//   data/research/daily.json            { symbol: [[t,o,h,l,c,v], ...] }
//   data/research/days/<date>.json      { meta: { symbol: DayMeta }, bars: { symbol: [[t,o,h,l,c,v], ...] } }
//   npm run research:prepare -w server -- --from 2025-10-16 --to 2026-10-16
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AlpacaHistory } from '../backtest/history.js';
import { candidateRows, dayKey } from '../backtest/universe.js';
import { config } from '../config.js';
import { alpacaSymbols } from '../market/symbolDirectory.js';
import type { Bar } from '../types.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const from = arg('from', '2025-10-16');
const to = arg('to', '2026-10-16');
const OUT = resolve(config.dataDir, 'research');
const LEVERAGED = /\b(\d(\.\d)?x|2x|3x|ultra|leveraged?|inverse|bull|bear|daily target)\b/i;
const NOT_COMMON = /\b(warrants?|rights?|units?|preferred|notes?)\b/i;

type Row = [number, number, number, number, number, number];
const compact = (bars: Bar[]): Row[] => bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);

async function main() {
  const history = new AlpacaHistory(config.alpaca, resolve(config.dataDir, 'backtest-cache'));
  const assets = await alpacaSymbols(config.alpaca)();
  const names = new Map(assets.map((a) => [a.symbol, a.name]));

  // 1. Liquid universe from the cached 6-month download (IEX volume), so the year download stays small.
  const cacheDir = resolve(config.dataDir, 'backtest-cache');
  const big = readdirSync(cacheDir).find((f) => f.startsWith('daily-') && f.endsWith(`-${assets.length}.json`));
  if (!big) throw new Error('run the backtest first (it caches the full daily universe)');
  const recent = JSON.parse(readFileSync(resolve(cacheDir, big), 'utf8')) as Record<string, Bar[]>;
  const universe = Object.entries(recent).filter(([s, bars]) => {
    if (!bars.length) return false;
    const vols = bars.map((b) => b.v).sort((a, b) => a - b);
    const median = vols[Math.floor(vols.length / 2)];
    const name = names.get(s) ?? '';
    return median >= 30_000 && bars.some((b) => b.c >= 3 && b.c <= 1000) && !NOT_COMMON.test(name);
  }).map(([s]) => s);
  for (const s of ['SPY', 'QQQ']) if (!universe.includes(s)) universe.push(s);
  console.log(`liquid universe: ${universe.length} symbols`);

  // 2. A year (+45 days look-back) of daily bars for it.
  const lookback = new Date(Date.parse(from) - 45 * 86400_000).toISOString().slice(0, 10);
  const daily = await history.daily(universe, lookback, to, (d, t) => process.stdout.write(`\rdaily ${d}/${t}`));
  process.stdout.write('\n');
  mkdirSync(resolve(OUT, 'days'), { recursive: true });
  writeFileSync(resolve(OUT, 'daily.json'), JSON.stringify(Object.fromEntries(Object.entries(daily).map(([s, b]) => [s, compact(b)]))));
  writeFileSync(resolve(OUT, 'names.json'), JSON.stringify(Object.fromEntries(universe.map((s) => [s, names.get(s) ?? s]))));

  // 3. Per day: ~25 biggest gappers + ~15 most liquid + SPY/QQQ, regular-session minute bars.
  const dates = (daily.SPY ?? []).map((b) => dayKey(b.t)).filter((d) => d >= from && d <= to);
  let n = 0;
  for (const date of dates) {
    const file = resolve(OUT, 'days', `${date}.json`);
    n++;
    if (existsSync(file)) continue;
    const rows = candidateRows(daily, names, date).filter((r) => r.prevClose > 0);
    const meta = new Map(rows.map((r) => [r.symbol, { ...r, gapPct: ((r.open - r.prevClose) / r.prevClose) * 100, tags: [] as string[] }]));
    const gappers = rows
      .filter((r) => r.open >= 5 && r.open <= 150 && r.avgVolume >= 50_000 && !LEVERAGED.test(r.name))
      .sort((a, b) => Math.abs(meta.get(b.symbol)!.gapPct) - Math.abs(meta.get(a.symbol)!.gapPct))
      .slice(0, 25);
    const liquid = rows
      .filter((r) => r.open >= 5 && !LEVERAGED.test(r.name))
      .sort((a, b) => b.avgVolume * b.open - a.avgVolume * a.open)
      .slice(0, 15);
    for (const r of gappers) meta.get(r.symbol)!.tags.push('gap');
    for (const r of liquid) meta.get(r.symbol)!.tags.push('liquid');
    for (const s of ['SPY', 'QQQ']) meta.get(s)?.tags.push('index');
    const symbols = [...meta.values()].filter((m) => m.tags.length).map((m) => m.symbol);
    const bars = await history.minutesRange(symbols, `${date}T13:00:00Z`, `${date}T21:30:00Z`);
    writeFileSync(file, JSON.stringify({
      meta: Object.fromEntries(symbols.map((s) => [s, meta.get(s)])),
      bars: Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, compact(b)])),
    }));
    process.stdout.write(`\rday ${n}/${dates.length} ${date} symbols ${symbols.length}   `);
  }
  process.stdout.write('\ndone\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
