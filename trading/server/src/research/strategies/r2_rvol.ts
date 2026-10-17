// r2_rvol — relative-volume surge + price break.
//
// Bars are aggregated into `barMin`-minute buckets aligned to 09:30. When a bucket completes (inside the
// decision window `win`, minutes after the open), the symbol qualifies when
//   rv  > 0: cumulative RVOL = volume so far today / (meta.avgVolume × typical fraction of a day's volume done
//            by this time) ≥ rv. The intraday volume curve PROFILE was measured once on the design months
//            (2026-04-16..06-15, liquid names, median) and is hard-coded (no look-ahead into test months);
//   fresh:   additionally RVOL was below rv at the previous bucket (the surge has just happened);
//   spk > 0: this bucket's volume ≥ spk × the average of the previous `look` buckets (needs ≥ 5 of them);
// and a price break defines the surge direction (`brk`):
//   hod    — the bucket closes above the prior session high (up) / below the prior session low (down);
//   strong — bucket range ≥ 1.5 × average bucket range, close in its top (bottom) 30% and close > (<) open;
//   either — hod or strong (hod first).
// `dir`: follow = trade with the surge direction; fade = against it. `side` filters the resulting trade side.
// Stop (`stop`): atr:k = entry reference ∓ k × daily ATR(14); bar:k = beyond the signal bucket's extreme
//   + k × bucket range (on the losing side of the trade). noStop always sizes from an ATR stop (the atr:k of `stop`, else `nsAtr`).
// Target (`tgt`): r:x | none. Entry (`entry`): mkt | lim:o:ttl = LIMIT o × bucket range better than the close.
// Multiple signals at one minute are ranked by RVOL (highest first); one entry per symbol per day.
// Look-ahead: universe uses meta + dailyBefore only; onMinute folds in closed 1-minute bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  barMin: number;
  win: string;
  rv: number;
  fresh: boolean;
  spk: number;
  look: number;
  brk: 'hod' | 'strong' | 'either';
  dir: 'follow' | 'fade';
  side: 'both' | 'long' | 'short' | 'with-gap';
  stop: string;
  tgt: string;
  entry: string;
  noStop: boolean;
  nsAtr: number;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
}

// Median cumulative fraction of the regular-session volume at 5-minute steps from 09:30 (0..390 min), measured on
// liquid names over the design months, times 0.75 (median regular-session volume / avgVolume) so a normal day has RVOL ≈ 1.
const PROFILE = [0,0.0416,0.064,0.0841,0.1023,0.1188,0.1347,0.1509,0.1653,0.1799,0.1941,0.2064,0.2184,0.2308,0.2421,0.2525,0.263,0.2732,0.2831,0.2943,0.304,0.3139,0.3236,0.3327,0.3423,0.3514,0.3594,0.3669,0.3755,0.3828,0.3903,0.3986,0.4059,0.4127,0.4198,0.4258,0.4324,0.44,0.4466,0.4522,0.4597,0.4656,0.4711,0.4775,0.4843,0.4904,0.497,0.5044,0.5108,0.5167,0.5227,0.5294,0.5346,0.5406,0.5462,0.5524,0.5585,0.5645,0.5701,0.5753,0.582,0.5878,0.5938,0.5996,0.6056,0.6127,0.6187,0.6266,0.6335,0.64,0.6473,0.6542,0.6612,0.6696,0.6782,0.687,0.6973,0.7147,0.75];
interface Bk { o: number; h: number; l: number; c: number; v: number; key: number }
interface S { seen: number; atr: number; cum: number; hi: number; lo: number; cur?: Bk; hist: { v: number; r: number }[]; prevRv: number }

const OPEN = 9 * 60 + 30;

function frac(el: number): number {
  const i = Math.min(Math.floor(el / 5), PROFILE.length - 2);
  const w = (el - i * 5) / 5;
  return PROFILE[i] + (PROFILE[i + 1] - PROFILE[i]) * w;
}

function spec(s: string): [string, number, number] {
  const [m, a, b] = s.split(':');
  return [m, Number(a ?? 0), Number(b ?? 0)];
}
const memo = <T>(f: (s: string) => T) => { const c = new Map<string, T>(); return (s: string) => { let v = c.get(s); if (v === undefined) { v = f(s); c.set(s, v); } return v; }; };
const specM = memo(spec);
const winM = memo((s: string) => s.split('-').map(Number) as [number, number]);

const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const k = ctx.date + '|' + sym;
  let v = atrCache.get(k);
  if (v === undefined) {
    const b = ctx.dailyBefore(sym).slice(-15);
    let s = 0;
    for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    v = b.length >= 6 ? s / (b.length - 1) : NaN;
    atrCache.set(k, v);
  }
  return v;
}

