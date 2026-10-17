// r2_vwaprev — fade an extreme stretch away from session VWAP back toward VWAP.
//
// Stretch distance (param `dist`, "<mode>:<x>"):
//   atr:x  — |close − VWAP| ≥ x × 14-day daily ATR (known at 09:30 from dailyBefore)
//   pct:x  — |close − VWAP| ≥ x % of VWAP
//   band:x — |close − VWAP| ≥ x × session volume-weighted st.dev. of typical price around VWAP (VWAP bands)
// A stretch bar arms the setup (optionally only if it is an exhaustion bar: range ≥ `exhaust` × avg range of the
// last 20 bars). Within `recent` bars, a signal bar (optionally a confirmation bar closing back toward VWAP, i.e.
// below the previous close and red for a short) that is still ≥ half the threshold away triggers the fade.
// Stop (`stop`): ext:k = beyond the stretch extreme + k ATR; atr:k = signal close ± k ATR; pct:x = ± x %.
// Target (`tgt`): vwap:f = f × distance to VWAP (converted to R, capped 0.5..6R); r:x = fixed R; none.
// Entry (`entry`): mkt | lim:o:ttl = LIMIT at signal close shifted o ATR in our favour (sell higher / buy lower).
// noStop: size from the stop but exit only by target/time/flatten (requires holdMin or a target).
// Window (`win`): "a-b" minutes after 09:30 in which signals may fire. One trade per symbol per day.
// Look-ahead: universe uses meta + dailyBefore only; onMinute folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  minPrice: number;
  maxPrice: number;
  win: string;
  direction: 'both' | 'long' | 'short' | 'fade-gap';
  dist: string;
  exhaust: number;
  confirm: boolean;
  recent: number;
  stop: string;
  tgt: string;
  entry: string;
  noStop: boolean;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
}

interface S {
  seen: number;
  pv: number; pv2: number; vol: number;
  vwap: number; sd: number;
  atr: number;
  ranges: number[]; rsum: number;
  stretchUp: number; stretchDn: number;
  stretchHi: number; stretchLo: number;
  prev?: Bar; last?: Bar;
  n: number;
}

const OPEN = 9 * 60 + 30;
const cache = new Map<string, [string, number, number]>();
function spec(s: string): [string, number, number] {
  let v = cache.get(s);
  if (!v) {
    const [m, a, b] = s.split(':');
    v = [m, Number(a ?? 0), Number(b ?? 0)];
    cache.set(s, v);
  }
  return v;
}
const winCache = new Map<string, [number, number]>();
function win(s: string): [number, number] {
  let v = winCache.get(s);
  if (!v) { const [a, b] = s.split('-').map(Number); v = [a, b]; winCache.set(s, v); }
  return v;
}

// ATR from daily bars strictly before the date; cached per (date, symbol) across configurations (no look-ahead).
const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const k = ctx.date + '|' + sym;
  let v = atrCache.get(k);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(k, v); }
  return v;
}

