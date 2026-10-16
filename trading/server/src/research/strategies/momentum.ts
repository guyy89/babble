// Momentum family: two intraday continuation setups.
//  variant 'hod'  — session high/low breakout after the opening period: the just-closed bar closes beyond the
//                   session extreme set by earlier bars, optionally on above-average volume (vs the symbol's own
//                   average bar volume so far today) and only if that extreme is "aged" (set ≥ minAge minutes ago).
//  variant 'flag' — impulse + tight consolidation: an impulse of ≥ impPct % over impBars bars, then consBars bars
//                   whose range is ≤ tight × impulse and that retrace ≤ maxRetrace of it; enter when the newest
//                   bar closes beyond the consolidation in the impulse direction; stop beyond the consolidation.
// No look-ahead: universe() uses ctx.meta only; onMinute() uses only ctx.bars (closed before ctx.minute) and
// state folded incrementally from them. Entries fill at the next bar's open (harness).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'hod' | 'flag';
  universe: 'gap' | 'liquid' | 'both';
  minPrice: number;
  maxPrice: number;
  minGap: number;          // |gap| % for 'gap' symbols
  maxSymbols: number;
  direction: 'both' | 'long' | 'with-gap';
  startMin: number;        // earliest minute-of-day of the trigger bar
  endMin: number;          // latest minute-of-day of the trigger bar
  volMult: number;         // trigger-bar volume ≥ volMult × average bar volume so far (0 = off)
  // hod
  minAge: number;          // minutes since the prior session extreme was set (0 = any)
  stopBars: number;        // hod: stop beyond the extreme of the last stopBars bars
  // flag
  impBars: number;
  impPct: number;
  impAtr: number;          // flag: if > 0, impulse threshold = impAtr × average 1-min bar range so far (replaces impPct)
  consBars: number;
  consSpan: number;        // flag: also accept consolidations up to consBars + consSpan bars long
  tight: number;
  maxRetrace: number;
  // risk / exits
  minStopPct: number;      // widen stop to at least this % of price
  maxStopPct: number;      // skip if stop farther than this % of price
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // time exit after this many minutes (0 = off)
}

interface S { seen: number; hi: number; lo: number; hiMin: number; loMin: number; vol: number; n: number; rng: number }

const strategy: Strategy<P> = {
  name: 'momentum',
  universe(ctx: DayContext, p: P) {
    const ok = (m: { open: number; tags: string[] }) => !m.tags.includes('index') && m.open >= p.minPrice && m.open <= p.maxPrice;
    const metas = Object.values(ctx.meta).filter(ok);
    const gap = metas.filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct)).slice(0, p.maxSymbols).map((m) => m.symbol);
    const liq = metas.filter((m) => m.tags.includes('liquid')).map((m) => m.symbol);
    const u = p.universe === 'gap' ? gap : p.universe === 'liquid' ? liq : [...gap, ...liq];
    return [...new Set(u)];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, hi: -Infinity, lo: Infinity, hiMin: 0, loMin: 0, vol: 0, n: 0, rng: 0 }));
      // Fold in all new bars except the newest; the newest is the trigger candidate compared to the prior state.
      let fresh = false;
      while (s.seen < bars.length) {
        // Before folding the newest bar, evaluate it (only if it is the bar that closed at minute-1).
        if (s.seen === bars.length - 1) { fresh = true; break; }
        fold(s, bars[s.seen], ctx);
        s.seen++;
      }
      if (!fresh) continue;
      const last = bars[bars.length - 1];
      const lm = ctx.minuteOf(last.t);
      let sig: Signal | undefined;
      if (lm === ctx.minute - 1 && lm >= p.startMin && lm <= p.endMin && !ctx.traded.has(sym) && !ctx.open.has(sym) && s.n >= 5) {
        sig = p.variant === 'hod' ? hod(sym, bars, s, lm, ctx, p) : flag(sym, bars, s, ctx, p);
      }
      fold(s, last, ctx);
      s.seen++;
      if (sig) out.push(sig);
    }
    return out;
  },
};

function fold(s: S, b: Bar, ctx: MinuteContext) {
  const m = ctx.minuteOf(b.t);
  if (b.h > s.hi) { s.hi = b.h; s.hiMin = m; }
  if (b.l < s.lo) { s.lo = b.l; s.loMin = m; }
  s.vol += b.v;
  s.rng += b.h - b.l;
  s.n++;
}

function sideAllowed(sym: string, side: 'long' | 'short', ctx: MinuteContext, p: P) {
  if (p.direction === 'both') return true;
  if (p.direction === 'long') return side === 'long';
  return (ctx.meta[sym].gapPct > 0) === (side === 'long');
}

