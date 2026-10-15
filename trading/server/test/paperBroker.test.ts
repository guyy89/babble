import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker, lastBusinessDays } from '../src/broker/paperBroker.js';
import type { PaperConfig } from '../src/config.js';
import { MarketClock } from '../src/market/clock.js';
import { BaseFeed } from '../src/market/feed.js';
import { RiskManager } from '../src/risk/riskManager.js';
import type { Quote } from '../src/types.js';

class FakeFeed extends BaseFeed {
  readonly name = 'fake';
  async start() {}
  stop() {}
  quote(symbol: string, bid: number, ask: number, size = 10_000) {
    this.publishQuote({ symbol, bid, ask, bidSize: size, askSize: size, last: (bid + ask) / 2, ts: Date.now() } as Quote);
  }
}

const cfg: PaperConfig = {
  startingCash: 30_000,
  accountType: 'margin',
  slippageBps: 0,
  commissionPerShare: 0,
  minCommission: 0,
  liquidityFraction: 1,
};

let feed: FakeFeed;
let broker: PaperBroker;
let open: boolean;
let now: number;

function makeBroker(overrides: Partial<PaperConfig> = {}) {
  const clock = new MarketClock(true, () => now);
  // Allow tests to close the market by toggling `open`.
  clock.state = () => ({ isOpen: open, nyDate: clock.nyDate(), minutesToClose: null, alwaysOpen: true });
  broker = new PaperBroker(feed, clock, { ...cfg, ...overrides }, undefined, () => now);
  return broker.start();
}

beforeEach(async () => {
  feed = new FakeFeed(['AAPL']);
  open = true;
  now = Date.UTC(2026, 9, 14, 15, 0); // Wed 11:00 NY
  feed.quote('AAPL', 100.0, 100.02);
  await makeBroker();
});

describe('market orders', () => {
  it('buys at the ask and updates cash and position', async () => {
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' });
    expect(o.status).toBe('filled');
    expect(o.avgFillPrice).toBe(100.02);
    const [p] = await broker.getPositions();
    expect(p).toMatchObject({ symbol: 'AAPL', qty: 10, avgPrice: 100.02 });
    expect((await broker.getAccount()).cash).toBeCloseTo(30_000 - 1000.2, 6);
  });

  it('applies slippage and commission', async () => {
    feed = new FakeFeed(['AAPL']);
    feed.quote('AAPL', 100, 100);
    await makeBroker({ slippageBps: 10, commissionPerShare: 0.005, minCommission: 1 });
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 100, type: 'market' });
    expect(o.avgFillPrice).toBe(100.1);
    const acct = await broker.getAccount();
    expect(acct.commissionsToday).toBe(1);
    expect(acct.cash).toBeCloseTo(30_000 - 10_010 - 1, 6);
  });

  it('fills partially when displayed size is smaller than the order', async () => {
    feed.quote('AAPL', 100, 100.02, 300);
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1000, type: 'market' });
    expect(o.status).toBe('partially_filled');
    expect(o.filledQty).toBe(300);
    feed.quote('AAPL', 100.01, 100.03, 800);
    const [after] = await broker.getOrders('all');
    expect(after.status).toBe('filled');
    expect(after.avgFillPrice).toBeCloseTo((300 * 100.02 + 700 * 100.03) / 1000, 6);
  });

  it('rejects market orders while the market is closed', async () => {
    open = false;
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' });
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toMatch(/closed/);
  });
});

describe('limit and stop orders', () => {
  it('resting limit needs the market to trade through', async () => {
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 99.5 });
    expect(o.status).toBe('new');
    feed.quote('AAPL', 99.48, 99.5); // touches the limit: no fill (no queue priority)
    expect((await broker.getOrders())[0].status).toBe('new');
    feed.quote('AAPL', 99.45, 99.49); // through
    const filled = (await broker.getOrders())[0];
    expect(filled.status).toBe('filled');
    expect(filled.avgFillPrice).toBe(99.49);
  });

  it('marketable limit fills immediately at the touch', async () => {
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 101 });
    expect(o.status).toBe('filled');
    expect(o.avgFillPrice).toBe(100.02);
  });

  it('sell stop triggers on the bid and fills like a market order', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' });
    const stop = await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 10, type: 'stop', stopPrice: 99 });
    expect(stop.status).toBe('new');
    feed.quote('AAPL', 98.9, 98.95);
    const o = (await broker.getOrders()).find((x) => x.id === stop.id)!;
    expect(o.status).toBe('filled');
    expect(o.avgFillPrice).toBe(98.9);
    expect((await broker.getPositions())[0].realizedPnlToday).toBeCloseTo(10 * (98.9 - 100.02), 6);
  });

  it('rejects a stop on the wrong side of the market', async () => {
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1, type: 'stop', stopPrice: 101 });
    expect(o.status).toBe('rejected');
  });

  it('rejects sub-penny prices', async () => {
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limitPrice: 99.555 });
    expect(o.status).toBe('rejected');
  });
});

