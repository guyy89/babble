import { describe, expect, it } from 'vitest';
import { OrbBot } from '../src/bot/orbBot.js';
import { PaperBroker } from '../src/broker/paperBroker.js';
import type { PaperConfig, RiskConfig } from '../src/config.js';
import { MarketClock } from '../src/market/clock.js';
import { BaseFeed } from '../src/market/feed.js';
import { SymbolDirectory } from '../src/market/symbolDirectory.js';
import { DEFAULT_ORB } from '../src/strategy/orb.js';
import { TradingService } from '../src/tradingService.js';

class FakeFeed extends BaseFeed {
  readonly name = 'fake';
  async start() {}
  stop() {}
  /** One print and a tight quote at `price`, at time `ts`. */
  tick(symbol: string, price: number, ts: number) {
    this.publishQuote({ symbol, bid: price - 0.01, ask: price + 0.01, bidSize: 10_000, askSize: 10_000, last: price, ts });
    this.publishTrade({ symbol, price, size: 500, ts });
  }
}

const OPEN = Date.UTC(2026, 9, 14, 13, 30); // Wed 09:30 New York
const at = (min: number, sec = 0) => OPEN + min * 60_000 + sec * 1000;

describe('OrbBot on a scripted day', () => {
  it('selects, waits for the range, enters on the breakout with stop and target, then moves stop to breakeven', async () => {
    let now = at(0);
    const feed = new FakeFeed(['TEST']); // live, AlpacaFeed loads the morning's bars when the robot adds a symbol
    const clock = new MarketClock(false, () => now);
    const paper: PaperConfig = {
      startingCash: 5000, accountType: 'margin', marginModel: 'intraday', slippageBps: 0, liquidityFraction: 1, maxQuoteDeviationBps: 0,
      fees: { commissionPerShare: 0.005, minCommission: 1, maxCommissionPct: 0.01, secFeePerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 },
    };
    const risk: RiskConfig = { maxDailyLoss: 150, maxRiskPerTrade: 50, maxPositionNotional: 10_000, maxOrderNotional: 10_000, flattenMinutesBeforeClose: 5 };
    const broker = new PaperBroker(feed, clock, paper, undefined, () => now);
    const directory = new SymbolDirectory(async () => [{ symbol: 'TEST', name: 'Test Corp', exchange: 'NYSE' }]);
    await directory.load();
    const svc = new TradingService(feed, broker, clock, risk, directory);
    await broker.start();
    const universe = async () => [{ symbol: 'TEST', name: 'Test Corp', open: 20.2, prevClose: 19, avgVolume: 1e6 }];
    const bot = new OrbBot(svc, universe, { ...DEFAULT_ORB }, undefined, undefined, () => now);
    bot.setEnabled(true);

    // Opening range 09:30–09:44 between 20.00 and 20.50.
    for (let m = 0; m < 15; m++) {
      now = at(m, 10); feed.tick('TEST', 20.0, now);
      now = at(m, 30); feed.tick('TEST', 20.5, now);
      now = at(m, 50); feed.tick('TEST', 20.3, now);
      await bot.tick();
    }
    expect(bot.status().selected).toBe(false); // nothing happens before 09:45

    // 09:45–09:49: climbs to 20.80, closing above the range and VWAP.
    for (let m = 15; m < 20; m++) {
      now = at(m, 20); feed.tick('TEST', 20.4 + (m - 14) * 0.08, now);
      await bot.tick();
    }
    expect(bot.status().candidates.map((c) => c.symbol)).toEqual(['TEST']);
    expect(bot.status().trades).toBe(0); // 09:45–09:50 bar not finished yet

    now = at(20, 2); feed.tick('TEST', 20.8, now);
    await bot.tick();
    const s = bot.status();
    expect(s.trades).toBe(1);
    expect(s.candidates[0]).toMatchObject({ state: 'entered', side: 'long' });
    const pos = (await broker.getPositions()).find((p) => p.symbol === 'TEST')!;
    expect(pos.qty).toBeGreaterThan(0);
    const legs = await broker.getOrders('open');
    const stop = legs.find((o) => o.type === 'stop')!;
    const target = legs.find((o) => o.type === 'limit')!;
    expect(stop.stopPrice).toBe(20.25); // range 2.5% wide → middle of the range
    const riskPerShare = pos.avgPrice - stop.stopPrice!;
    expect(riskPerShare * pos.qty).toBeLessThanOrEqual(50);
    expect(target.limitPrice).toBeCloseTo(pos.avgPrice + 2 * riskPerShare, 1);

    // Price reaches +1R: the stop moves to the entry price.
    now = at(25); feed.tick('TEST', pos.avgPrice + riskPerShare + 0.05, now);
    await bot.tick();
    expect((await broker.getOrders('open')).find((o) => o.type === 'stop')!.stopPrice).toBeCloseTo(pos.avgPrice, 2);
    expect(bot.status().candidates[0].breakevenDone).toBe(true);

    // Price hits the target: the trade closes as a win.
    now = at(30); feed.tick('TEST', target.limitPrice! + 0.05, now);
    now = at(30, 20); feed.tick('TEST', target.limitPrice! + 0.06, now);
    await bot.tick();
    expect(bot.status().candidates[0].state).toBe('closed');
    expect(bot.status().candidates[0].result).toBeGreaterThan(0);
    expect(bot.status().losses).toBe(0);
  });

  it('refuses to start where it is unavailable', () => {
    const bot = new OrbBot({} as TradingService, async () => [], DEFAULT_ORB, undefined, 'רק נתונים אמיתיים');
    expect(() => bot.setEnabled(true)).toThrow('רק נתונים אמיתיים');
  });
});
