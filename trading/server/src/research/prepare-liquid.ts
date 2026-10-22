// Builds a liquid-names-only research dataset (consolidated SIP data) for a date range, in the format
// research/data.ts reads: <dir>/daily.json, names.json and days/<date>.json. Each day holds the 20 most
// liquid stocks by 20-day average $ volume × that day's open (the same rule prepare.ts uses for the 'liquid'
// tag), plus SPY/QQQ ('index'). Built for out-of-sample checks of the momentum robot (r2_xsmom).
//   tsx src/research/prepare-liquid.ts --from 2024-04-16 --to 2026-04-15 --out research-xs2y
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AlpacaHistory } from '../backtest/history.js';
import { dayKey } from '../backtest/universe.js';
import { config } from '../config.js';
import { alpacaSymbols } from '../market/symbolDirectory.js';
import type { Bar } from '../types.js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const from = arg('from', '2024-04-16'), to = arg('to', '2026-04-15');
const OUT = resolve(config.dataDir, arg('out', 'research-xs2y'));
const N_LIQUID = Number(arg('liquid', '20'));
const CONCURRENCY = Number(arg('parallel', '4'));
const LEVERAGED = /\b(\d(\.\d)?x|2x|3x|ultra|leveraged?|inverse|bull|bear|daily target)\b/i;
const NOT_COMMON = /\b(warrants?|rights?|units?|preferred|notes?)\b/i;

type Row = [number, number, number, number, number, number];
const compact = (bars: Bar[]): Row[] => bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const sip = new AlpacaHistory({ ...config.alpaca, feed: 'sip' }, resolve(config.dataDir, 'backtest-cache'));
  const assets = await alpacaSymbols(config.alpaca)();
  const names = new Map(assets.map((a) => [a.symbol, a.name]));
  const symbols = assets.map((a) => a.symbol).filter((s) => !NOT_COMMON.test(names.get(s) ?? ''));
  console.log(`assets: ${symbols.length}`);

  // 1. Daily SIP bars for every listed symbol, with 45 days of look-back for the 20-day average and ATR.
  const lookback = ymd(Date.parse(from) - 45 * 86400_000);
  const t0 = Date.now();
  const daily: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += 200) {
    Object.assign(daily, await sip.dailyUncached(symbols.slice(i, i + 200), lookback, to));
    process.stdout.write(`\rdaily ${Math.min(i + 200, symbols.length)}/${symbols.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  process.stdout.write('\n');

  // 2. Per trading day: the liquid top N (+ SPY/QQQ).
  const dates = (daily.SPY ?? []).map((b) => dayKey(b.t)).filter((d) => d >= from && d <= to);
  const index = new Map(Object.entries(daily).map(([s, bars]) => [s, new Map(bars.map((b, i) => [dayKey(b.t), i]))]));
  const plan = dates.map((date) => {
    const rows: { symbol: string; name: string; open: number; prevClose: number; avgVolume: number }[] = [];
    for (const [symbol, bars] of Object.entries(daily)) {
      const i = index.get(symbol)!.get(date) ?? -1;
      if (i < 1) continue;
      const prev = bars.slice(Math.max(0, i - 20), i);
      rows.push({ symbol, name: names.get(symbol) ?? symbol, open: bars[i].o, prevClose: bars[i - 1].c, avgVolume: prev.reduce((a, b) => a + b.v, 0) / prev.length });
    }
    const liquid = rows.filter((r) => r.open >= 5 && !LEVERAGED.test(r.name)).sort((a, b) => b.avgVolume * b.open - a.avgVolume * a.open).slice(0, N_LIQUID);
    const meta: Record<string, { symbol: string; name: string; open: number; prevClose: number; avgVolume: number; gapPct: number; tags: string[] }> = {};
    for (const r of liquid) meta[r.symbol] = { ...r, gapPct: ((r.open - r.prevClose) / r.prevClose) * 100, tags: ['liquid'] };
    for (const s of ['SPY', 'QQQ']) {
      const r = rows.find((x) => x.symbol === s);
      if (r) (meta[s] ??= { ...r, gapPct: ((r.open - r.prevClose) / r.prevClose) * 100, tags: [] }).tags.push('index');
    }
    return { date, meta };
  });

  // 3. Daily file only for symbols that are ever in a day's dataset (the strategies read their history).
  const used = new Set(plan.flatMap((p) => Object.keys(p.meta)));
  mkdirSync(resolve(OUT, 'days'), { recursive: true });
  writeFileSync(resolve(OUT, 'daily.json'), JSON.stringify(Object.fromEntries([...used].map((s) => [s, compact(daily[s] ?? [])]))));
  writeFileSync(resolve(OUT, 'names.json'), JSON.stringify(Object.fromEntries([...used].map((s) => [s, names.get(s) ?? s]))));
  console.log(`days: ${plan.length}, distinct symbols: ${used.size}`);

  // 4. Regular-session 1-minute bars per day, a few days in parallel (the history client retries on 429).
  let done = 0;
  const queue = [...plan];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const file = resolve(OUT, 'days', `${p.date}.json`);
      if (!existsSync(file)) {
        const bars = await (sip as unknown as { bars(s: string[], tf: string, a: string, b: string): Promise<Record<string, Bar[]>> })
          .bars(Object.keys(p.meta), '1Min', `${p.date}T13:00:00Z`, `${p.date}T21:30:00Z`);
        writeFileSync(file, JSON.stringify({ meta: p.meta, bars: Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, compact(b)])) }));
      }
      done++;
      process.stdout.write(`\rminutes ${done}/${plan.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\ndone\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
