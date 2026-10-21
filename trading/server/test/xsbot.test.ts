import { describe, expect, it } from 'vitest';
import { selectBasket, XS_PARAMS, XsMomBot, type XsInput } from '../src/bot/xsMomBot.js';
import { PaperBroker } from '../src/broker/paperBroker.js';
import type { PaperConfig } from '../src/config.js';
import { MarketClock } from '../src/market/clock.js';
import { BaseFeed } from '../src/market/feed.js';
import { SymbolDirectory } from '../src/market/symbolDirectory.js';
import { TradingService } from '../src/tradingService.js';

class FakeFeed extends BaseFeed {
  readonly name = 'fake';
  async start() {}
  stop() {}
  tick(symbol: string, price: number, ts: number) {
    this.publishQuote({ symbol, bid: price - 0.01, ask: price + 0.01, bidSize: 100_000, askSize: 100_000, last: price, ts });
    this.publishTrade({ symbol, price, size: 500, ts });
  }
}

/** 12 stocks: S01 has the strongest move from the open, S12 the weakest (all with ATR 2% of price). */
const rows = (): XsInput[] => Array.from({ length: 12 }, (_, i) => {
  const symbol = `S${String(i + 1).padStart(2, '0')}`;
  return { symbol, name: `${symbol} Inc`, prevClose: 100, atr: 2, avgVolume: 1e7 - i * 1e5, open: 100, px: 100 * (1 + (6 - i) * 0.002) };
});

