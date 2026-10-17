// r2_flag — bull/bear flag on N-minute bars.
//  1. Impulse ("pole"): over poleBars aggregated bars the price travels ≥ imp from an extreme to the opposite
//     extreme (low → later high for a bull flag), measured against the stock's volatility:
//       imp = 'dX'  → X × daily ATR(14) (from daily bars strictly before today)
//       imp = 'iX'  → X × average aggregated-bar range so far today (needs ≥ 6 completed bars)
//     and the pole must be directional (net close-to-close move over the pole ≥ 60% of the travel).
//  2. Flag: the next F bars (fMin ≤ F ≤ fMax) make no new extreme beyond the pole top (+ 5%-of-impulse
//     tolerance), retrace ≤ maxRetrace of the impulse, and their whole range is ≤ tight × impulse.
//     Optional volume check: average flag-bar volume ≤ average pole-bar volume.
//  3. Trigger: the newest completed bar closes beyond the flag extreme in the impulse direction.
//     Entry at market (next bar open) or LIMIT back at the breakout level ('retest') or halfway ('half').
//  4. Stop beyond the flag ('flag': flag low/high ∓ 2% of impulse) or at the flag midpoint ('mid').
// No look-ahead: universe() uses ctx.meta/ctx.dailyBefore only; onMinute() folds only closed bars (ctx.bars)
// incrementally and evaluates only fully completed aggregated bars.
// Speed: pattern detection is a pure function of (date, closed bars, pattern params), so its per-minute output
// is cached per day and shared by configurations that differ only in entry/exit/rule params. Position-dependent
// filters (open/traded, time window) are applied per configuration afterwards.
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'both';
  direction: 'both' | 'with-gap' | 'long';
  barMin: number;          // aggregated bar size (minutes)
  poleBars: number;        // impulse window (aggregated bars)
  imp: string;             // 'd0.3' (× daily ATR) or 'i3' (× avg intraday bar range)
  fMin: number;
  fMax: number;
  tight: number;           // flag range ≤ tight × impulse
  maxRetrace: number;      // flag retrace ≤ maxRetrace × impulse
  volCheck: boolean;       // flag volume ≤ pole volume
  startMin: number;        // earliest trigger-bar start minute (NY minute-of-day; 570 = 09:30)
  endMin: number;          // latest trigger-bar start minute
  oncePerSymbol: boolean;
  stopMode: 'flag' | 'mid';
  entry: 'market' | 'retest' | 'half';
  ttl: number;             // limit TTL minutes
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // time exit N minutes after the signal (0 = off)
  noStop: boolean;         // no protective stop: exits only by target/time (requires holdMin)
}

interface Agg { idx: number; o: number; h: number; l: number; c: number; v: number }
interface S { seen: number; cur?: Agg; done: Agg[]; atr: number; rngSum: number }
interface Cand { sym: string; side: 'long' | 'short'; F: number; fh: number; fl: number; impulse: number; trigC: number }
interface Det { states: Map<string, S>; byMinute: Map<number, Cand[]>; last: number }

const OPEN = 9 * 60 + 30;
let cacheDate = '';
const cache = new Map<string, Det>();

function dailyAtr(ctx: DayContext, sym: string): number {
  const d = ctx.dailyBefore(sym).slice(-15);
  if (d.length < 6) return NaN;
  let sum = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc));
  }
  return sum / (d.length - 1);
}

