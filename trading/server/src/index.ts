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

const server = createApiServer(svc, { fees: config.paper.fees, risk: config.risk }, { movers, scan, news });
server.listen(config.port, () => {
  console.log(`DayTrader API on http://localhost:${config.port}  (data: ${feed.name}, broker: ${broker.name})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    svc.stop();
    server.close();
    process.exit(0);
  });
}