describe('selectBasket', () => {
  it('buys the strongest K and shorts the weakest K, interleaved, sized from the ATR distance', () => {
    const b = selectBasket(rows(), XS_PARAMS);
    expect(b.map((x) => `${x.side[0]}${x.symbol}`)).toEqual(['lS01', 'sS12', 'lS02', 'sS11', 'lS03', 'sS10', 'lS04', 'sS09']);
    // distance = max(0.5 × ATR 2 = 1.00, price × 4/190 ≈ 2.13) → the floor binds at a $100 price
    const s01 = b[0];
    expect(s01.dist).toBeCloseTo(s01.px * (4 / 190), 6);
    expect(s01.qty).toBe(Math.floor(200 / s01.dist));
  });

  it('ranks by ATR-normalised move, not raw move', () => {
    const r = rows();
    r[11] = { ...r[11], atr: 20, px: 99 }; // −1% but with a 20% ATR → small normalised move
    const b = selectBasket(r, XS_PARAMS);
    expect(b.filter((x) => x.side === 'short').map((x) => x.symbol)).not.toContain('S12');
  });

  it('skips ETFs and leveraged products, and keeps only the most liquid 20 by $ volume', () => {
    const r = rows();
    r.push({ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', prevClose: 100, atr: 2, avgVolume: 1e9, open: 100, px: 110 });
    r.push({ symbol: 'TSLL', name: 'Direxion Daily TSLA Bull 2X Shares', prevClose: 100, atr: 2, avgVolume: 1e9, open: 100, px: 120 });
    for (let i = 0; i < 20; i++) r.push({ symbol: `B${i}`, name: `Big ${i}`, prevClose: 100, atr: 2, avgVolume: 5e7, open: 100, px: 100 });
    const b = selectBasket(r, XS_PARAMS);
    const names = b.map((x) => x.symbol);
    expect(names).not.toContain('SPY');
    expect(names).not.toContain('TSLL');
    // SPY takes one of the 20 liquid slots and is then excluded, so 19 'Big' names remain and the S-names are out
    expect(names.every((s) => s.startsWith('B'))).toBe(true);
  });

  it('trades nothing when fewer than 2K+2 stocks qualify', () => {
    expect(selectBasket(rows().slice(0, 9), XS_PARAMS)).toEqual([]);
  });
});

const OPEN = Date.UTC(2026, 9, 14, 13, 30); // Wed 09:30 New York
const at = (min: number, sec = 0) => OPEN + min * 60_000 + sec * 1000;

let quoteAllOne: (symbol: string, price: number) => void = () => {};

async function setup(startMin: number, over: Partial<typeof XS_PARAMS> = {}) {
  let now = at(startMin);
  const feed = new FakeFeed([]);
  const clock = new MarketClock(false, () => now);
  const paper: PaperConfig = {
    startingCash: 25_000, accountType: 'margin', marginModel: 'intraday', slippageBps: 0, liquidityFraction: 1, maxQuoteDeviationBps: 0,
    fees: { commissionPerShare: 0, minCommission: 0, maxCommissionPct: 0, secFeePerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 },
  };
  const broker = new PaperBroker(feed, clock, paper, undefined, () => now);
  const directory = new SymbolDirectory(async () => rows().map((r) => ({ symbol: r.symbol, name: r.name, exchange: 'NASDAQ' })));
  await directory.load();
  const svc = new TradingService(feed, broker, clock, {
    maxDailyLoss: 0, maxRiskPerTrade: 0, maxPositionNotional: 40_000, maxOrderNotional: 40_000, flattenMinutesBeforeClose: 5,
  }, directory, undefined, false);
  await broker.start();
  const prepare = async () => rows().map(({ open: _o, px: _p, ...r }) => r);
  const prices = async () => Object.fromEntries(rows().map((r) => [r.symbol, { open: r.open, px: r.px }]));
  const bot = new XsMomBot(svc, prepare, prices, { ...XS_PARAMS, ...over }, undefined, undefined, () => now);
  const quoteAll = (move = 0) => { for (const r of rows()) feed.tick(r.symbol, r.px * (1 + move), now); };
  quoteAllOne = (symbol, price) => feed.tick(symbol, price, now);
  // A minimal in-memory store, for the rule-change test.
  const feedStore = { data: undefined as unknown, load() { return this.data as never; }, save(v: unknown) { this.data = v; } };
  return { feed, broker, bot, set: (t: number) => { now = t; }, quoteAll, feedStore };
}

describe('XsMomBot on a scripted day', () => {
  it('enters the basket at 09:45 without stops and books the day after the flatten', async () => {
    const { broker, bot, set, quoteAll } = await setup(0);
    bot.setEnabled(true);
    set(at(1)); quoteAll(); await bot.tick();
    expect((await bot.status()).days).toHaveLength(0); // nothing before the decision minute

    set(at(15, 3)); quoteAll(); await bot.tick();
    const st = await bot.status();
    expect(st.days).toHaveLength(1);
    expect(st.days[0].legs).toHaveLength(8);
    const pos = await broker.getPositions();
    expect(pos.filter((p) => p.qty > 0).map((p) => p.symbol).sort()).toEqual(['S01', 'S02', 'S03', 'S04']);
    expect(pos.filter((p) => p.qty < 0).map((p) => p.symbol).sort()).toEqual(['S09', 'S10', 'S11', 'S12']);
    expect((await broker.getOrders('open')).filter((o) => o.type === 'stop')).toHaveLength(0);

    // The trading service flattens 5 minutes before the close; then the day is settled.
    set(at(385)); quoteAll(0.01); await broker.closeAll();
    set(at(386)); await bot.tick();
    const end = await bot.status();
    expect(end.days[0].done).toBe(true);
    expect(end.summary.days).toBe(1);
    // +1% on everything: longs win, shorts lose by about the same → small net (fees), R = $/200
    expect(end.days[0].r).toBeCloseTo(end.days[0].pnl! / 200, 2);
    expect(end.days[0].legs.every((l) => l.fillPx! > 0)).toBe(true);

    // No second basket the same day.
    set(at(386, 30)); await bot.tick();
    expect((await bot.status()).days).toHaveLength(1);
  });

  it('closes the whole basket once the day net reaches the take-profit, and books the day', async () => {
    const { broker, bot, set, quoteAll } = await setup(0, { dayTakeProfit: 90 });
    bot.setEnabled(true);
    set(at(1)); quoteAll(); await bot.tick();
    set(at(15, 3)); quoteAll(); await bot.tick();
    expect((await broker.getPositions()).filter((p) => p.qty !== 0)).toHaveLength(8);

    // Longs (S01–S04) up 3%, shorts (S09–S12) down 3%: well above $90.
    set(at(60));
    for (const r of rows()) {
      const i = Number(r.symbol.slice(1));
      quoteAllOne(r.symbol, r.px * (i <= 4 ? 1.03 : i >= 9 ? 0.97 : 1));
    }
    await bot.tick();
    expect((await broker.getPositions()).filter((p) => p.qty !== 0)).toHaveLength(0);
    set(at(60, 10)); await bot.tick();
    const st = await bot.status();
    expect(st.days[0].done).toBe(true);
    expect(st.days[0].takeProfitAt).toBeDefined();
    expect(st.days[0].pnl!).toBeGreaterThanOrEqual(90);
    expect(st.log.some((l) => l.msg.includes('היעד'))).toBe(true);
  });

  it('starts a new test (archiving earlier days) when the rules change', async () => {
    const { feedStore } = await setup(0);
    feedStore.data = { enabled: true, days: [{ date: '2026-10-13', decidedAt: 0, legs: [], done: true, pnl: 5, r: 0.03 }], log: [] };
    const bot2 = new XsMomBot({ clock: new MarketClock(false, () => at(0)) } as unknown as TradingService, async () => [], async () => ({}),
      { ...XS_PARAMS, dayTakeProfit: 90 }, feedStore, undefined, () => at(0));
    const st = (bot2 as any).s;
    expect(st.days).toHaveLength(0);
    expect(st.archive).toHaveLength(1);
    expect(st.archive[0].days).toHaveLength(1);
  });

  it('does not enter late after a restart and does not count the missed day', async () => {
    const { bot, set, quoteAll } = await setup(25);
    bot.setEnabled(true);
    quoteAll(); await bot.tick();
    set(at(26)); await bot.tick();
    const st = await bot.status();
    expect(st.days).toHaveLength(0);
    expect(st.log.filter((l) => l.msg.includes('הוחמץ'))).toHaveLength(1);
  });

  it('refuses to start where it is unavailable', () => {
    const bot = new XsMomBot({} as TradingService, async () => [], async () => ({}), XS_PARAMS, undefined, 'רק נתונים חיים');
    expect(() => bot.setEnabled(true)).toThrow('רק נתונים חיים');
  });
});