const strategy: Strategy<P> = {
  name: 'r2_rvol',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.avgVolume > 0 && !m.tags.includes('index') && (p.universe === 'all' ? true
        : p.universe === 'gap' ? m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap : m.tags.includes('liquid')))
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    const boundary = rel % p.barMin === 0;
    const [w0, w1] = winM(p.win);
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, atr: atrFor(ctx, sym), cum: 0, hi: -Infinity, lo: Infinity, hist: [], prevRv: 0 }));
      let done: Bk | undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const key = Math.floor((ctx.minuteOf(b.t) - OPEN) / p.barMin);
        if (s.cur && s.cur.key !== key) { // a stale bucket (missing bars) closes without a signal
          s.hist.push({ v: s.cur.v, r: s.cur.h - s.cur.l });
          s.hi = Math.max(s.hi, s.cur.h); s.lo = Math.min(s.lo, s.cur.l);
          s.cur = undefined;
        }
        s.cum += b.v;
        if (!s.cur) s.cur = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, key };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; s.cur.v += b.v; }
      }
      if (!boundary || !s.cur || s.cur.key !== rel / p.barMin - 1) continue;
      done = s.cur;
      s.cur = undefined;
      const m = ctx.meta[sym];
      const rv = s.cum / (m.avgVolume * Math.max(frac(rel), 0.01));
      const prevRv = s.prevRv;
      s.prevRv = rv;
      const n = Math.min(p.look, s.hist.length);
      let avgV = 0, avgR = 0;
      for (let i = s.hist.length - n; i < s.hist.length; i++) { avgV += s.hist[i].v; avgR += s.hist[i].r; }
      avgV /= Math.max(1, n); avgR /= Math.max(1, n);
      const prevHi = s.hi, prevLo = s.lo;
      const range = done.h - done.l;
      s.hist.push({ v: done.v, r: range });
      s.hi = Math.max(s.hi, done.h); s.lo = Math.min(s.lo, done.l);

      if (rel < w0 || rel > w1 || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (p.rv > 0 && (rv < p.rv || (p.fresh && prevRv >= p.rv))) continue;
      if (p.spk > 0 && (n < 5 || done.v < p.spk * avgV)) continue;
      // Surge direction from the price break.
      let up = 0;
      if (p.brk !== 'strong' && Number.isFinite(prevHi)) {
        if (done.c > prevHi) up = 1; else if (done.c < prevLo) up = -1;
      }
      if (!up && p.brk !== 'hod' && n >= 5 && range > 0 && range >= 1.5 * avgR) {
        const pos = (done.c - done.l) / range;
        if (done.c > done.o && pos >= 0.7) up = 1; else if (done.c < done.o && pos <= 0.3) up = -1;
      }
      if (!up) continue;
      const tradeDir = p.dir === 'follow' ? up : -up;
      const side = tradeDir === 1 ? 'long' : 'short';
      if (p.side === 'long' && side !== 'long') continue;
      if (p.side === 'short' && side !== 'short') continue;
      if (p.side === 'with-gap' && (m.gapPct > 0) !== (side === 'long')) continue;

      const [eMode, eOff, eTtl] = specM(p.entry);
      const ref = eMode === 'lim' ? done.c - tradeDir * eOff * range : done.c;
      const [sMode, sX] = specM(p.stop);
      let stop: number;
      if (p.noStop) stop = ref - tradeDir * (sMode === 'atr' ? sX : p.nsAtr) * s.atr;
      else if (sMode === 'atr') stop = ref - tradeDir * sX * s.atr;
      else stop = (tradeDir === 1 ? done.l : done.h) - tradeDir * sX * range;
      if (!Number.isFinite(stop) || !((ref - stop) * tradeDir > 0)) continue;
      const [tMode, tX] = specM(p.tgt);
      const targetR = tMode === 'r' ? tX : undefined;
      const exitMinute = p.holdMin ? ctx.minute + p.holdMin : undefined;
      const sig: Signal = {
        symbol: sym, side, stop, targetR, tag: `${p.dir}-${side}`,
        breakevenAtR: p.noStop ? undefined : p.breakevenAtR || undefined,
        trailR: p.noStop ? undefined : p.trailR || undefined,
        exitMinute, noStop: p.noStop || undefined,
      };
      if (eMode === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = eTtl || 5; }
      cands.push({ sig, score: rv });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  // wf run 2 — same core as run 1 (fixed from the design months: rv 1.5, brk either, atr:0.25 stop), varying the account
  // dimensions: risk tier, maxTrades / maxConcurrent on vs off, market vs LIMIT entries (offset, TTL), breakeven, noStop.
  grid: {
    universe: ['liquid'], minGap: [0], barMin: [1], win: ['15-240'], rv: [1.5], fresh: [false], spk: [0], look: [10],
    brk: ['either'], dir: ['fade'], side: ['both'], stop: ['atr:0.25'], tgt: ['r:3', 'none'], entry: ['mkt', 'lim:0.25:3', 'lim:0.5:5', 'lim:0.5:10'],
    noStop: [false, true], nsAtr: [0.25], breakevenAtR: [0, 1], trailR: [0], holdMin: [0],
    'rule.riskPerTrade': [50, 100, 200, 500], 'rule.maxTrades': [3, 0], 'rule.maxConcurrent': [2, 0],
  } as Record<string, unknown[]>,
};
