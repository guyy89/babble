// Measured move / ABCD.
// A zigzag (reversal threshold = zz × the symbol's prior 14-day average daily range, so no look-ahead) is run
// incrementally on N-minute bars. A bullish ABCD is pivots A (low) → B (high) → C (low) with leg AB ≥ minLeg × ADR
// and a pullback BC of rMin..rMax of AB; the bearish pattern mirrors it. Target D = C ± AB (measured move).
// Entry variants:
//   'break'     — market, when a completed bar closes back beyond B (C is confirmed by then); stop at C (stopFrac 1)
//                 or part-way from B toward C (stopFrac < 1).
//   'breakLim'  — on the same trigger, a LIMIT at B (retest of the breakout level) with TTL; same stop.
//   'limitC'    — as soon as B is confirmed (price has fallen zz back from it) and a pullback is under way, a LIMIT at
//                 B − fib × AB (the anticipated C); stop at B − stopFib × AB; target D = limit + AB.
// Targets: tgt = -1 → the measured move D expressed in R from the signal reference price; 0 → none; >0 → fixed R.
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore; onMinute() folds only closed 1-minute bars.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'both';
  minGap: number;
  maxSymbols: number;
  direction: 'both' | 'long' | 'with-gap';
  barMinutes: number;
  zz: number;        // zigzag reversal, × ADR
  minLeg: number;    // AB ≥ minLeg × ADR
  rMin: number;      // BC retracement bounds, fraction of AB
  rMax: number;
  entry: 'break' | 'breakLim' | 'limitC';
  stopFrac: number;  // break*: stop = B − stopFrac × (B − C)
  fib: number;       // limitC: limit at B − fib × AB
  stopFib: number;   // limitC: stop at B − stopFib × AB
  ttl: number;       // limit TTL (minutes)
  tgt: number;       // -1 measured move, 0 none, >0 fixed R
  breakevenAtR: number;
  trailR: number;
  holdMin: number;   // time exit after N minutes (0 = off)
  noStop: boolean;
  startMin: number;  // earliest signal minute-of-day
  endMin: number;    // latest signal minute-of-day
  maxPerSym: number;
}

interface Piv { px: number; hi: boolean }
interface S {
  seen: number;
  adr: number;
  // current bucket
  bo?: number; bh: number; bl: number; bc: number;
  // zigzag
  dir: 0 | 1 | -1; ext: number; ext0hi: number; ext0lo: number; piv: Piv[];
  firedFor: number;   // number of pivots when the last signal was emitted (one signal per pattern)
  count: number;
}

const OPEN = 9 * 60 + 30;

// ADR from daily bars strictly before the date; cached per symbol+date (pure function of past data).
const adrCache = new Map<string, number>();
function adr(ctx: DayContext, sym: string): number {
  const k = sym + '|' + ctx.date;
  let v = adrCache.get(k);
  if (v === undefined) adrCache.set(k, (v = adrOf(ctx.dailyBefore(sym))));
  return v;
}

function adrOf(daily: Bar[]): number {
  const d = daily.slice(-14);
  if (d.length < 5) return 0;
  return d.reduce((a, b) => a + (b.h - b.l), 0) / d.length;
}

/** Fold one completed N-minute bar into the zigzag. Returns true when a new pivot was confirmed. */
function zig(s: S, h: number, l: number, thr: number): boolean {
  if (s.dir === 0) {
    const lo0 = s.ext0lo, hi0 = s.ext0hi;
    if (h - lo0 >= thr && h > hi0) { s.piv.push({ px: lo0, hi: false }); s.dir = 1; s.ext = h; return true; }
    if (hi0 - l >= thr && l < lo0) { s.piv.push({ px: hi0, hi: true }); s.dir = -1; s.ext = l; return true; }
    s.ext0hi = Math.max(hi0, h); s.ext0lo = Math.min(lo0, l);
    return false;
  }
  if (s.dir === 1) {
    if (h > s.ext) { s.ext = h; return false; }
    if (s.ext - l >= thr) { s.piv.push({ px: s.ext, hi: true }); s.dir = -1; s.ext = l; return true; }
    return false;
  }
  if (l < s.ext) { s.ext = l; return false; }
  if (h - s.ext >= thr) { s.piv.push({ px: s.ext, hi: false }); s.dir = 1; s.ext = h; return true; }
  return false;
}

