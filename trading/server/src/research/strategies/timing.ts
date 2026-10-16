// timing: two time-of-day strategies, selected by `variant`.
//   'drive' (opening drive): the first N-minute candle (N = 1/3/5) is strong — big body vs its own range,
//            big range vs the stock's typical daily range, close near the extreme → enter in its direction at
//            the next bar (09:30+N); stop at the candle's other end or its mid-point.
//   'power' (power hour): after the midday range (rangeStart..rangeEnd) is complete, the first 1-minute close
//            beyond it in the direction of the day's trend (vs open and/or VWAP) → go with the break; stop at the
//            range mid-point or other end; exit at the flatten time (or exitMinute).
// No look-ahead: universe() uses only ctx.meta / ctx.dailyBefore; onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, DayMeta, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'drive' | 'power';
  uni: 'gap' | 'liquid' | 'index' | 'gap+liquid' | 'liquid+index' | 'all';
  minGap: number;            // |gap| % required for 'gap'-tagged symbols (0 = any)
  minPrice: number;
  maxPrice: number;
  direction: 'both' | 'with-gap' | 'against-gap' | 'with-vwap' | 'with-open' | 'with-both';
  // drive
  n: number;                 // first-candle minutes
  minBody: number;           // |c-o| / (h-l)
  minRangeAtr: number;       // (h-l) / avg daily range (14d)
  closeFrac: number;         // close within this fraction of the range from the extreme
  stopAt: 'extreme' | 'mid';
  // power
  rangeStart: number;        // NY minute-of-day
  rangeEnd: number;
  lastEntry: number;         // NY minute-of-day for the last power entry
  breakBuf: number;          // close must exceed range by this fraction of the range
  maxRangeAtr: number;       // skip if the midday range is wider than this × avg daily range (0 = off)
  // exits
  targetR: number;           // 0 = none
  breakevenAtR: number;      // 0 = off
  trailR: number;            // 0 = off
  exitMinute: number;        // 0 = harness flatten
}

interface S {
  seen: number; pv: number; vol: number; dayOpen?: number; atr?: number;
  // first candle
  fo?: number; fh: number; fl: number; fc?: number; fn: number;
  // midday range
  mh: number; ml: number; mn: number; lastClose?: number;
  done: boolean;
}

const OPEN = 9 * 60 + 30;
const TAGS: Record<P['uni'], string[]> = {
  gap: ['gap'], liquid: ['liquid'], index: ['index'], 'gap+liquid': ['gap', 'liquid'], 'liquid+index': ['liquid', 'index'], all: ['gap', 'liquid', 'index'],
};

function avgRange(bars: Bar[], n = 14): number {
  const xs = bars.slice(-n);
  return xs.length ? xs.reduce((a, b) => a + (b.h - b.l), 0) / xs.length : 0;
}

function dirOk(p: P, side: 'long' | 'short', m: DayMeta, close: number, vwap: number, dayOpen: number): boolean {
  const up = side === 'long';
  switch (p.direction) {
    case 'both': return true;
    case 'with-gap': return up ? m.gapPct > 0 : m.gapPct < 0;
    case 'against-gap': return up ? m.gapPct < 0 : m.gapPct > 0;
    case 'with-vwap': return up ? close > vwap : close < vwap;
    case 'with-open': return up ? close > dayOpen : close < dayOpen;
    case 'with-both': return up ? close > vwap && close > dayOpen : close < vwap && close < dayOpen;
  }
}

