// VWAP family.
//  variant 'pullback': stock trending on one side of session VWAP (closes held on that side for a while and
//    extended away from it) pulls back to within `tol` daily-ATR of VWAP, then a bar closes back in the trend
//    direction → enter with the trend; stop beyond min(pullback extreme, VWAP) by `stopBuf` ATR.
//  variant 'revert': stock stretched ≥ `dist` daily-ATR from VWAP (optionally with an exhaustion bar) and a bar
//    closes back toward VWAP → fade; stop beyond the stretch extreme; target = fraction of the way to VWAP
//    (converted to R from the stop distance) or a fixed R.
// Distances are in units of the 14-day daily ATR (known at 09:30 from dailyBefore). State is updated
// incrementally from newly closed bars only; decisions use bars with t < ctx.minute.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'pullback' | 'revert';
  universe: 'gap' | 'liquid' | 'all';
  minPrice: number;
  maxPrice: number;
  minGap: number;          // gap universe only: |gap| % threshold
  startMin: number;        // minutes after 09:30 before entries allowed
  endMin: number;          // minutes after 09:30 after which no entries
  direction: 'both' | 'with-gap' | 'long';
  // pullback
  minHold: number;         // bars the trend must have closed on its side of VWAP before the touch
  ext: number;             // session extreme must be ≥ ext ATR beyond VWAP (trend strength)
  tol: number;             // touch = bar low within tol ATR of VWAP (long)
  maxWait: number;         // bars after the touch within which the resume bar must come
  // revert
  dist: number;            // stretch threshold in ATR
  exhaust: number;         // 0 = off; else stretch bar range ≥ exhaust × avg 1m range of last 20 bars
  confirm: boolean;        // revert: require a bar closing back toward VWAP (close beyond prev close)
  tgtFrac: number;         // revert: 0 = use targetR; else target this fraction of the way to VWAP
  // common
  stopBuf: number;         // ATR buffer beyond the stop reference
  targetR: number;
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = off; else time exit after this many minutes
}

interface S {
  seen: number;
  pv: number; vol: number;
  atr: number;
  above: number; below: number;          // consecutive closes above/below VWAP
  hiExt: number; loExt: number;          // max (h - vwap) / min (l - vwap) during current run, in $
  touchLong: number; touchShort: number; // minute index of the touch (-1 none)
  pbLow: number; pbHigh: number;         // pullback extreme since touch
  ranges: number[]; rsum: number;        // last 20 1m ranges
  stretchUp: number; stretchDn: number;  // bar index of last qualifying stretch (-1 none)
  stretchHi: number; stretchLo: number;  // extreme since stretch
  prev?: Bar; last?: Bar;
  vwap: number;
  n: number;
}

