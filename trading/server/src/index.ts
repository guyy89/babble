import { resolve } from 'node:path';
import { createApiServer } from './api/server.js';
import { JsonFileStore } from './broker/stateStore.js';
import { PaperBroker, type PaperState } from './broker/paperBroker.js';
import { config } from './config.js';
import { AlpacaFeed } from './market/alpacaFeed.js';
import { MarketClock } from './market/clock.js';
import type { MarketDataFeed } from './market/feed.js';
import { SimFeed } from './market/simFeed.js';
import { TradingService } from './tradingService.js';

const simulated = config.dataSource === 'sim';

const feed: MarketDataFeed = simulated
  ? new SimFeed(config.symbols)
  : new AlpacaFeed(config.symbols, config.alpaca);

// Synthetic data has no session, so the simulated market never closes.
const clock = new MarketClock(simulated);

const store = new JsonFileStore<PaperState>(resolve(config.dataDir, `paper-${config.dataSource}.json`));
const broker = new PaperBroker(feed, clock, config.paper, store);

const svc = new TradingService(feed, broker, clock, config.risk);
await svc.start();

const server = createApiServer(svc);
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
