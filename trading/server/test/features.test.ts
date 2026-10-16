import { beforeEach, describe, expect, it } from 'vitest';
import type { FeeSchedule } from '../src/broker/fees.js';
import { PaperBroker } from '../src/broker/paperBroker.js';
import type { PaperConfig } from '../src/config.js';
import { buildJournal } from '../src/journal.js';
import { MarketClock } from '../src/market/clock.js';
import { BaseFeed } from '../src/market/feed.js';
import { applyFilter, type ScanRow } from '../src/market/scanner.js';
import type { Fill, Quote } from '../src/types.js';

class FakeFeed extends BaseFeed {
  readonly name = 'fake';
  async start() {}
  stop() {}
  quote(symbol: string, bid: number, ask: number) {
    this.publishQuote({ symbol, bid, ask, bidSize: 10_000, askSize: 10_000, last: (bid + ask) / 2, ts: Date.now() } as Quote);
  }
}

const noFees: FeeSchedule = { commissionPerShare: 0, minCommission: 0, maxCommissionPct: 0, secFeePerMillion: 0, tafPerShare: 0, tafMaxPerTrade: 0 };
const cfg: PaperConfig = {
  startingCash: 30_000, accountType: 'margin', marginModel: 'intraday', slippageBps: 0, fees: noFees, liquidityFraction: 1, maxQuoteDeviationBps: 0,
};

let feed: FakeFeed;
let broker: PaperBroker;
const now = Date.UTC(2026, 9, 14, 15, 0);

beforeEach(async () => {
  feed = new FakeFeed(['AAPL']);
  feed.quote('AAPL', 100, 100.02);
  const clock = new MarketClock(true, () => now);
  clock.state = () => ({ isOpen: true, nyDate: clock.nyDate(), minutesToClose: null, alwaysOpen: true, now });
  broker = new PaperBroker(feed, clock, cfg, undefined, () => now);
  await broker.start();
});

const stopLeg = async () => (await broker.getOrders('open')).find((o) => o.type === 'stop')!;

describe('modifyOrder', () => {
  it('moves a bracket stop to breakeven once price is above it', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', stopLoss: { stopPrice: 99 } });
    const sl = await stopLeg();
    // Not yet in profit: a sell stop at entry would sit above the bid and fire at once.
    await expect(broker.modifyOrder(sl.id, { stopPrice: 100.02 })).rejects.toThrow(/מתחת למחיר הביקוש/);
    feed.quote('AAPL', 101, 101.02);
    await broker.modifyOrder(sl.id, { stopPrice: 100.02 });
    expect((await stopLeg()).stopPrice).toBe(100.02);
  });

  it('rejects a limit price on a stop order', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', stopLoss: { stopPrice: 99 } });
    await expect(broker.modifyOrder((await stopLeg()).id, { limitPrice: 101 })).rejects.toThrow();
  });
});

describe('trailing stop', () => {
  it('follows the bid up, never down, then triggers', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', stopLoss: { stopPrice: 99 } });
    await broker.modifyOrder((await stopLeg()).id, { trailAmount: 0.5 });
    expect((await stopLeg()).stopPrice).toBe(99.5); // bid 100 - 0.50

    feed.quote('AAPL', 101, 101.02);
    expect((await stopLeg()).stopPrice).toBe(100.5);
    feed.quote('AAPL', 100.8, 100.82); // pullback: stop stays
    expect((await stopLeg()).stopPrice).toBe(100.5);

    feed.quote('AAPL', 100.4, 100.42); // through the stop
    expect((await broker.getPositions()).find((p) => p.symbol === 'AAPL')?.qty ?? 0).toBe(0);
  });
});