/** Flag candidates whose trigger bar completed just before ctx.minute (uses closed bars only). */
function detect(ctx: MinuteContext, p: P, det: Det): Cand[] {
  const out: Cand[] = [];
  const m = ctx.minute;
  const completeIdx = (m - OPEN) / p.barMin - 1;
  const mode = p.imp[0];
  const impK = Number(p.imp.slice(1));
  for (const sym of Object.keys(ctx.meta)) {
    const bars = ctx.bars(sym);
    if (!bars.length) continue;
    let s = det.states.get(sym);
    if (!s) det.states.set(sym, (s = { seen: 0, done: [], atr: dailyAtr(ctx, sym), rngSum: 0 }));
    for (; s.seen < bars.length; s.seen++) {
      const b = bars[s.seen];
      const idx = Math.floor((ctx.minuteOf(b.t) - OPEN) / p.barMin);
      if (s.cur && s.cur.idx !== idx) { s.done.push(s.cur); s.rngSum += s.cur.h - s.cur.l; s.cur = undefined; }
      if (!s.cur) s.cur = { idx, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; s.cur.v += b.v; }
    }
    // The bucket ending just before this minute is complete (all its minutes have closed): close it.
    if (s.cur && s.cur.idx === completeIdx) { s.done.push(s.cur); s.rngSum += s.cur.h - s.cur.l; s.cur = undefined; }
    const A = s.done;
    const n = A.length;
    if (!n || A[n - 1].idx !== completeIdx) continue; // no fresh completed bar

    let vol: number;
    if (mode === 'd') vol = impK * s.atr;
    else { if (n < 6) continue; vol = impK * (s.rngSum / n); }
    if (!(vol > 0)) continue;

    const trig = A[n - 1];
    const gapUp = ctx.meta[sym].gapPct > 0;
    // Flag = A[fs .. n-2]; grown one bar at a time as F increases.
    let fh = -Infinity, fl = Infinity, fv = 0;
    for (let i = Math.max(0, n - p.fMin); i < n - 1; i++) { fh = Math.max(fh, A[i].h); fl = Math.min(fl, A[i].l); fv += A[i].v; }
    let found: Cand | undefined;
    for (let F = p.fMin; F <= p.fMax && !found; F++) {
      const fs = n - 1 - F;               // flag start index
      const ps = fs - p.poleBars;         // pole start index
      if (ps < 0) break;
      fh = Math.max(fh, A[fs].h); fl = Math.min(fl, A[fs].l); fv += A[fs].v;
      if (!(trig.c > fh || trig.c < fl)) break; // the flag only widens with F, so no larger F can trigger
      let ph = -Infinity, pl = Infinity, phI = 0, plI = 0, pv = 0;
      for (let i = ps; i < fs; i++) {
        if (A[i].h > ph) { ph = A[i].h; phI = i; }
        if (A[i].l < pl) { pl = A[i].l; plI = i; }
        pv += A[i].v;
      }
      const impulse = ph - pl;
      if (impulse < vol) continue;
      if (p.volCheck && fv / F > pv / p.poleBars) continue;
      if (fh - fl > p.tight * impulse) continue;
      const net = A[fs - 1].c - (ps > 0 ? A[ps - 1].c : A[ps].o);
      const longOk = p.direction !== 'with-gap' || gapUp;
      const shortOk = p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
      if (longOk && plI < phI && net >= 0.6 * impulse && fh <= ph + 0.05 * impulse && ph - fl <= p.maxRetrace * impulse && trig.c > fh)
        found = { sym, side: 'long', F, fh, fl, impulse, trigC: trig.c };
      else if (shortOk && phI < plI && -net >= 0.6 * impulse && fl >= pl - 0.05 * impulse && fh - pl <= p.maxRetrace * impulse && trig.c < fl)
        found = { sym, side: 'short', F, fh, fl, impulse, trigC: trig.c };
    }
    if (found) out.push(found);
  }
  return out;
}

