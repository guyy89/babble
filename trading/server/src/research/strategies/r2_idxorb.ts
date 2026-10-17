// r2_idxorb: opening-range breakout on the index ETFs only (SPY, QQQ: tag 'index').
// Opening range = first orMinutes (5/15/30/60). Signal: a signal bucket (barMinutes, aligned to 09:30) CLOSES beyond
// the range. Filters (all known at decision time): |gap| vs prior close (min/max, and break direction vs gap),
// range width relative to the daily ATR(14) from daily bars strictly before today, prior-day trend (prior day's
// close vs open, or prior close vs 10-day SMA of closes), VWAP side. Re-entries: up to maxEntries signals per
// symbol per day; after a signal the same side is re-armed only after a close back inside the range.
// Entries: market, LIMIT at the signal close, or LIMIT at a retest of the range edge (limitTtl minutes).
// Exits: stop at the range opposite side / mid / ATR multiple; target R, breakeven, trailing, time exit, close.
// noStop: the trade is SIZED from an ATR-based stop (sizeAtr × ATR14 from the signal close, so R is not inflated
// by a tight range stop) but no stop is placed; it exits by target/time/close.
// No look-ahead: universe() uses only meta; onMinute() uses closed bars + ctx.dailyBefore (days before today).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  symbols: 'both' | 'SPY' | 'QQQ';
  orMinutes: number;          // 5 | 15 | 30 | 60
  barMinutes: number;         // signal bucket length (1 | 5)
  minGap: number;             // |gap| % lower bound (0 = off)
  maxGap: number;             // |gap| % upper bound (0 = off)
  gapDir: 'any' | 'with' | 'against'; // break direction relative to the gap sign
  minRangeAtr: number;        // range / ATR14 lower bound (0 = off)
  maxRangeAtr: number;        // range / ATR14 upper bound (0 = off)
  trend: 'none' | 'withDay' | 'againstDay' | 'withSma' | 'againstSma';
  vwapFilter: boolean;
  maxEntries: number;         // signals per symbol per day (re-entries after a close back inside the range)
  stopMode: 'far' | 'mid' | 'atr';
  stopAtr: number;            // for 'atr': stop distance from the signal close = stopAtr × ATR14
  noStop: boolean;
  sizeAtr: number;            // noStop sizing distance = sizeAtr × ATR14
  targetR: number;            // 0 = none
  breakevenAtR: number;       // 0 = off
  trailR: number;             // 0 = off
  holdMinutes: number;        // time exit after the signal (0 = off → flatten)
  cutoffMinute: number;       // last NY minute-of-day for a signal
  entry: 'market' | 'limitClose' | 'limitEdge';
  limitTtl: number;
}

interface S {
  hi: number; lo: number; pv: number; vol: number; seen: number;
  lastClose?: number; lastMinute?: number;
  atr?: number; prevUp?: boolean; aboveSma?: boolean;
  armedLong: boolean; armedShort: boolean; signals: number;
}

const OPEN = 9 * 60 + 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

function atr14(daily: Bar[]): number | undefined {
  if (daily.length < 15) return undefined;
  const d = daily.slice(-15);
  let sum = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc));
  }
  return sum / 14;
}

