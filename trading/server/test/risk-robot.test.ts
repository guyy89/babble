import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/risk/riskManager.js';
import type { Account } from '../src/types.js';

const risk = new RiskManager({ maxDailyLoss: 150, maxRiskPerTrade: 50, maxPositionNotional: 10_000, maxOrderNotional: 10_000, flattenMinutesBeforeClose: 5 });
const account = { dayPnl: 0 } as Account;
const quote = { symbol: 'AAPL', bid: 100, ask: 100.02, bidSize: 100, askSize: 100, last: 100, ts: 0 };
const order = { symbol: 'AAPL', side: 'buy' as const, qty: 10, type: 'market' as const };

describe('RiskManager and the momentum robot (shared account)', () => {
  it('requires a stop on manual orders but not on robot orders', () => {
    expect(risk.check(order, { account, quote })).toMatch(/סטופ/);
    expect(risk.check(order, { account, quote }, true)).toBeNull();
  });

  it('still applies every other limit to robot orders', () => {
    expect(risk.check({ ...order, qty: 200 }, { account, quote }, true)).toMatch(/גבוה מ/); // $20k > $10k order limit
    expect(risk.check(order, { account: { dayPnl: -200 } as Account, quote }, true)).toMatch(/ההפסד היומי/);
  });
});
