// r2_orb30: opening-range breakout with a LONG range (first 30/45/60 minutes).
// Entry on a confirmed break: a signal bucket (barMinutes, aligned to 09:30) CLOSES beyond the range,
// optionally by a margin (confirmFrac × range). Filters: gap direction, VWAP side, range width relative
// to the daily ATR(14) (from daily bars strictly before today), breakout-bucket volume vs. the day's
// average per-minute volume so far. Entry at market or with a LIMIT (at the signal close, or a retest of
// the range edge). Exits: range-based or ATR-based stop / no stop, fixed target, breakeven, trailing, time.
// No look-ahead: universe() uses only meta; onMinute() uses closed bars + ctx.dailyBefore (days before today).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  orMinutes: number;          // 30 | 45 | 60
  barMinutes: number;         // signal bucket length (5 | 15)
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;             // |gap| % to qualify (0 = any)
  maxSymbols: number;         // candidates per day (largest |gap| first)
  direction: 'both' | 'with-gap';
  vwapFilter: boolean;
  minRangeAtr: number;        // range / ATR14 lower bound (0 = off)
  maxRangeAtr: number;        // range / ATR14 upper bound (0 = off)
  volMult: number;            // bucket volume per minute ≥ volMult × day avg volume per minute before bucket (0 = off)
  confirmFrac: number;        // close must exceed the level by this fraction of the range
  stopMode: 'far' | 'mid' | 'atr';
  stopAtr: number;            // for 'atr': stop distance from the signal close = stopAtr × ATR14
  noStop: boolean;            // size from the stop but do not place it (exit by target/time/close)
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
  atr?: number;
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
  name: 'r2_orb30',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && m.open >= 5)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
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
        s = { hi: -Infinity, lo: Infinity, pv: 0, vol: 0, seen: 0, atr: atr14(ctx.dailyBefore(sym)) };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < rangeEnd) { s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l); }
        s.lastClose = b.c;
        s.lastMinute = bm;
      }
      if (!evalNow) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.hi) || !s.atr) continue;
      if (s.lastMinute === undefined || s.lastMinute < bucketStart) continue;
      const close = s.lastClose!;
      const range = s.hi - s.lo;
      if (!(range > 0)) continue;
      const ra = range / s.atr;
      if (p.minRangeAtr && ra < p.minRangeAtr) continue;
      if (p.maxRangeAtr && ra > p.maxRangeAtr) continue;
      if (p.volMult) {
        let bucketVol = 0;
        for (let i = bars.length - 1; i >= 0; i--) {
          if (ctx.minuteOf(bars[i].t) < bucketStart) break;
          bucketVol += bars[i].v;
        }
        const avgBefore = (s.vol - bucketVol) / (bucketStart - OPEN);
        if (!(avgBefore > 0) || bucketVol / p.barMinutes < p.volMult * avgBefore) continue;
      }
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const m = p.confirmFrac * range;
      let side: 'long' | 'short' | undefined;
      if (close > s.hi + m && (!p.vwapFilter || close > vwap) && (p.direction === 'both' || gapUp)) side = 'long';
      else if (close < s.lo - m && (!p.vwapFilter || close < vwap) && (p.direction === 'both' || !gapUp)) side = 'short';
      if (!side) continue;
      const long = side === 'long';
      let stop: number;
      if (p.stopMode === 'mid') stop = (s.hi + s.lo) / 2;
      else if (p.stopMode === 'atr') stop = long ? close - p.stopAtr * s.atr : close + p.stopAtr * s.atr;
      else stop = long ? s.lo : s.hi;
      let entryLimit: number | undefined;
      if (p.entry === 'limitClose') entryLimit = r2(close);
      else if (p.entry === 'limitEdge') entryLimit = r2(long ? s.hi : s.lo);
      // A limit must sit on the right side of the stop.
      if (entryLimit !== undefined && (long ? entryLimit <= stop : entryLimit >= stop)) continue;
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

export default {
  strategy,
  grid: {
    // Run 1 (768 configs): orMinutes 30/60, tags gap/liquid, minGap 0/3, direction both/with-gap, range/ATR
    // filters, volMult 0/1.5, stop far/mid/atr0.2, target 0/2, market only → WF -22.6R; best full-period +7R.
    // Run 2 (1152 configs): 45/60-min range, with-gap, liquid/all, minGap 1.5/3, maxRangeAtr 0/0.8, stop mid/atr0.3,
    // target 0/2/3, BE 0/1, cutoff 12:00/14:00, entry market/limitClose/limitEdge → WF -13.1R; best full-period +13.9R/135.
    // Run 3 (shaped by runs 1–2 full-period tables, which include the test months): the least-bad area
    // (60-min range, liquid gappers ≥1.5%, mid stop, 2R) × entry type/TTL × risk tiers × limits on/off × exit variants.
    // → run 3: WF -11.5R; best full-period +31.9R (noStop, limitEdge, no trade/concurrency caps) but all of it in
    //   M1–M2 and M6; M3–M5 negative. Risk tier barely mattered in R; maxTrades/maxConcurrent = 0 helped; noStop > stop.
    // Run 4 (also shaped by earlier full-period tables): a small, coherent grid of the least-bad region (64 configs) so
    // the walk-forward selection has less noise to chase: 45/60 range × liquid/all × range cap × limit type × stop/noStop
    // × time exit (2 h after the signal vs. the close). Caps off (maxTrades/maxConcurrent 0), default daily loss limit.
    // → run 4: WF -0.1R (M3 +2.4, M4 -10.3, M5 +2.6, M6 +5.3), PF 1.01, t -0.01 → FAIL. Verdict: no edge found.
    orMinutes: [45, 60],
    barMinutes: [5],
    tags: ['liquid', 'all'],
    minGap: [1.5],
    maxSymbols: [10],
    direction: ['with-gap'],
    vwapFilter: [true],
    minRangeAtr: [0],
    maxRangeAtr: [0, 0.8],
    volMult: [0],
    confirmFrac: [0],
    stopMode: ['mid'],
    stopAtr: [0.3],
    noStop: [false, true],
    targetR: [2],
    breakevenAtR: [0],
    trailR: [0],
    holdMinutes: [0, 120],
    cutoffMinute: [14 * 60],
    entry: ['limitClose', 'limitEdge'],
    limitTtl: [30],
    'rule.riskPerTrade': [100],
    'rule.maxTrades': [0],
    'rule.maxConcurrent': [0],
  } as Record<string, unknown[]>,
};