const strategy: Strategy<P> = {
  name: 'r2_idxorb',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('index') && (p.symbols === 'both' || m.symbol === p.symbols))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && (!p.maxGap || Math.abs(m.gapPct) <= p.maxGap))
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const rangeEnd = OPEN + p.orMinutes;
    const bucketStart = ctx.minute - p.barMinutes;
    const evalNow = ctx.minute >= rangeEnd + p.barMinutes && (ctx.minute - OPEN) % p.barMinutes === 0 && ctx.minute <= p.cutoffMinute;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const daily = ctx.dailyBefore(sym);
        const last = daily.at(-1);
        const sma = daily.length >= 10 ? daily.slice(-10).reduce((a, b) => a + b.c, 0) / 10 : undefined;
        s = {
          hi: -Infinity, lo: Infinity, pv: 0, vol: 0, seen: 0, atr: atr14(daily),
          prevUp: last ? last.c > last.o : undefined,
          aboveSma: last && sma !== undefined ? last.c > sma : undefined,
          armedLong: true, armedShort: true, signals: 0,
        };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < rangeEnd) { s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l); }
        else {
          // Re-arm a side once price closes back inside the range.
          if (b.c <= s.hi) s.armedLong = true;
          if (b.c >= s.lo) s.armedShort = true;
        }
        s.lastClose = b.c;
        s.lastMinute = bm;
      }
      if (!evalNow) continue;
      if (ctx.open.has(sym) || s.signals >= p.maxEntries || !Number.isFinite(s.hi) || !s.atr) continue;
      if (s.lastMinute === undefined || s.lastMinute < bucketStart) continue;
      const close = s.lastClose!;
      const range = s.hi - s.lo;
      if (!(range > 0)) continue;
      const ra = range / s.atr;
      if (p.minRangeAtr && ra < p.minRangeAtr) continue;
      if (p.maxRangeAtr && ra > p.maxRangeAtr) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const gap = ctx.meta[sym].gapPct;
      let side: 'long' | 'short' | undefined;
      if (close > s.hi && s.armedLong && (!p.vwapFilter || close > vwap)) side = 'long';
      else if (close < s.lo && s.armedShort && (!p.vwapFilter || close < vwap)) side = 'short';
      if (!side) continue;
      const long = side === 'long';
      if (p.gapDir === 'with' && (long ? gap <= 0 : gap >= 0)) continue;
      if (p.gapDir === 'against' && (long ? gap >= 0 : gap <= 0)) continue;
      if (p.trend !== 'none') {
        const up = p.trend.endsWith('Day') ? s.prevUp : s.aboveSma;
        if (up === undefined) continue;
        const withTrend = long === up;
        if (p.trend.startsWith('with') !== withTrend) continue;
      }
      let stop: number;
      if (p.noStop) stop = long ? close - p.sizeAtr * s.atr : close + p.sizeAtr * s.atr;
      else if (p.stopMode === 'mid') stop = (s.hi + s.lo) / 2;
      else if (p.stopMode === 'atr') stop = long ? close - p.stopAtr * s.atr : close + p.stopAtr * s.atr;
      else stop = long ? s.lo : s.hi;
      let entryLimit: number | undefined;
      if (p.entry === 'limitClose') entryLimit = r2(close);
      else if (p.entry === 'limitEdge') entryLimit = r2(long ? s.hi : s.lo);
      if (entryLimit !== undefined && (long ? entryLimit <= stop : entryLimit >= stop)) continue;
      if (long) s.armedLong = false; else s.armedShort = false;
      s.signals++;
      out.push({
        symbol: sym, side, stop,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit,
        limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        tag: `${side}-or${p.orMinutes}-${p.entry}`,
      });
    }
    return out;
  },
};

// Design (2026-04-16..06-15 only, scratch explore.ts): plain ORB on SPY/QQQ was negative (5/15-min ranges worst);
// breaking in the GAP direction (gapDir 'with') turned almost every 30/60-min variant positive in-design (175/192
// exit variants); trend/VWAP/range-ATR filters, re-entries, exit details and entry type mattered little.
// wf run 1 (accidental: the grid edit had failed, so it ran the 4-config baseline: plain ORB 5/15/30/60, far stop,
//   no target, both directions, market) → WF -17.9R, full-period -25..-65R. Plain index ORB loses.
// wf run 2 (pre-registered from the design period, NOT shaped by run 1): core area × entry type × re-entries ×
//   risk tiers × caps. 768 configs → WF +3.0R but net -$1,206 (all picks at the $500 tier), PF 0.92, t 0.21,
//   months +1.5/+0.8/-3.2/+4.0 R, stress -1.4R → FAIL. Best full-period +22.8R/155 trades. Caps irrelevant.
// wf run 3 (exit dimension, planned from the design-period exit/noStop grids before run 2, not tuned to run 2):
//   targets 0/1/3, trail, noStop sized from 0.25×ATR, time exit, daily loss limit and max-losers on/off, $100 tier.
//   384 configs → WF -11.4R (-6.7/+10.7/-3.7/-11.7), net -$478, PF 0.82, t -0.81, stress -18.9R → FAIL.
//   Best full-period +10.0R/135. Daily-loss/max-loser caps changed nothing. Verdict: no edge; stopped here.
export default {
  strategy,
  grid: {
    symbols: ['both'],
    orMinutes: [30, 60],
    barMinutes: [1, 5],
    minGap: [0],
    maxGap: [0],
    gapDir: ['with'],
    minRangeAtr: [0],
    maxRangeAtr: [0],
    trend: ['none'],
    vwapFilter: [false],
    maxEntries: [1],
    stopMode: ['mid'],
    stopAtr: [0.25],
    noStop: [false, true],
    sizeAtr: [0.25],
    targetR: [0, 1, 3],
    breakevenAtR: [0],
    trailR: [0, 1],
    holdMinutes: [0, 120],
    cutoffMinute: [14 * 60],
    entry: ['market'],
    limitTtl: [10],
    'rule.riskPerTrade': [100],
    'rule.dailyLossLimit': [300, 0],
    'rule.maxLosses': [2, 0],
    'rule.maxTrades': [0],
    'rule.maxConcurrent': [0],
  } as Record<string, unknown[]>,
};