const OPEN = 9 * 60 + 30;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const strategy: Strategy<P> = {
  name: 'vwap',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < p.minPrice || m.open > p.maxPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid') || m.tags.includes('index');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = {
          seen: 0, pv: 0, vol: 0, atr: dailyAtr(ctx.dailyBefore(sym)), above: 0, below: 0, hiExt: 0, loExt: 0,
          touchLong: -1, touchShort: -1, pbLow: Infinity, pbHigh: -Infinity, ranges: [], rsum: 0,
          stretchUp: -1, stretchDn: -1, stretchHi: -Infinity, stretchLo: Infinity, vwap: NaN, n: 0,
        };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const vw = s.vol > 0 ? s.pv / s.vol : b.c;
        s.vwap = vw;
        const avgR = s.ranges.length ? s.rsum / s.ranges.length : b.h - b.l;
        const range = b.h - b.l;
        // --- pullback bookkeeping
        if (b.c > vw) { s.above++; s.below = 0; } else if (b.c < vw) { s.below++; s.above = 0; } else { s.above = 0; s.below = 0; }
        if (s.above === 0) { s.hiExt = 0; s.touchLong = -1; }
        if (s.below === 0) { s.loExt = 0; s.touchShort = -1; }
        if (s.touchLong >= 0 && s.n - s.touchLong > p.maxWait) s.touchLong = -1;
        if (s.touchShort >= 0 && s.n - s.touchShort > p.maxWait) s.touchShort = -1;
        if (s.above > 0) {
          // touch while the run is established: low comes within tol of VWAP
          if (s.touchLong < 0 && s.above > p.minHold && s.hiExt >= p.ext * s.atr && b.l - vw <= p.tol * s.atr) { s.touchLong = s.n; s.pbLow = b.l; }
          else if (s.touchLong >= 0) s.pbLow = Math.min(s.pbLow, b.l);
          if (s.touchLong < 0) s.hiExt = Math.max(s.hiExt, b.h - vw);
        }
        if (s.below > 0) {
          if (s.touchShort < 0 && s.below > p.minHold && s.loExt >= p.ext * s.atr && vw - b.h <= p.tol * s.atr) { s.touchShort = s.n; s.pbHigh = b.h; }
          else if (s.touchShort >= 0) s.pbHigh = Math.max(s.pbHigh, b.h);
          if (s.touchShort < 0) s.loExt = Math.max(s.loExt, vw - b.l);
        }
        // --- reversion bookkeeping
        const big = p.exhaust <= 0 || (s.ranges.length >= 10 && range >= p.exhaust * avgR);
        if (b.h - vw >= p.dist * s.atr && big) { s.stretchUp = s.n; s.stretchHi = b.h; }
        else if (s.stretchUp >= 0) s.stretchHi = Math.max(s.stretchHi, b.h);
        if (vw - b.l >= p.dist * s.atr && big) { s.stretchDn = s.n; s.stretchLo = b.l; }
        else if (s.stretchDn >= 0) s.stretchLo = Math.min(s.stretchLo, b.l);
        s.ranges.push(range); s.rsum += range;
        if (s.ranges.length > 20) s.rsum -= s.ranges.shift()!;
        s.prev = s.last; s.last = b; s.n++;
      }
      if (rel < p.startMin || rel > p.endMin) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !s.prev) continue;
      const b = s.last, pr = s.prev, vw = s.vwap, atr = s.atr;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allowLong = p.direction !== 'with-gap' || gapUp;
      const allowShort = p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
      const common = { breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined };

      if (p.variant === 'pullback') {
        // resume: touch happened (not on this bar), within maxWait, this bar closes up above prev high and above VWAP
        if (allowLong && s.touchLong >= 0 && s.touchLong < s.n - 1 && s.n - 1 - s.touchLong <= p.maxWait && b.c > pr.h && b.c > vw) {
          const stop = Math.min(s.pbLow, vw) - p.stopBuf * atr;
          cands.push({ sig: { symbol: sym, side: 'long', stop, targetR: p.targetR, ...common, tag: 'pb-long' }, score: s.hiExt / atr });
        } else if (allowShort && s.touchShort >= 0 && s.touchShort < s.n - 1 && s.n - 1 - s.touchShort <= p.maxWait && b.c < pr.l && b.c < vw) {
          const stop = Math.max(s.pbHigh, vw) + p.stopBuf * atr;
          cands.push({ sig: { symbol: sym, side: 'short', stop, targetR: p.targetR, ...common, tag: 'pb-short' }, score: s.loExt / atr });
        }
      } else {
        // fade a stretch above VWAP (short) / below VWAP (long); stretch must be recent (≤ 10 bars)
        const upD = (b.c - vw) / atr, dnD = (vw - b.c) / atr;
        const recentUp = s.stretchUp >= 0 && s.n - 1 - s.stretchUp <= 10;
        const recentDn = s.stretchDn >= 0 && s.n - 1 - s.stretchDn <= 10;
        const mk = (side: 'long' | 'short', stop: number, dist: number, tag: string): Signal | undefined => {
          const risk = Math.abs(b.c - stop);
          if (!(risk > 0)) return undefined;
          const tr = p.tgtFrac > 0 ? (p.tgtFrac * dist) / risk : p.targetR;
          if (tr < 0.5) return undefined;
          return { symbol: sym, side, stop, targetR: Math.min(tr, 6), ...common, tag };
        };
        if (allowShort && recentUp && upD > 0.5 * p.dist && (!p.confirm || (b.c < pr.c && b.c < b.o))) {
          const sig = mk('short', s.stretchHi + p.stopBuf * atr, b.c - vw, 'rv-short');
          if (sig) cands.push({ sig, score: upD });
        } else if (allowLong && recentDn && dnD > 0.5 * p.dist && (!p.confirm || (b.c > pr.c && b.c > b.o))) {
          const sig = mk('long', s.stretchLo - p.stopBuf * atr, vw - b.c, 'rv-long');
          if (sig) cands.push({ sig, score: dnD });
        }
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

const base = {
  minPrice: [5], maxPrice: [1000], minGap: [3], direction: ['both'],
  breakevenAtR: [0], trailR: [0], holdMin: [0],
};

export default {
  strategy,
  grid: {
    ...base,
    variant: ['revert'], universe: ['gap'], startMin: [60], endMin: [120],
    minHold: [0], ext: [0], tol: [0], maxWait: [0],
    dist: [0.6, 0.7, 0.8], exhaust: [1.2, 1.5, 2], confirm: [true], tgtFrac: [1.15, 1.3, 1.6],
    stopBuf: [0.03], targetR: [1.5],
  },
};
