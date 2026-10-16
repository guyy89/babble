// orbvar: opening-range breakout variants.
//   Type 1 (short range): orMinutes 3/5/10, usually 1-minute signal bars.
//   Type 2 (long range):  orMinutes 30/60, usually 5-minute signal bars.
// Same mechanics for both; the type is just the range length. Pattern copied from orb.ts:
// universe() uses only 09:30 info (meta), onMinute() folds in newly closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  orMinutes: number;          // opening range length (3,5,10 = short; 30,60 = long)
  barMinutes: number;         // signal bar length (bucket aligned to 09:30)
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;             // |gap| % to qualify
  minPrice: number;
  maxPrice: number;
  maxSymbols: number;         // candidates per day (largest |gap| first)
  direction: 'both' | 'with-gap' | 'long';
  vwapFilter: boolean;
  stopMode: 'far' | 'mid' | 'frac'; // far side of range / mid-range / breakout level -/+ stopFrac*range
  stopFrac: number;
  targetR: number;            // 0 = no fixed target
  trailR: number;             // 0 = off
  breakevenAtR: number;       // 0 = off
  holdMinutes: number;        // time exit N minutes after entry (0 = off)
  cutoffMinutes: number;      // no entries later than OPEN + this (0 = harness default)
  volMult: number;            // signal-bucket avg volume/minute >= volMult * avg volume/minute since open (0 = off)
  maxRangePct: number;        // skip if range wider than this % of price (0 = off)
}

interface S {
  hi: number; lo: number; pv: number; vol: number; seen: number;
  nBars: number;              // bars before the current signal bucket (for volume average)
  volBefore: number;          // volume of those bars
  lastClose?: number; lastMinute?: number;
}

const OPEN = 9 * 60 + 30;

const strategy: Strategy<P> = {
  name: 'orbvar',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && m.open >= p.minPrice && m.open <= p.maxPrice && m.avgVolume >= 100_000)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const rangeEnd = OPEN + p.orMinutes;
    const bucketStart = ctx.minute - p.barMinutes;
    const evalNow = ctx.minute >= rangeEnd + p.barMinutes && (ctx.minute - OPEN) % p.barMinutes === 0
      && (!p.cutoffMinutes || ctx.minute <= OPEN + p.cutoffMinutes);
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { hi: -Infinity, lo: Infinity, pv: 0, vol: 0, seen: 0, nBars: 0, volBefore: 0 }));
      // Fold in bars that closed since the last call; all have minute < ctx.minute.
      let bucketVol = 0, bucketN = 0;
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
      // Volume of the bucket that just closed vs. average per-minute volume before it.
      // Recompute from the tail (bucket is at most barMinutes bars).
      for (let i = bars.length - 1; i >= 0; i--) {
        const bm = ctx.minuteOf(bars[i].t);
        if (bm < bucketStart) break;
        bucketVol += bars[i].v; bucketN++;
      }
      const volBefore = s.vol - bucketVol;
      const minutesBefore = bucketStart - OPEN;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.hi)) continue;
      if (s.lastMinute === undefined || s.lastMinute < bucketStart) continue; // no bar in the signal bucket
      const close = s.lastClose!;
      const range = s.hi - s.lo;
      if (p.maxRangePct && (range / close) * 100 > p.maxRangePct) continue;
      if (p.volMult) {
        const avgBefore = minutesBefore > 0 ? volBefore / minutesBefore : 0;
        if (!(avgBefore > 0) || bucketVol / p.barMinutes < p.volMult * avgBefore) continue;
      }
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const gapUp = ctx.meta[sym].gapPct > 0;
      let side: 'long' | 'short' | undefined;
      const longOk = p.direction === 'both' || (p.direction === 'with-gap' ? gapUp : true);
      const shortOk = p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
      if (close > s.hi && (!p.vwapFilter || close > vwap) && longOk) side = 'long';
      else if (close < s.lo && (!p.vwapFilter || close < vwap) && shortOk) side = 'short';
      if (!side) continue;
      let stop: number;
      if (p.stopMode === 'mid') stop = (s.hi + s.lo) / 2;
      else if (p.stopMode === 'frac') stop = side === 'long' ? s.hi - p.stopFrac * range : s.lo + p.stopFrac * range;
      else stop = side === 'long' ? s.lo : s.hi;
      out.push({
        symbol: sym, side, stop,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        tag: `${side}-or${p.orMinutes}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    orMinutes: [10, 15], barMinutes: [1, 5], tags: ['gap'], minGap: [3], minPrice: [10], maxPrice: [80], maxSymbols: [6, 8, 10], direction: ['with-gap'], vwapFilter: [true], stopMode: ['far'], stopFrac: [1], targetR: [4], trailR: [0], breakevenAtR: [0, 1], holdMinutes: [0], cutoffMinutes: [60], volMult: [0], maxRangePct: [0],
  },
};