function volOk(last: Bar, s: S, p: P) {
  return !p.volMult || (s.n > 0 && last.v >= p.volMult * (s.vol / s.n));
}

function finish(sym: string, side: 'long' | 'short', rawStop: number, px: number, ctx: MinuteContext, p: P, tag: string): Signal | undefined {
  const long = side === 'long';
  const minDist = (px * p.minStopPct) / 100;
  let stop = rawStop;
  if (long ? px - stop < minDist : stop - px < minDist) stop = long ? px - minDist : px + minDist;
  if ((Math.abs(px - stop) / px) * 100 > p.maxStopPct) return undefined;
  return {
    symbol: sym, side, stop,
    targetR: p.targetR || undefined,
    breakevenAtR: p.breakevenAtR || undefined,
    trailR: p.trailR || undefined,
    exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined,
    tag,
  };
}

function hod(sym: string, bars: Bar[], s: S, lm: number, ctx: MinuteContext, p: P): Signal | undefined {
  const last = bars[bars.length - 1];
  let side: 'long' | 'short' | undefined;
  if (last.c > s.hi && lm - s.hiMin >= p.minAge) side = 'long';
  else if (last.c < s.lo && lm - s.loMin >= p.minAge) side = 'short';
  if (!side || !sideAllowed(sym, side, ctx, p) || !volOk(last, s, p)) return undefined;
  let ext = side === 'long' ? Infinity : -Infinity;
  for (let i = Math.max(0, bars.length - p.stopBars); i < bars.length; i++) ext = side === 'long' ? Math.min(ext, bars[i].l) : Math.max(ext, bars[i].h);
  return finish(sym, side, ext, last.c, ctx, p, `hod-${side}`);
}

function flag(sym: string, bars: Bar[], s: S, ctx: MinuteContext, p: P): Signal | undefined {
  // Shortest qualifying consolidation length in [consBars, consBars + consSpan].
  for (let n = p.consBars; n <= p.consBars + p.consSpan; n++) {
    const sig = flagN(sym, bars, s, ctx, p, n);
    if (sig) return sig;
  }
  return undefined;
}

function flagN(sym: string, bars: Bar[], s: S, ctx: MinuteContext, p: P, consBars: number): Signal | undefined {
  const k = bars.length - 1;
  const start = k - consBars - p.impBars;
  if (start < 0) return undefined;
  // Require roughly contiguous bars (sparse feeds would stretch the pattern over a long time).
  if (ctx.minuteOf(bars[k].t) - ctx.minuteOf(bars[start].t) > Math.round((consBars + p.impBars + 1) * 1.5)) return undefined;
  const impEnd = k - consBars - 1;
  const move = bars[impEnd].c - bars[start].o;
  const last = bars[k];
  if (p.impAtr > 0 ? Math.abs(move) < p.impAtr * (s.rng / s.n) : (Math.abs(move) / last.c) * 100 < p.impPct) return undefined;
  let ch = -Infinity, cl = Infinity;
  for (let i = impEnd + 1; i < k; i++) { ch = Math.max(ch, bars[i].h); cl = Math.min(cl, bars[i].l); }
  if (ch - cl > p.tight * Math.abs(move)) return undefined;
  const side: 'long' | 'short' = move > 0 ? 'long' : 'short';
  if (side === 'long') {
    if (cl < bars[impEnd].c - p.maxRetrace * move || !(last.c > ch)) return undefined;
  } else {
    if (ch > bars[impEnd].c - p.maxRetrace * move || !(last.c < cl)) return undefined;
  }
  if (!sideAllowed(sym, side, ctx, p) || !volOk(last, s, p)) return undefined;
  return finish(sym, side, side === 'long' ? cl : ch, last.c, ctx, p, `flag-${side}`);
}

const base = {
  universe: ['gap'], minPrice: [5], maxPrice: [300], minGap: [2], maxSymbols: [15], direction: ['both'],
  minStopPct: [0.3], maxStopPct: [3], targetR: [2], breakevenAtR: [0], trailR: [0], holdMin: [0],
  minAge: [0], stopBars: [5], impBars: [8], impPct: [1.5], impAtr: [0], consBars: [5], consSpan: [0], tight: [0.4], maxRetrace: [0.5],
};

export default {
  strategy,
  grid: {
    ...base,
    variant: ['hod'],
    universe: ['gap'],
    direction: ['both'],
    startMin: [600],
    endMin: [780, 900],
    minAge: [60, 120],
    stopBars: [20],
    minStopPct: [0.8],
    volMult: [2],
    targetR: [0, 3],
    trailR: [0, 1.5],
    holdMin: [0, 60],
  },
};