describe('journal', () => {
  const fill = (side: 'buy' | 'sell', qty: number, price: number, ts: number, orderId = `o${ts}`): Fill =>
    ({ id: `f${ts}`, orderId, symbol: 'AAPL', side, qty, price, commission: 1, fees: side === 'sell' ? 0.1 : 0, ts });

  it('builds round trips including scale-ins, partial exits and a flip', () => {
    const j = buildJournal([
      fill('buy', 10, 100, 1), fill('buy', 10, 102, 2), // long 20 @ 101
      fill('sell', 5, 103, 3), fill('sell', 15, 104, 4), // out @ 103.75 → +55 gross
      fill('sell', 10, 105, 5), fill('buy', 20, 104, 6), // short 10 @105, buy 20 covers 10 (+10) and opens long 10 @104
    ], []);
    expect(j.trades).toHaveLength(3);
    const [open, short, long] = j.trades; // newest first
    expect(long).toMatchObject({ direction: 'long', maxQty: 20, avgEntry: 101, avgExit: 103.75, grossPnl: 55, open: false });
    expect(long.costs).toBeCloseTo(4.2); // 4 commissions + 2 × 0.10 fees
    expect(short).toMatchObject({ direction: 'short', grossPnl: 10, open: false });
    expect(open).toMatchObject({ direction: 'long', open: true, avgEntry: 104 });
    expect(j.stats.trades).toBe(2);
    expect(j.stats.wins).toBe(2);
  });

  it('computes R from the entry bracket stop', () => {
    const j = buildJournal(
      [fill('buy', 10, 100, 1, 'entry'), fill('sell', 10, 102, 2)],
      [
        { id: 'entry', symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', tif: 'day', status: 'filled', filledQty: 10, avgFillPrice: 100, createdAt: 1, updatedAt: 1, legIds: ['sl'] },
        { id: 'sl', symbol: 'AAPL', side: 'sell', qty: 10, type: 'stop', stopPrice: 99, tif: 'day', status: 'canceled', filledQty: 0, avgFillPrice: 0, createdAt: 1, updatedAt: 1, parentId: 'entry' },
      ],
    );
    expect(j.trades[0].initialRisk).toBe(10);
    expect(j.trades[0].r).toBeCloseTo((20 - 2.1) / 10);
  });
});

describe('scanner filter', () => {
  const row = (symbol: string, price: number, changePct: number, gapPct: number, volume: number): ScanRow =>
    ({ symbol, name: symbol, price, changePct, gapPct, volume, high: price, low: price });
  const rows = [row('A', 5, 12, 8, 2e6), row('B', 50, -6, -1, 9e6), row('C', 0.8, 30, 20, 5e7), row('D', 20, 2, 0.5, 1e5)];

  it('filters by price, volume, change and direction, and sorts', () => {
    expect(applyFilter(rows, { minPrice: 1, minChangePct: 5 }).map((r) => r.symbol)).toEqual(['A', 'B']);
    expect(applyFilter(rows, { minPrice: 1, direction: 'down' }).map((r) => r.symbol)).toEqual(['B']);
    expect(applyFilter(rows, { minPrice: 1, sort: 'volume' }).map((r) => r.symbol)).toEqual(['B', 'A', 'D']);
    expect(applyFilter(rows, { minGapPct: 5, sort: 'gap' }).map((r) => r.symbol)).toEqual(['C', 'A']);
  });
});

describe('journal R after moving the stop', () => {
  it('keeps the initial risk when the stop is moved to breakeven', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', stopLoss: { stopPrice: 99 } });
    feed.quote('AAPL', 102, 102.02);
    const sl = (await broker.getOrders('open')).find((o) => o.type === 'stop')!;
    await broker.modifyOrder(sl.id, { stopPrice: 100.02 });
    await broker.closePosition('AAPL');
    const j = buildJournal((await broker.getFills()).reverse(), await broker.getOrders('all'));
    expect(j.trades[0].initialRisk).toBeCloseTo(10.2); // (100.02 - 99) × 10, not 0
    expect(j.trades[0].r).toBeCloseTo((102 - 100.02) * 10 / 10.2, 1);
  });
});
