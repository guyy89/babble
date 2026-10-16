import { resolve } from 'node:path';
import { createApiServer } from './api/server.js';
import { AlpacaHistory } from './backtest/history.js';
import { candidateRows, nyToUtc } from './backtest/universe.js';
import { OrbBot, type BotState } from './bot/orbBot.js';
import { JsonFileStore } from './broker/stateStore.js';
import { PaperBroker, type PaperState } from './broker/paperBroker.js';
import { config } from './config.js';
import { AlpacaFeed } from './market/alpacaFeed.js';
import { MarketClock } from './market/clock.js';
import type { MarketDataFeed } from './market/feed.js';
import { alpacaMovers, simMovers } from './market/movers.js';
import { ReplayFeed, VirtualClock } from './market/replayFeed.js';
import { alpacaScanner, simScanner } from './market/scanner.js';
import { SimFeed } from './market/simFeed.js';
import { alpacaSymbols, simSymbols, SymbolDirectory } from './market/symbolDirectory.js';
import { DEFAULT_ORB, OPEN_MINUTE, type CandidateInput } from './strategy/orb.js';
import { TradingService } from './tradingService.js';

const simulated = config.dataSource === 'sim';
const replaying = config.dataSource === 'replay';

// The watchlist is edited from the UI and kept per data source; SYMBOLS is only the first-run default.
const watchlistStore = new JsonFileStore<string[]>(resolve(config.dataDir, `watchlist-${config.dataSource}.json`));
const symbols = watchlistStore.load() ?? config.symbols;
const history = simulated ? undefined : new AlpacaHistory(config.alpaca, resolve(config.dataDir, 'backtest-cache'));

// Replay: a recorded day played back on a virtual clock that starts a minute before the open.
const vclock = replaying ? new VirtualClock(nyToUtc(config.replay.date, OPEN_MINUTE) - 60_000, config.replay.speed) : undefined;
const now = vclock?.now ?? Date.now;

const alpaca = !simulated && !replaying ? new AlpacaFeed(symbols, config.alpaca) : undefined;
const replay = replaying ? new ReplayFeed(symbols, config.replay.date, vclock!, (s) => history!.minutes(s, config.replay.date), true) : undefined;
const feed: MarketDataFeed = alpaca ?? replay ?? new SimFeed(symbols);

const directory = new SymbolDirectory(simulated ? simSymbols : alpacaSymbols(config.alpaca));
await directory.load();
const movers = alpaca ? alpacaMovers(config.alpaca, directory) : simMovers(feed, directory);
const scan = alpaca ? alpacaScanner(config.alpaca, directory, (s) => alpaca.snapshots(s)) : simScanner(feed, directory);
const news = alpaca ? (symbol: string) => alpaca.news(symbol) : async () => [];

// Synthetic data has no session, so the simulated market never closes.
const clock = new MarketClock(simulated, now);

// A replay always starts from a fresh account; the other modes keep their account between runs.
const store = replaying ? undefined : new JsonFileStore<PaperState>(resolve(config.dataDir, `paper-${config.dataSource}.json`));
const broker = new PaperBroker(feed, clock, config.paper, store, now);

const svc = new TradingService(feed, broker, clock, config.risk, directory, watchlistStore);
await svc.start();

// ---------------------------------------------------------------- strategy robot (paper only, real data only)
const orbParams = { ...DEFAULT_ORB, riskPerTrade: config.risk.maxRiskPerTrade || DEFAULT_ORB.riskPerTrade, maxPositionNotional: config.risk.maxPositionNotional };
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const allSymbols = () => directory.all().map((s) => s.symbol);

/** Live: yesterday's close and 20-day average volume from daily bars, today's open from snapshots. */
async function liveUniverse(): Promise<CandidateInput[]> {
  if (!alpaca || !history) return [];
  const today = clock.nyDate();
  const yesterday = ymd(Date.parse(today) - 86400_000);
  const daily = await history.daily(allSymbols(), ymd(Date.parse(today) - 45 * 86400_000), yesterday);
  const pre = Object.entries(daily).flatMap(([symbol, bars]) => {
    const prev = bars.filter((b) => ymd(b.t) < today).slice(-20);
    const last = prev.at(-1);
    if (!last || prev.length < 5) return [];
    const avgVolume = prev.reduce((a, b) => a + b.v, 0) / prev.length;
    // Loose pre-filter on yesterday's close; the exact price rule uses today's open below.
    if (avgVolume < orbParams.minAvgVolume || last.c < orbParams.minPrice * 0.6 || last.c > orbParams.maxPrice * 1.5) return [];
    return [{ symbol, prevClose: last.c, avgVolume }];
  });
  const snaps = await alpaca.snapshots(pre.map((p) => p.symbol));
  return pre.flatMap((p) => {
    const d = snaps[p.symbol]?.dailyBar;
    if (!d?.t || ymd(Date.parse(d.t)) !== today) return [];
    return [{ ...p, name: directory.get(p.symbol)?.name ?? p.symbol, open: d.o }];
  });
}

/** Replay: the same inputs for the recorded date, from cached daily bars. */
async function replayUniverse(): Promise<CandidateInput[]> {
  const date = config.replay.date;
  const daily = await history!.daily(allSymbols(), ymd(Date.parse(date) - 45 * 86400_000), date);
  return candidateRows(daily, new Map(directory.all().map((s) => [s.symbol, s.name])), date);
}

const botUnavailable = simulated
  ? 'הרובוט עובד רק עם נתוני שוק אמיתיים (אלפקה או הקלטה)'
  : broker.name !== 'paper' ? 'הרובוט פועל רק בחשבון התרגול' : undefined;
const bot = new OrbBot(
  svc, replaying ? replayUniverse : liveUniverse, orbParams,
  replaying ? undefined : new JsonFileStore<BotState>(resolve(config.dataDir, 'bot.json')),
  botUnavailable, now,
);
// In a sped-up replay the robot must act at the same market-time cadence as live (every 5 market seconds).
bot.start(replaying ? Math.max(50, 5000 / Math.max(1, config.replay.speed)) : 5000);

const server = createApiServer(svc, { fees: config.paper.fees, risk: config.risk }, { movers, scan, news }, bot,
  replaying ? { date: config.replay.date, speed: config.replay.speed } : undefined);
server.listen(config.port, () => {
  const mode = replaying ? `replay ${config.replay.date} x${config.replay.speed}` : feed.name;
  console.log(`DayTrader API on http://localhost:${config.port}  (data: ${mode}, broker: ${broker.name})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bot.stop();
    svc.stop();
    server.close();
    process.exit(0);
  });
}
