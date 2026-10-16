// Run the live robot (bot/orbBot.ts) through recorded trading days, as fast as possible, using the
// real paper broker, risk manager and trading service. Compares with the backtest of the same days.
//   npm run replay -w server -- --date 2026-10-14 --date 2026-10-15 --date 2026-10-16
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrbBot } from '../bot/orbBot.js';
import { PaperBroker } from '../broker/paperBroker.js';
import { config } from '../config.js';
import { buildJournal } from '../journal.js';
import { MarketClock } from '../market/clock.js';
import { ReplayFeed, VirtualClock } from '../market/replayFeed.js';
import { alpacaSymbols, SymbolDirectory } from '../market/symbolDirectory.js';
import { DEFAULT_ORB, OPEN_MINUTE, selectCandidates } from '../strategy/orb.js';
import { TradingService } from '../tradingService.js';
import { AlpacaHistory } from './history.js';
import { simulateDay } from './simulate.js';
import { candidateRows, nyToUtc } from './universe.js';

const dates = process.argv.flatMap((a, i, all) => (a === '--date' ? [all[i + 1]] : []));
if (!dates.length) throw new Error('usage: --date YYYY-MM-DD [--date ...]');

const params = { ...DEFAULT_ORB, riskPerTrade: config.risk.maxRiskPerTrade || DEFAULT_ORB.riskPerTrade, maxPositionNotional: config.risk.maxPositionNotional };

async function runDay(date: string, history: AlpacaHistory, directory: SymbolDirectory, daily: Awaited<ReturnType<AlpacaHistory['daily']>>) {
  const names = new Map(directory.all().map((s) => [s.symbol, s.name]));
  const rows = candidateRows(daily, names, date);
  const open = nyToUtc(date, OPEN_MINUTE);
  const close = nyToUtc(date, 16 * 60);
  const vclock = new VirtualClock(open - 60_000, 0);
  const feed = new ReplayFeed([], date, vclock, (symbols) => history.minutes(symbols, date), false);
  const clock = new MarketClock(false, vclock.now);
  const broker = new PaperBroker(feed, clock, config.paper, undefined, vclock.now);
  const svc = new TradingService(feed, broker, clock, config.risk, directory);
  const bot = new OrbBot(svc, async () => rows, params, undefined, undefined, vclock.now);
  await svc.start();
  bot.setEnabled(true);

  // Step through the session every 15 seconds of market time (the recorded prints are 15 s apart).
  for (let t = open; t < close; t += 15_000) {
    vclock.set(t);
    feed.pump();
    await bot.tick();
    // The service's 5-minutes-before-close flatten runs on a real-time timer; do it here on market time.
    if (t >= nyToUtc(date, 15 * 60 + 55) && (await broker.getPositions()).some((p) => p.qty !== 0)) await broker.closeAll();
  }
  svc.stop();
  bot.stop();

  const journal = buildJournal(await broker.getFills(), await broker.getOrders('all'));
  const status = bot.status();

  // The backtest's view of the same day, for comparison.
  const candidates = selectCandidates(rows, params);
  const bt = candidates.length
    ? simulateDay(date, candidates, await history.minutes(candidates.map((c) => c.symbol), date), params, {
      fees: config.paper.fees, slippagePct: 0.0005, minSlippage: 0.01, buyingPower: config.paper.startingCash * 4,
    })
    : { trades: [] };
  return { date, status, journal, backtest: bt.trades };
}

async function main() {
  if (!config.alpaca.keyId) throw new Error('Replay needs Alpaca keys in .env');
  const history = new AlpacaHistory(config.alpaca, resolve(config.dataDir, 'backtest-cache'));
  const directory = new SymbolDirectory(alpacaSymbols(config.alpaca));
  await directory.load();
  const sorted = [...dates].sort();
  const daily = await history.daily(
    directory.all().map((s) => s.symbol),
    new Date(Date.parse(sorted[0]) - 45 * 86400_000).toISOString().slice(0, 10),
    sorted.at(-1)!,
  );

  const results = [];
  for (const date of sorted) {
    const r = await runDay(date, history, directory, daily);
    results.push(r);
    const net = r.journal.stats.netPnl;
    console.log(`\n=== ${date}: robot ${r.journal.trades.length} trades, net ${net.toFixed(2)} | backtest ${r.backtest.length} trades, net ${r.backtest.reduce((a, t) => a + t.netPnl, 0).toFixed(2)}`);
    for (const l of [...r.status.log].reverse()) console.log('  ', new Date(l.ts).toISOString().slice(11, 19), l.msg);
    for (const t of r.journal.trades) console.log(`   robot   ${t.symbol} ${t.direction} ${t.maxQty} @ ${t.avgEntry} → ${t.avgExit}  net ${t.netPnl}  R ${t.r ?? '-'}`);
    for (const t of r.backtest) console.log(`   backtest ${t.symbol} ${t.direction} ${t.maxQty} @ ${t.avgEntry} → ${t.avgExit}  net ${t.netPnl}  R ${t.r ?? '-'}`);
  }
  const dir = resolve(config.dataDir, 'backtest');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `replay-${sorted.join('_')}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1));
  console.log(`\nreport: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
