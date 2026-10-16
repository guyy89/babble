import { resolve } from 'node:path';
import { createApiServer } from './api/server.js';
import { JsonFileStore } from './broker/stateStore.js';
import { PaperBroker, type PaperState } from './broker/paperBroker.js';
import { config } from './config.js';
import { AlpacaFeed } from './market/alpacaFeed.js';
import { MarketClock } from './market/clock.js';
import type { MarketDataFeed } from './market/feed.js';
import { alpacaMovers, simMovers } from './market/movers.js';
import { alpacaScanner, simScanner } from './market/scanner.js';
import { SimFeed } from './market/simFeed.js';
import { alpacaSymbols, simSymbols, SymbolDirectory } from './market/symbolDirectory.js';
import { TradingService } from './tradingService.js';
import { AlpacaHistory } from './backtest/history.js';
import { OrbBot, type BotState } from './bot/orbBot.js';
import { DEFAULT_ORB, type CandidateInput } from './strategy/orb.js';

const simulated = config.dataSource === 'sim';

// The watchlist is edited from the UI and kept per data source; SYMBOLS is only the first-run default.
const watchlistStore = new JsonFileStore<string[]>(resolve(config.dataDir, `watchlist-${config.dataSource}.json`));
const symbols = watchlistStore.load() ?? config.symbols;

const alpaca = simulated ? undefined : new AlpacaFeed(symbols, config.alpaca);
const feed: MarketDataFeed = alpaca ?? new SimFeed(symbols);

const directory = new SymbolDirectory(simulated ? simSymbols : alpacaSymbols(config.alpaca));
await directory.load();
const movers = alpaca ? alpacaMovers(config.alpaca, directory) : simMovers(feed, directory);
const scan = alpaca ? alpacaScanner(config.alpaca, directory, (s) => alpaca.snapshots(s)) : simScanner(feed, directory);
const news = alpaca ? (symbol: string) => alpaca.news(symbol) : async () => [];

// Synthetic data has no session, so the simulated market never closes.
const clock = new MarketClock(simulated);

const store = new JsonFileStore<PaperState>(resolve(config.dataDir, `paper-${config.dataSource}.json`));
const broker = new PaperBroker(feed, clock, config.paper, store);

const svc = new TradingService(feed, broker, clock, config.risk, directory, watchlistStore);
await svc.start();

// ---------------------------------------------------------------- strategy robot (paper only, real data only)
const orbParams = { ...DEFAULT_ORB, riskPerTrade: config.risk.maxRiskPerTrade || DEFAULT_ORB.riskPerTrade, maxPositionNotional: config.risk.maxPositionNotional };
const history = alpaca ? new AlpacaHistory(config.alpaca, resolve(config.dataDir, 'backtest-cache')) : undefined;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Yesterday's close and 20-day average volume from daily bars, today's open from snapshots. */
async function orbUniverse(): Promise<CandidateInput[]> {
  if (!alpaca || !history) return [];
  const today = clock.nyDate();
  const yesterday = ymd(Date.parse(today) - 86400_000);
  const daily = await history.daily(directory.all().map((s) => s.symbol), ymd(Date.parse(today) - 45 * 86400_000), yesterday);
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

const botUnavailable = !alpaca
  ? 'הרובוט עובד רק עם נתוני שוק אמיתיים (אלפקה)'
  : broker.name !== 'paper' ? 'הרובוט פועל רק בחשבון התרגול' : undefined;
const bot = new OrbBot(svc, orbUniverse, orbParams, new JsonFileStore<BotState>(resolve(config.dataDir, 'bot.json')), botUnavailable);
bot.start();
// Warm the daily-bar cache in the background so the 09:45 selection is quick.
if (alpaca && history) {
  const today = clock.nyDate();
  void history.daily(directory.all().map((s) => s.symbol), ymd(Date.parse(today) - 45 * 86400_000), ymd(Date.parse(today) - 86400_000))
    .catch((err) => console.error('[bot] daily warm-up failed:', err));
}

const server = createApiServer(svc, { fees: config.paper.fees, risk: config.risk }, { movers, scan, news }, bot);
server.listen(config.port, () => {
  console.log(`DayTrader API on http://localhost:${config.port}  (data: ${feed.name}, broker: ${broker.name})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    bot.stop();
    svc.stop();
    server.close();
    process.exit(0);
  });
}
