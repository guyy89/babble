import { describe, expect, it } from 'vitest';
import { simulateDay } from '../src/backtest/simulate.js';
import { breakout, completedBars, DEFAULT_ORB, israelTime, openingRange, planTrade, selectCandidates, type Candidate } from '../src/strategy/orb.js';
import type { Bar } from '../src/types.js';

// 2026-10-14 is a Wednesday; 09:30 New York (EDT) = 13:30Z.
const OPEN = Date.UTC(2026, 9, 14, 13, 30);
const minute = (i: number, o: number, h: number, l: number, c: number, v = 1000): Bar => ({ symbol: 'TEST', t: OPEN + i * 60_000, o, h, l, c, v });
const p = DEFAULT_ORB;
const noFees = { commissionPerShare: 0, minCommission: 0, maxCommissionPct: 0, secFeePerMillion: 0, tafPerShare: 0, tafMaxPerTrade: 0 };
const costs = { fees: noFees, slippagePct: 0, minSlippage: 0, buyingPower: 20_000 };

/** 15 flat minutes in 20.00–20.50, then whatever follows. */
const day = (after: Bar[]) => [...Array.from({ length: 15 }, (_, i) => minute(i, 20.2, 20.5, 20.0, 20.3)), ...after];
const cand: Candidate = { symbol: 'TEST', name: 'Test Corp', open: 20.2, prevClose: 19, avgVolume: 1e6, gapPct: 6.3 };

describe('ORB rules', () => {
  it('selects by |gap| within price and liquidity limits and skips leveraged funds', () => {
    const rows = [
      { symbol: 'A', name: 'Alpha Inc.', open: 21, prevClose: 20, avgVolume: 2e5 },       // +5%
      { symbol: 'B', name: 'Beta Corp', open: 18, prevClose: 20, avgVolume: 2e5 },        // -10%
      { symbol: 'C', name: 'T-Rex 2X Long C Daily Target ETF', open: 30, prevClose: 20, avgVolume: 9e9 },
      { symbol: 'D', name: 'Delta Inc.', open: 120, prevClose: 100, avgVolume: 9e9 },     // too expensive
      { symbol: 'E', name: 'Echo Inc.', open: 20.2, prevClose: 20, avgVolume: 9e9 },      // gap too small
      { symbol: 'F', name: 'Foxtrot Inc.', open: 25, prevClose: 20, avgVolume: 10 },      // illiquid
    ];
    expect(selectCandidates(rows, p).map((c) => c.symbol)).toEqual(['B', 'A']);
  });

  it('builds the opening range and completed 5-minute bars with VWAP', () => {
    const bars = day([minute(15, 20.3, 20.6, 20.3, 20.6), minute(16, 20.6, 20.7, 20.5, 20.7), minute(17, 20.7, 20.8, 20.6, 20.8), minute(18, 20.8, 20.8, 20.7, 20.75), minute(19, 20.75, 20.8, 20.7, 20.8)]);
    expect(openingRange(bars, p, 9 * 60 + 44)).toBeUndefined();
    const range = openingRange(bars, p, 9 * 60 + 45)!;
    expect(range).toEqual({ high: 20.5, low: 20.0 });
    expect(completedBars(bars, p, 9 * 60 + 49)).toHaveLength(0); // 09:45–09:50 not finished yet
    const done = completedBars(bars, p, 9 * 60 + 50);
    expect(done).toHaveLength(1);
    expect(done[0].close).toBe(20.8);
    expect(breakout(done[0], range)).toBe('long');
  });

  it('sizes to the risk budget and caps by notional', () => {
    const plan = planTrade('long', 20.8, { high: 20.5, low: 20.0 }, p)!;
    // range 0.5 on 20.8 = 2.4% > 2% wide → stop at the middle (20.25), risk 0.55/share → 90 shares
    expect(plan).toMatchObject({ stop: 20.25, qty: 90, target: 21.9, breakeven: 21.35 });
    expect(planTrade('long', 20.4, { high: 20.5, low: 20.38 }, p)?.qty).toBe(Math.floor(10_000 / 20.4)); // notional cap
  });
});

describe('simulateDay', () => {
  const up = (from: number, n: number, step: number) =>
    Array.from({ length: n }, (_, k) => { const px = from + k * step; return minute(15 + k, px, px + step, px - 0.01, px + step); });

  it('enters on the breakout at the next open and exits at the target', () => {
    const bars = day(up(20.4, 60, 0.05)); // steady climb through the range high
    const r = simulateDay('2026-10-14', [cand], { TEST: bars }, p, costs);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.direction).toBe('long');
    expect(t.openedAt).toBe(OPEN + 20 * 60_000); // 09:50: first 5-min bar after the range closed above it
    expect(t.r).toBeCloseTo(2, 1);
  });

  it('assumes the stop fills first when one minute touches both stop and target', () => {
    const after = [...up(20.4, 5, 0.1), minute(20, 20.9, 30, 10, 20.9)]; // 09:50 bar spans everything
    const r = simulateDay('2026-10-14', [cand], { TEST: after.length ? day(after) : [] }, p, costs);
    expect(r.trades[0].netPnl).toBeLessThan(0);
  });

  it('respects the daily loss cap', () => {
    const mk = (symbol: string): Candidate => ({ ...cand, symbol });
    // Each symbol breaks out then collapses through its stop.
    const crash = (symbol: string) => day([...up(20.4, 5, 0.1), ...Array.from({ length: 20 }, (_, k) => minute(20 + k, 20.9 - k * 0.2, 20.9 - k * 0.2, 20.7 - k * 0.2, 20.7 - k * 0.2))]).map((b) => ({ ...b, symbol }));
    const r = simulateDay('2026-10-14', [mk('A'), mk('B'), mk('C')], { A: crash('A'), B: crash('B'), C: crash('C') }, { ...p, maxTrades: 5 }, costs);
    expect(r.trades.filter((t) => t.netPnl < 0).length).toBeLessThanOrEqual(3);
  });
});

describe('israelTime', () => {
  it('is 7 hours ahead of New York most of the year and 6 in the week the clocks differ', () => {
    expect(israelTime(9 * 60 + 30, Date.UTC(2026, 9, 19, 12))).toBe('16:30'); // Mon 19 Oct: both on summer time
    expect(israelTime(9 * 60 + 30, Date.UTC(2026, 9, 27, 12))).toBe('15:30'); // Tue 27 Oct: Israel back on winter time, US not yet
    expect(israelTime(9 * 60 + 30, Date.UTC(2026, 10, 3, 12))).toBe('16:30');  // Tue 3 Nov: both on winter time
  });
});
