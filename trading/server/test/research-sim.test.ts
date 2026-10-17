import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Signal, Strategy } from '../src/research/types.js';

// A scripted day in a throwaway dataset: one symbol, 09:30–16:00 New York, 2026-06-17 (EDT, open = 13:30Z).
const DIR = 'research-test-fixture';
const DATE = '2026-06-17';
const OPEN = Date.UTC(2026, 5, 17, 13, 30);
type Row = [number, number, number, number, number, number];
const flat = (px: number, n = 390): Row[] => Array.from({ length: n }, (_, i) => [OPEN + i * 60_000, px, px + 0.05, px - 0.05, px, 1000]);

let sim: typeof import('../src/research/sim.js');
let data: typeof import('../src/research/data.js');
const root = resolve(process.cwd(), 'data', DIR);

function writeDay(bars: Row[], tags = ['gap']) {
  data.clearDayCache();
  writeFileSync(resolve(root, 'days', `${DATE}.json`), JSON.stringify({
    meta: { T: { symbol: 'T', name: 'Test', open: bars[0][1], prevClose: 19, avgVolume: 1e6, gapPct: 5, tags } },
    bars: { T: bars },
  }));
}

/** Strategy that emits one fixed signal at a given New York minute. */
const once = (minute: number, sig: Omit<Signal, 'symbol'>): Strategy<Record<string, never>> => ({
  name: 'once',
  universe: () => ['T'],
  onMinute: (ctx) => (ctx.minute === minute ? [{ symbol: 'T', ...sig }] : []),
});
const M = (h: number, m: number) => h * 60 + m;

beforeAll(async () => {
  mkdirSync(resolve(root, 'days'), { recursive: true });
  writeFileSync(resolve(root, 'daily.json'), JSON.stringify({ T: [] }));
  process.env.RESEARCH_DIR = DIR;
  sim = await import('../src/research/sim.js');
  data = await import('../src/research/data.js');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const noCosts = { slippagePct: 0, liquidSlippagePct: 0, minSlippage: 0, feeMultiplier: 0 };

describe('research simulator v2', () => {
  it('limit entry needs a trade-through, then fills at the limit with no slippage', () => {
    const bars = flat(20);
    bars[20] = [OPEN + 20 * 60_000, 20, 20.05, 19.9, 20, 1000]; // 09:50 low 19.90: only touches 19.90
    bars[25] = [OPEN + 25 * 60_000, 20, 20.05, 19.89, 20, 1000]; // 09:55 low 19.89: through 19.90
    writeDay(bars);
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19.5, entryLimit: 19.9, limitTtl: 30 }), {}, sim.rulesForRisk(50), sim.DEFAULT_COSTS);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ entryType: 'limit', entry: 19.9, entryTime: OPEN + 25 * 60_000 });
  });

  it('cancels an unfilled limit after its time-to-live', () => {
    writeDay(flat(20));
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19.5, entryLimit: 19.5, limitTtl: 5 }), {}, sim.rulesForRisk(50), sim.DEFAULT_COSTS);
    expect(t).toHaveLength(0);
  });

  it('checks the stop inside a market entry bar', () => {
    const bars = flat(20);
    bars[15] = [OPEN + 15 * 60_000, 20, 20.05, 19.4, 19.5, 1000]; // 09:45 entry bar plunges through the stop
    writeDay(bars);
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19.6 }), {}, sim.rulesForRisk(50), noCosts);
    expect(t[0]).toMatchObject({ exitReason: 'stop', exitTime: OPEN + 15 * 60_000, exit: 19.6 });
  });

  it('fills a gapped-over target at the (better) open', () => {
    const bars = flat(20);
    bars[30] = [OPEN + 30 * 60_000, 21.5, 21.6, 21.4, 21.5, 1000];
    writeDay(bars);
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19.6, targetR: 2 }), {}, sim.rulesForRisk(50), noCosts);
    expect(t[0]).toMatchObject({ exitReason: 'target', exit: 21.5 });
  });

  it('rejects stops tighter than 0.15% of price', () => {
    writeDay(flat(20));
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19.98 }), {}, sim.rulesForRisk(50), noCosts);
    expect(t).toHaveLength(0);
  });

  it('scales the account with the risk tier and treats 0 as no limit', () => {
    const r = sim.rulesForRisk(500, { dailyLossLimit: 0 });
    expect(r).toMatchObject({ riskPerTrade: 500, buyingPower: 200_000, maxPositionNotional: 100_000, dailyLossLimit: 0 });
    writeDay(flat(20));
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 19 }), {}, r, noCosts);
    expect(t[0].qty).toBe(500); // $500 / $1 risk per share
  });

  it('uses lower slippage for liquid names', () => {
    writeDay(flat(200), ['liquid']);
    const t = sim.simulateStrategyDay(DATE, once(M(9, 45), { side: 'long', stop: 198 }), {}, sim.rulesForRisk(50), { ...sim.DEFAULT_COSTS, feeMultiplier: 0 });
    expect(t[0].entry).toBeCloseTo(200.02, 2); // 0.01% of 200
  });
});