function mk(p: P, minute: number, sym: string, close: number, atr: number, stretchLo: number, stretchHi: number,
  side: 'long' | 'short', distToVwap: number, tag: string): Signal | undefined {
  const [sMode, sX] = spec(p.stop);
  const [tMode, tX] = spec(p.tgt);
  const [eMode, eOff, eTtl] = spec(p.entry);
  const dir = side === 'long' ? 1 : -1;
  const ref = eMode === 'lim' ? close - dir * eOff * atr : close;
  let stop: number;
  if (sMode === 'ext') stop = side === 'long' ? stretchLo - sX * atr : stretchHi + sX * atr;
  else if (sMode === 'atr') stop = ref - dir * sX * atr;
  else stop = ref * (1 - (dir * sX) / 100);
  const risk = (ref - stop) * dir;
  if (!(risk > 0)) return undefined;
  let targetR: number | undefined;
  if (tMode === 'vwap') {
    const tr = (tX * (distToVwap + (eMode === 'lim' ? eOff * atr : 0))) / risk;
    if (tr < 0.5) return undefined;
    targetR = Math.min(tr, 6);
  } else if (tMode === 'r') targetR = tX;
  const exitMinute = p.holdMin ? minute + p.holdMin : undefined;
  if (p.noStop && !exitMinute && targetR === undefined) return undefined;
  const sig: Signal = {
    symbol: sym, side, stop, targetR, tag,
    breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute,
    noStop: p.noStop || undefined,
  };
  if (eMode === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = eTtl || 5; }
  return sig;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const strategy: Strategy<P> = {
  name: 'r2_vwaprev',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < p.minPrice || m.open > p.maxPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return !m.tags.includes('index');
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    const [w0, w1] = win(p.win);
    const [dMode, dX] = spec(p.dist);
    // Symbols with bars (the watched universe), recomputed until all have appeared; cheap per minute after that.
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms || rel < 30 || rel % 30 === 0) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = {
          seen: 0, pv: 0, pv2: 0, vol: 0, vwap: NaN, sd: 0, atr: atrFor(ctx, sym), ranges: [], rsum: 0,
          stretchUp: -1, stretchDn: -1, stretchHi: -Infinity, stretchLo: Infinity, n: 0,
        };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const tp = (b.h + b.l + b.c) / 3;
        s.pv += tp * b.v; s.pv2 += tp * tp * b.v; s.vol += b.v;
        const vw = s.vol > 0 ? s.pv / s.vol : b.c;
        s.vwap = vw;
        s.sd = s.vol > 0 ? Math.sqrt(Math.max(0, s.pv2 / s.vol - vw * vw)) : 0;
        const unit = dMode === 'atr' ? dX * s.atr : dMode === 'pct' ? (dX / 100) * vw : dX * s.sd;
        const range = b.h - b.l;
        const avgR = s.ranges.length ? s.rsum / s.ranges.length : range;
        const big = p.exhaust <= 0 || (s.ranges.length >= 10 && range >= p.exhaust * avgR);
        const ok = unit > 0 && s.n >= 5; // need a few bars for VWAP/band to mean something
        if (ok && b.h - vw >= unit && big) { s.stretchUp = s.n; s.stretchHi = b.h; }
        else if (s.stretchUp >= 0) s.stretchHi = Math.max(s.stretchHi, b.h);
        if (ok && vw - b.l >= unit && big) { s.stretchDn = s.n; s.stretchLo = b.l; }
        else if (s.stretchDn >= 0) s.stretchLo = Math.min(s.stretchLo, b.l);
        s.ranges.push(range); s.rsum += range;
        if (s.ranges.length > 20) s.rsum -= s.ranges.shift()!;
        s.prev = s.last; s.last = b; s.n++;
      }
      if (rel < w0 || rel > w1) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !s.prev) continue;
      const b = s.last, pr = s.prev, vw = s.vwap, atr = s.atr;
      const unit = dMode === 'atr' ? dX * atr : dMode === 'pct' ? (dX / 100) * vw : dX * s.sd;
      if (!(unit > 0)) continue;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allowShort = p.direction === 'both' || p.direction === 'short' || (p.direction === 'fade-gap' && gapUp);
      const allowLong = p.direction === 'both' || p.direction === 'long' || (p.direction === 'fade-gap' && !gapUp);
      const recentUp = s.stretchUp >= 0 && s.n - 1 - s.stretchUp <= p.recent;
      const recentDn = s.stretchDn >= 0 && s.n - 1 - s.stretchDn <= p.recent;
      const up = b.c - vw, dn = vw - b.c;

      if (allowShort && recentUp && up >= 0.5 * unit && (!p.confirm || (b.c < pr.c && b.c < b.o))) {
        const sig = mk(p, ctx.minute, sym, b.c, atr, s.stretchLo, s.stretchHi, 'short', up, 'rv-short');
        if (sig) cands.push({ sig, score: up / unit });
      } else if (allowLong && recentDn && dn >= 0.5 * unit && (!p.confirm || (b.c > pr.c && b.c > b.o))) {
        const sig = mk(p, ctx.minute, sym, b.c, atr, s.stretchLo, s.stretchHi, 'long', dn, 'rv-long');
        if (sig) cands.push({ sig, score: dn / unit });
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// wf run 1 (360 cfgs, risk 100, default limits): windows 15-60/60-120/120-240/240-355/15-355 × both/fade-gap ×
//   atr:0.6/pct:2.5/band:2.5 × stops ext:0.15/atr:0.3/atr:0.6 × tgt vwap:1/r:1.5 × mkt/lim:0.03:5 → WF −41.8R, FAIL.
// wf run 2: risk tiers × entry type (market vs two limits) × wider stops, default limits. Grid narrowed using run-1
//   full-period ranking (windows 15-60, 240-355 kept plus the whole day; atr:0.6 and band:2.5; vwap target).
//   → WF −41.1R, FAIL (risk tier changed full-period R by only ~1–2R per config; costs are small with wide stops).
// wf run 3: account limits OFF (no daily loss limit, unlimited trades/losses/concurrency) × exits (vwap target /
//   3R / none; trailing 1R; 60-min time exit; no-stop) × market vs limit, risk 100.
//   → WF +21.1R but FAIL (t 0.36, 2/4 months, PF 1.05, stress −16R). Full-period leaders were all noStop (time/flatten
//   exits) with single-trade losses down to −19.9R: nominal R hides unbounded tail risk.
// wf run 4 (shaped by run 3): replace noStop with very WIDE real stops (1–1.5 daily ATR, or stretch extreme + 0.5 ATR),
//   limits off, vwap or 1R target, optional 60-min time exit, market vs limit, risk 50 vs 500.
export default {
  strategy,
  grid: {
    universe: ['gap'], minGap: [3], minPrice: [5], maxPrice: [150],
    win: ['15-60', '240-355', '15-355'],
    direction: ['both', 'fade-gap'],
    dist: ['atr:0.6', 'band:2.5'],
    exhaust: [0], confirm: [true], recent: [10],
    stop: ['atr:1', 'atr:1.5', 'ext:0.5'],
    tgt: ['vwap:1', 'r:1'],
    entry: ['mkt', 'lim:0.03:5'],
    noStop: [false], breakevenAtR: [0], trailR: [0], holdMin: [0, 60],
    'rule.riskPerTrade': [50, 500],
    'rule.dailyLossLimit': [0], 'rule.maxTrades': [0], 'rule.maxLosses': [0], 'rule.maxConcurrent': [0],
  },
};
