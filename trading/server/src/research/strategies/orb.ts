// Reference strategy (and template for new families): opening-range breakout.
// Pattern to copy: pick symbols in universe() from 09:30 info only; in onMinute() keep per-symbol
// state in ctx.state and update it incrementally from the newest closed bar (don't rescan all bars).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  orMinutes: number;      // opening range length
  barMinutes: number;     // signal bar length
  minGap: number;         // |gap| % to qualify
  maxSymbols: number;     // candidates per day (largest |gap| first)
  direction: 'both' | 'with-gap';
  vwapFilter: boolean;
  wideRangePct: number;   // range wider than this % of price → stop at mid-range
  targetR: number;
  breakevenAtR: number;   // 0 = off
}

interface S { hi: number; lo: number; pv: number; vol: number; seen: number; bucketClose?: number; bucketStart?: number }

const OPEN = 9 * 60 + 30;

const strategy: Strategy<P> = {
  name: 'orb',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap && m.open >= 10 && m.open <= 80 && m.avgVolume >= 100_000)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { hi: -Infinity, lo: Infinity, pv: 0, vol: 0, seen: 0 }));
      // Fold in bars that closed since the last call.
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < OPEN + p.orMinutes) { s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l); }
        s.bucketClose = b.c;
      }
      // Evaluate only when a signal bar has just completed after the range.
      if (ctx.minute < OPEN + p.orMinutes + p.barMinutes || (ctx.minute - OPEN) % p.barMinutes !== 0) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.hi)) continue;
      const close = s.bucketClose!;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const gapUp = ctx.meta[sym].gapPct > 0;
      let side: 'long' | 'short' | undefined;
      if (close > s.hi && (!p.vwapFilter || close > vwap) && (p.direction === 'both' || gapUp)) side = 'long';
      else if (close < s.lo && (!p.vwapFilter || close < vwap) && (p.direction === 'both' || !gapUp)) side = 'short';
      if (!side) continue;
      const wide = ((s.hi - s.lo) / close) * 100 > p.wideRangePct;
      const stop = wide ? (s.hi + s.lo) / 2 : side === 'long' ? s.lo : s.hi;
      out.push({ symbol: sym, side, stop, targetR: p.targetR, breakevenAtR: p.breakevenAtR || undefined, tag: side });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    orMinutes: [15], barMinutes: [5], minGap: [3], maxSymbols: [8], direction: ['both'], vwapFilter: [true],
    wideRangePct: [2], targetR: [2], breakevenAtR: [1],
  },
};