describe('bracket orders', () => {
  it('activates exits after entry and cancels the sibling when one fills', async () => {
    const entry = await broker.submitOrder({
      symbol: 'AAPL', side: 'buy', qty: 10, type: 'market',
      takeProfit: { limitPrice: 101 }, stopLoss: { stopPrice: 99 },
    });
    expect(entry.status).toBe('filled');
    const legs = (await broker.getOrders('open')).filter((o) => o.parentId === entry.id);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.status === 'new' && l.qty === 10)).toBe(true);

    feed.quote('AAPL', 101.05, 101.07); // through the take-profit
    const all = await broker.getOrders();
    expect(all.find((o) => o.type === 'limit' && o.parentId)!.status).toBe('filled');
    expect(all.find((o) => o.type === 'stop' && o.parentId)!.status).toBe('canceled');
    expect((await broker.getPositions())[0].qty).toBe(0);
  });

  it('keeps legs held until the entry fills and cancels them with it', async () => {
    const entry = await broker.submitOrder({
      symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 99.5,
      takeProfit: { limitPrice: 101 }, stopLoss: { stopPrice: 99 },
    });
    expect((await broker.getOrders('open')).filter((o) => o.status === 'held')).toHaveLength(2);
    await broker.cancelOrder(entry.id);
    expect(await broker.getOrders('open')).toHaveLength(0);
  });

  it('validates bracket prices against the entry', async () => {
    const o = await broker.submitOrder({
      symbol: 'AAPL', side: 'buy', qty: 10, type: 'market', stopLoss: { stopPrice: 100.5 },
    });
    expect(o.status).toBe('rejected');
  });
});

describe('short selling and accounting', () => {
  it('handles a short and covers with correct P&L', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 10, type: 'market' }); // short at 100.00
    feed.quote('AAPL', 98, 98.02);
    expect((await broker.getAccount()).dayPnl).toBeCloseTo(10 * (100 - 98.01), 6);
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' }); // cover at 98.02
    const acct = await broker.getAccount();
    expect(acct.realizedPnlToday).toBeCloseTo(10 * (100 - 98.02), 6);
    expect(acct.cash).toBeCloseTo(30_000 + 19.8, 6);
  });

  it('flips from long to short through zero', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' });
    await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 25, type: 'market' });
    const [p] = await broker.getPositions();
    expect(p.qty).toBe(-15);
    expect(p.avgPrice).toBe(100);
  });

  it('does not allow shorting in a cash account', async () => {
    await makeBroker({ accountType: 'cash' });
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1, type: 'market' });
    expect(o.status).toBe('rejected');
  });
});

describe('buying power and PDT', () => {
  it('rejects orders beyond buying power', async () => {
    await makeBroker({ accountType: 'cash', startingCash: 1000 });
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 20, type: 'market' });
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toMatch(/buying power/);
  });

  it('counts buying power reserved by working orders', async () => {
    await makeBroker({ accountType: 'cash', startingCash: 1500 });
    expect((await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 99 })).status).toBe('new');
    const second = await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 99 });
    expect(second.status).toBe('rejected');
  });

  it('blocks a 4th day trade under $25k equity', async () => {
    await makeBroker({ startingCash: 10_000 });
    for (let i = 0; i < 3; i++) {
      await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' });
      await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1, type: 'market' });
    }
    expect((await broker.getAccount()).dayTradeCount).toBe(3);
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' });
    const o = await broker.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 1, type: 'market' });
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toMatch(/pattern day trader/);
  });
});

describe('day rollover', () => {
  it('expires DAY orders and resets daily P&L', async () => {
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 90 });
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limitPrice: 90, tif: 'gtc' });
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 5, type: 'market' });
    now += 24 * 3600_000;
    feed.quote('AAPL', 101, 101.02);
    const orders = await broker.getOrders('open');
    expect(orders).toHaveLength(1);
    expect(orders[0].tif).toBe('gtc');
    const acct = await broker.getAccount();
    expect(acct.dayPnl).toBe(0);
    expect(acct.realizedPnlToday).toBe(0);
  });

  it('lastBusinessDays skips weekends', () => {
    expect(lastBusinessDays('2026-10-12', 3)).toEqual(['2026-10-12', '2026-10-09', '2026-10-08']);
  });
});

describe('risk manager', () => {
  const risk = new RiskManager({ maxDailyLoss: 500, maxPositionNotional: 20_000, maxOrderNotional: 15_000, flattenMinutesBeforeClose: 5 });
  const quote: Quote = { symbol: 'AAPL', bid: 100, ask: 100, bidSize: 1, askSize: 1, last: 100, ts: 0 };

  it('blocks opening orders after the daily loss limit but allows closing', async () => {
    const account = { ...(await broker.getAccount()), dayPnl: -600 };
    const position = { symbol: 'AAPL', qty: 10, avgPrice: 160, marketPrice: 100, marketValue: 1000, unrealizedPnl: -600, realizedPnlToday: 0 };
    expect(risk.check({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' }, { account, position, quote })).toMatch(/daily loss/);
    expect(risk.check({ symbol: 'AAPL', side: 'sell', qty: 10, type: 'market' }, { account, position, quote })).toBeNull();
  });

  it('limits order and position size', async () => {
    const account = await broker.getAccount();
    expect(risk.check({ symbol: 'AAPL', side: 'buy', qty: 200, type: 'market' }, { account, quote })).toMatch(/max order/);
    const position = { symbol: 'AAPL', qty: 150, avgPrice: 100, marketPrice: 100, marketValue: 15000, unrealizedPnl: 0, realizedPnlToday: 0 };
    expect(risk.check({ symbol: 'AAPL', side: 'buy', qty: 100, type: 'market' }, { account, position, quote })).toMatch(/max position/);
  });
});