const strategy: Strategy<P> = {
  name: 'r2_measured',
  universe(ctx: DayContext, p: P) {
    const metas = Object.values(ctx.meta).filter((m) => !m.tags.includes('index'));
    const gap = metas.filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct)).slice(0, p.maxSymbols).map((m) => m.symbol);
    const liq = metas.filter((m) => m.tags.includes('liquid')).map((m) => m.symbol);
    const u = p.universe === 'gap' ? gap : p.universe === 'liquid' ? liq : [...gap, ...liq];
    return [...new Set(u)].filter((s) => adr(ctx, s) > 0);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, adr: adr(ctx, sym), bh: -Infinity, bl: Infinity, bc: 0, dir: 0, ext: 0, ext0hi: -Infinity, ext0lo: Infinity, piv: [], firedFor: -1, count: 0 };
        ctx.state.set(sym, s);
      }
      if (!(s.adr > 0)) continue;
      const thr = p.zz * s.adr;
      let completed = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        if (s.bo === undefined) { s.bo = b.o; s.bh = b.h; s.bl = b.l; }
        else { s.bh = Math.max(s.bh, b.h); s.bl = Math.min(s.bl, b.l); }
        s.bc = b.c;
        const bm = ctx.minuteOf(b.t);
        if ((bm - OPEN + 1) % p.barMinutes === 0) {
          zig(s, s.bh, s.bl, thr);
          completed = bm === ctx.minute - 1;
          s.bo = undefined; s.bh = -Infinity; s.bl = Infinity;
        }
      }
      if (!completed) continue;
      if (ctx.minute - 1 < p.startMin || ctx.minute - 1 > p.endMin) continue;
      if (ctx.open.has(sym) || s.count >= p.maxPerSym || s.firedFor === s.piv.length) continue;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allow = (long: boolean) => p.direction === 'both' || (p.direction === 'long' ? long : long === gapUp);
      const close = s.bc;
      const n = s.piv.length;
      let sig: Signal | undefined;

      if (p.entry === 'limitC') {
        // Pivots …A,B with the retracement from B under way (dir opposite to AB).
        if (n < 2) continue;
        const A = s.piv[n - 2].px, B = s.piv[n - 1].px;
        const long = s.piv[n - 1].hi; // B is a high → bullish AB, buy the pullback
        if ((long ? s.dir !== -1 : s.dir !== 1) || !allow(long)) continue;
        const ab = Math.abs(B - A);
        if (ab < p.minLeg * s.adr) continue;
        const d = long ? 1 : -1;
        const lim = B - d * p.fib * ab;
        const stop = B - d * p.stopFib * ab;
        // Price must still be above the limit (long) and the retracement not already past it.
        if (long ? !(close > lim && s.ext > lim) : !(close < lim && s.ext < lim)) continue;
        const rps = Math.abs(lim - stop);
        const tR = p.tgt < 0 ? ab / rps : p.tgt;
        sig = { symbol: sym, side: long ? 'long' : 'short', stop, entryLimit: +lim.toFixed(2), limitTtl: p.ttl, targetR: tR > 0 ? tR : undefined, tag: 'limitC' };
      } else {
        // Pivots …A,B,C with price now breaking back through B.
        if (n < 3) continue;
        const A = s.piv[n - 3].px, B = s.piv[n - 2].px, C = s.piv[n - 1].px;
        const long = s.piv[n - 2].hi;
        if ((long ? s.dir !== 1 : s.dir !== -1) || !allow(long)) continue;
        const ab = Math.abs(B - A);
        if (ab < p.minLeg * s.adr) continue;
        const retr = Math.abs(B - C) / ab;
        if (retr < p.rMin || retr > p.rMax) continue;
        if (long ? !(close > B) : !(close < B)) continue;
        const d = long ? 1 : -1;
        const stop = B - d * p.stopFrac * Math.abs(B - C);
        const ref = p.entry === 'breakLim' ? B : close;
        const rps = Math.abs(ref - stop);
        if (!(rps > 0)) continue;
        const D = C + d * ab;
        const tR = p.tgt < 0 ? (D - ref) * d / rps : p.tgt;
        if (p.tgt < 0 && !(tR > 0.3)) { s.firedFor = n; continue; }
        sig = { symbol: sym, side: long ? 'long' : 'short', stop, targetR: tR > 0 ? tR : undefined, tag: p.entry };
        if (p.entry === 'breakLim') { sig.entryLimit = +B.toFixed(2); sig.limitTtl = p.ttl; }
      }
      if (!sig) continue;
      if (p.breakevenAtR > 0) sig.breakevenAtR = p.breakevenAtR;
      if (p.trailR > 0) sig.trailR = p.trailR;
      if (p.holdMin > 0) sig.exitMinute = ctx.minute + p.holdMin;
      if (p.noStop) sig.noStop = true;
      s.firedFor = n;
      s.count++;
      out.push(sig);
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    universe: ["liquid", "gap"],
    minGap: [3],
    maxSymbols: [15],
    direction: ["with-gap", "both"],
    barMinutes: [1, 5],
    zz: [0.1, 0.2],
    minLeg: [0.2, 0.3],
    rMin: [0.382],
    rMax: [0.786],
    entry: ["break", "breakLim", "limitC"],
    stopFrac: [1],
    fib: [0.5],
    stopFib: [1],
    ttl: [15],
    tgt: [2, 0],
    breakevenAtR: [0],
    trailR: [0],
    holdMin: [0],
    noStop: [false, true],
    startMin: [9 * 60 + 40],
    endMin: [15 * 60],
    maxPerSym: [2],
    "rule.riskPerTrade": [100],
    "rule.maxTrades": [3],
    "rule.maxConcurrent": [0],
    "rule.dailyLossLimit": [0],
  },
};