const strategy: Strategy<P> = {
  name: 'timing',
  universe(ctx: DayContext, p: P) {
    const tags = TAGS[p.uni];
    return Object.values(ctx.meta)
      .filter((m) => m.tags.some((t) => tags.includes(t)))
      .filter((m) => !(m.tags.includes('gap') && !m.tags.includes('liquid') && !m.tags.includes('index')) || Math.abs(m.gapPct) >= p.minGap)
      .filter((m) => m.open >= p.minPrice && m.open <= p.maxPrice && m.avgVolume >= 50_000)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const exits = {
      targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined,
      trailR: p.trailR || undefined, exitMinute: p.exitMinute || undefined,
    };
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, pv: 0, vol: 0, fh: -Infinity, fl: Infinity, fn: 0, mh: -Infinity, ml: Infinity, mn: 0, done: false };
        s.atr = avgRange(ctx.dailyBefore(sym));
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        if (s.dayOpen === undefined) s.dayOpen = b.o;
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < OPEN + p.n) {
          if (s.fo === undefined) s.fo = b.o;
          s.fh = Math.max(s.fh, b.h); s.fl = Math.min(s.fl, b.l); s.fc = b.c; s.fn++;
        }
        if (bm >= p.rangeStart && bm < p.rangeEnd) { s.mh = Math.max(s.mh, b.h); s.ml = Math.min(s.ml, b.l); s.mn++; }
        s.lastClose = b.c;
      }
      if (s.done || ctx.traded.has(sym) || ctx.open.has(sym) || !s.atr) continue;
      const m = ctx.meta[sym];
      const close = s.lastClose!;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;

      if (p.variant === 'drive') {
        if (ctx.minute !== OPEN + p.n) continue;
        s.done = true;
        // The candle must start at the open bar (first bar at 09:30) and have most of its minutes.
        if (s.fo === undefined || ctx.minuteOf(bars[0].t) !== OPEN || s.fn < Math.ceil(p.n / 2)) continue;
        const rng = s.fh - s.fl;
        if (!(rng > 0)) continue;
        const body = s.fc! - s.fo;
        if (Math.abs(body) / rng < p.minBody || rng / s.atr < p.minRangeAtr) continue;
        const side = body > 0 ? 'long' : 'short';
        const nearExt = side === 'long' ? (s.fh - s.fc!) / rng : (s.fc! - s.fl) / rng;
        if (nearExt > p.closeFrac) continue;
        if (!dirOk(p, side, m, close, vwap, s.dayOpen!)) continue;
        const stop = p.stopAt === 'mid' ? (s.fh + s.fl) / 2 : side === 'long' ? s.fl : s.fh;
        cands.push({ sig: { symbol: sym, side, stop, ...exits, tag: `drive-${side}` }, score: rng / s.atr });
      } else {
        if (ctx.minute <= p.rangeEnd || ctx.minute > p.lastEntry || s.mn < 10) continue;
        const rng = s.mh - s.ml;
        if (!(rng > 0) || (p.maxRangeAtr > 0 && rng / s.atr > p.maxRangeAtr)) continue;
        let side: 'long' | 'short' | undefined;
        if (close > s.mh + p.breakBuf * rng) side = 'long';
        else if (close < s.ml - p.breakBuf * rng) side = 'short';
        if (!side) continue;
        // Only the first break counts; if it is against the trend, the symbol is done for the day.
        s.done = true;
        if (!dirOk(p, side, m, close, vwap, s.dayOpen!)) continue;
        const stop = p.stopAt === 'mid' ? (s.mh + s.ml) / 2 : side === 'long' ? s.ml : s.mh;
        cands.push({ sig: { symbol: sym, side, stop, ...exits, tag: `power-${side}` }, score: Math.abs(close - s.dayOpen!) / s.atr });
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    variant: ['drive'], uni: ['liquid', 'liquid+index'], minGap: [2], minPrice: [5], maxPrice: [1000],
    direction: ['both', 'with-gap'], n: [3, 5], minBody: [0.6], minRangeAtr: [0.1], closeFrac: [0.25],
    stopAt: ['extreme'], rangeStart: [720], rangeEnd: [870], lastEntry: [930], breakBuf: [0], maxRangeAtr: [0],
    targetR: [0, 2], breakevenAtR: [0, 1], trailR: [0], exitMinute: [0],
  },
};