const strategy: Strategy<P> = {
  name: 'r2_flag',
  universe(ctx: DayContext, p: P) {
    const ms = Object.values(ctx.meta).filter((m) => !m.tags.includes('index') && m.open >= 5);
    const gap = ms.filter((m) => m.tags.includes('gap'));
    const liq = ms.filter((m) => m.tags.includes('liquid'));
    const u = p.universe === 'gap' ? gap : p.universe === 'liquid' ? liq : [...gap, ...liq];
    return [...new Set(u.map((m) => m.symbol))];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const m = ctx.minute;
    if ((m - OPEN) % p.barMin !== 0) return out;
    if (cacheDate !== ctx.date) { cacheDate = ctx.date; cache.clear(); }
    const key = [p.universe, p.direction, p.barMin, p.poleBars, p.imp, p.fMin, p.fMax, p.tight, p.maxRetrace, p.volCheck].join('|');
    let det = cache.get(key);
    if (!det) cache.set(key, (det = { states: new Map(), byMinute: new Map(), last: 0 }));
    let cands = det.byMinute.get(m);
    if (!cands) {
      // Minutes are visited in order; a later config re-reads what the first one computed.
      if (m <= det.last) throw new Error('r2_flag: detection cache out of order');
      cands = detect(ctx, p, det);
      det.byMinute.set(m, cands);
      det.last = m;
    }
    const trigStart = m - p.barMin;
    if (trigStart < p.startMin || trigStart > p.endMin) return out;
    for (const c of cands) {
      if (ctx.open.has(c.sym) || (p.oncePerSymbol && ctx.traded.has(c.sym))) continue;
      const long = c.side === 'long';
      const lvl = long ? c.fh : c.fl;
      const stop = p.stopMode === 'flag' ? (long ? c.fl - 0.02 * c.impulse : c.fh + 0.02 * c.impulse) : (c.fh + c.fl) / 2;
      const sig: Signal = { symbol: c.sym, side: c.side, stop, tag: `${long ? 'L' : 'S'}${c.F}` };
      if (p.entry === 'retest') sig.entryLimit = Math.round(lvl * 100) / 100;
      else if (p.entry === 'half') sig.entryLimit = Math.round(((lvl + c.trigC) / 2) * 100) / 100;
      // Stop must be on the losing side of the expected entry (market: ≈ trigger close; limit: the limit).
      const ref = sig.entryLimit ?? c.trigC;
      if (long ? stop >= ref : stop <= ref) continue;
      if (sig.entryLimit !== undefined) sig.limitTtl = p.ttl;
      if (p.targetR > 0) sig.targetR = p.targetR;
      if (p.breakevenAtR > 0) sig.breakevenAtR = p.breakevenAtR;
      if (p.trailR > 0) sig.trailR = p.trailR;
      if (p.holdMin > 0) sig.exitMinute = m + p.holdMin;
      if (p.noStop) { if (!(p.holdMin > 0)) continue; sig.noStop = true; }
      out.push(sig);
    }
    return out;
  },
};

const base = {
  universe: ['both'], direction: ['both'], barMin: [1], poleBars: [5], imp: ['d0.3'], fMin: [2], fMax: [6],
  tight: [0.5], maxRetrace: [0.5], volCheck: [false], startMin: [OPEN + 5], endMin: [15 * 60 + 15], oncePerSymbol: [false],
  stopMode: ['flag'], entry: ['market'], ttl: [5], targetR: [2], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false],
  'rule.riskPerTrade': [100],
};

// Run 1 (384): universe gap|liquid, barMin 1|2|5, poleBars 3|6, imp d0.25|d0.4|i3|i5, tight 0.35|0.6,
//   stopMode flag|mid, targetR 0|2 — liquid names, poleBars 6 and no fixed target dominated full-period R.
// Run 2 (768): liquid only; direction both|long, barMin 2|5, poleBars 6|10, imp d0.4|i3, tight 0.35|0.6, stopMode,
//   targetR 0|3, trailR 0|2, entry market|retest|half. WF −14.4R. Best full-period: barMin 2, pole 6, tight 0.35, hold.
// Run 3 (256): fixed pattern area from runs 1–2 (shaped by their full-period results, which include test months);
//   risk tiers × day limits on/off (daily loss limit stays at its default 3× risk) × market vs limit entry.
//   WF +3.2R (PF 0.96). Risk tier barely changed R; market beat retest limits; maxLosses off slightly better.
// Run 4 (384): same pattern (i3), risk 100: exits (targets, breakeven, time exit, no-stop + time exit),
//   daily loss limit default (300 = 3R) vs off, limit TTL 3 vs 10.
//   WF −9.8R (PF 1.13). No-stop + 60-min time exit had the best full-period R; months 4–5 negative in every run.
// Run 5 (128): pre-specified textbook variant on the 'gap' names (not shaped by earlier results): flags only in the
//   gap direction, ATR-scaled pole, volume contraction optional, stop beyond the flag, 2–3R targets, breakeven.
//   WF −35.5R (t −1.96, PF 0.75): no edge. Verdict over 5 runs: no robust edge (see report).
export default {
  strategy,
  grid: {
    ...base,
    universe: ['gap'], direction: ['with-gap'], volCheck: [true, false], barMin: [1, 2], poleBars: [4, 8], imp: ['d0.3', 'd0.5'],
    tight: [0.5], maxRetrace: [0.38, 0.5], stopMode: ['flag'], targetR: [2, 3], breakevenAtR: [0, 1], entry: ['market'],
    'rule.riskPerTrade': [100],
  },
};
