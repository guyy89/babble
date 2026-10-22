import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaBroker } from '../src/broker/alpacaBroker.js';

const FEES = { commissionPerShare: 0, minCommission: 0, maxCommissionPct: 0, secFeePerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 };
const NOW = Date.parse('2026-10-23T15:00:00Z'); // 11:00 New York

/** A fake Alpaca REST API: route → JSON (or an Error to fail with a 422). */
function fakeFetch(routes: Record<string, unknown>, calls: { method: string; path: string; body?: unknown }[] = []) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace('https://paper-api.alpaca.markets', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const v = key ? routes[key] : [];
    if (v instanceof Error) return new Response(JSON.stringify({ message: v.message }), { status: 422 });
    return new Response(JSON.stringify(v), { status: 200 });
  });
}

const account = { equity: '8030', last_equity: '8000', cash: '8000', buying_power: '32000', multiplier: '4', maintenance_margin: '500', long_market_value: '1500', short_market_value: '-1500' };
const fills = [
  { id: 'a1', order_id: 'o1', symbol: 'AAPL', side: 'buy', qty: '5', price: '300', transaction_time: '2026-10-23T13:46:00Z' },
  { id: 'a2', order_id: 'o2', symbol: 'MSFT', side: 'sell_short', qty: '3', price: '500', transaction_time: '2026-10-23T13:46:01Z' },
  { id: 'a3', order_id: 'o3', symbol: 'MSFT', side: 'buy', qty: '3', price: '490', transaction_time: '2026-10-23T14:30:00Z' },
];

async function started(extra: Record<string, unknown> = {}, calls: { method: string; path: string; body?: unknown }[] = []) {
  vi.stubGlobal('fetch', fakeFetch({
    'GET /v2/account/activities/FILL': fills,
    'GET /v2/account': account,
    'GET /v2/positions': [
      { symbol: 'AAPL', qty: '5', side: 'long', avg_entry_price: '300', current_price: '302', market_value: '1510', unrealized_pl: '10' },
      { symbol: 'TSLA', qty: '-4', side: 'short', avg_entry_price: '400', current_price: '398', market_value: '-1592', unrealized_pl: '8' },
    ],
    'GET /v2/orders': [],
    ...extra,
  }, calls));
  vi.stubGlobal('WebSocket', class { send() {} close() {} });
  const b = new AlpacaBroker({ keyId: 'k', secretKey: 's' }, FEES, undefined, () => NOW);
  await b.start();
  b.stop();
  return b;
}

afterEach(() => vi.unstubAllGlobals());

describe('AlpacaBroker', () => {
  it('maps positions with the sign of shorts and today\'s realized P&L net of regulatory fees', async () => {
    const b = await started();
    const pos = await b.getPositions();
    expect(pos.find((p) => p.symbol === 'AAPL')).toMatchObject({ qty: 5, unrealizedPnl: 10 });
    expect(pos.find((p) => p.symbol === 'TSLA')).toMatchObject({ qty: -4, unrealizedPnl: 8 });
    // MSFT: short 3 at 500, covered at 490 → +30, minus the fees on the short sale
    const msft = pos.find((p) => p.symbol === 'MSFT')!;
    expect(msft.qty).toBe(0);
    expect(msft.realizedPnlToday).toBeGreaterThan(29.9);
    expect(msft.realizedPnlToday).toBeLessThan(30);
  });

  it('reports the account with day P&L net of the fees Alpaca paper does not deduct', async () => {
    const b = await started();
    const a = await b.getAccount();
    expect(a.equity).toBe(8030);
    expect(a.commissionsToday).toBeGreaterThan(0);
    expect(a.dayPnl).toBeCloseTo(30 - a.commissionsToday, 2);
    expect(a.accountType).toBe('margin');
    expect(a.buyingPower).toBe(32000);
  });

  it('sends bracket orders and turns an Alpaca refusal into a rejected order', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const b = await started({ 'POST /v2/orders': new Error('insufficient buying power') }, calls);
    const o = await b.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 2, type: 'market', stopLoss: { stopPrice: 290 }, takeProfit: { limitPrice: 320 } });
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toContain('insufficient buying power');
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/v2/orders')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ symbol: 'AAPL', qty: '2', side: 'buy', type: 'market', order_class: 'bracket', stop_loss: { stop_price: 290 }, take_profit: { limit_price: 320 } });
  });

  it('returns fills newest first, each once', async () => {
    const b = await started();
    const f = await b.getFills();
    expect(f.map((x) => x.id)).toEqual(['a3', 'a2', 'a1']);
    expect(f.find((x) => x.id === 'a2')!.side).toBe('sell');
  });
});
