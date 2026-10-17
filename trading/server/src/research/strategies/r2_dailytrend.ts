// r2_dailytrend — intraday pullback entries only in the direction of the multi-day (daily-bar) trend.
// Daily classification (from ctx.dailyBefore, i.e. known at 09:30):
//   trend 'ma'    : up if close > SMA20, SMA10 > SMA20 and close > SMA50 (when 50 bars exist); down mirror.
//   trend 'mom'   : up if 20-day return > mom % and 5-day return > 0; down mirror.
//   trend 'hilo'  : up if close within prox daily-ATR of the 20-day high (and above SMA20); down mirror at the low.
//   trend 'score' : sum of ±1 votes [c>SMA10, c>SMA20, c>SMA50, SMA10>SMA20, r20>0, r5>0] ≥ minScore (≤ −minScore).
//   trend 'none'  : control — the same intraday entries in BOTH directions on every name (measures the filter).
//   trend 'anti'  : control — only AGAINST the daily trend (score definition).
// Intraday setups (signal bars of barMin minutes, after startMin and before endMin minutes past 09:30):
//   setup 'vwap'  : price held on the trend side of session VWAP for ≥ minHold signal bars and extended ≥ ext ATR
//                   away, then the first pullback touches VWAP (low ≤ VWAP + tol ATR for longs).
//   setup 'orh'   : a signal bar closed beyond the opening-range high (orMin minutes), price extended ≥ ext ATR
//                   beyond it, then the first pullback retests it (low ≤ ORH + tol ATR) without closing more than
//                   pierce ATR back inside.
//   setup 'either': whichever comes first.
// Entry: 'market' — after the touch, a signal bar closes beyond the previous bar's extreme (and on the trend side
//                   of the level) within maxWait bars → market at the next open;
//        'retrace'— same confirmation, LIMIT at close − lFrac × (close − stop);
//        'level'  — no confirmation: once extended and approaching (close within near ATR of the level), rest a
//                   LIMIT at level + lOff ATR (long) — i.e. "buy the first pullback to the level".
// Stops: 'pb' = beyond min(pullback low, level) by stopBuf ATR; 'atr' = entry reference ∓ stopAtr daily ATR.
// noStop sizes from the stop but exits only by target / time / close. One trade per symbol per day.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  trend: 'ma' | 'mom' | 'hilo' | 'score' | 'none' | 'anti';
  mom: number;           // 'mom': min |20-day return| %
  prox: number;          // 'hilo': ATR distance from the 20-day extreme
  minScore: number;      // 'score'/'anti'
  side: 'both' | 'long' | 'short';
  setup: 'vwap' | 'orh' | 'either';
  orMin: number;
  barMin: number;
  startMin: number;
  endMin: number;
  minHold: number;
  ext: number;
  tol: number;
  pierce: number;
  maxWait: number;
  entry: 'market' | 'retrace' | 'level';
  lFrac: number;
  lOff: number;
  near: number;
  ttl: number;
  stopMode: 'pb' | 'atr';
  stopBuf: number;
  stopAtr: number;
  targetR: number;       // 0 = none
  breakevenAtR: number;  // 0 = off
  trailR: number;        // 0 = off
  holdMin: number;       // 0 = off
  noStop: boolean;
}

interface Daily { atr: number; c: number; sma10: number; sma20: number; sma50: number; r5: number; r20: number; hi20: number; lo20: number }
interface Bk { k: number; o: number; h: number; l: number; c: number }
interface Side { run: number; ext: number; touch: number; pb: number; done: boolean; broke: boolean }
interface S {
  seen: number; d?: Daily; up: boolean; dn: boolean; sc: string;
  pv: number; vol: number; vwap: number;
  orH: number; orL: number;
  cur?: Bk; prev?: Bk; last?: Bk; lastVwap: number; nb: number; fresh: boolean;
  vL: Side; vS: Side; oL: Side; oS: Side;
}

const OPEN = 9 * 60 + 30;
const newSide = (): Side => ({ run: 0, ext: 0, touch: -1, pb: NaN, done: false, broke: false });
const sma = (c: number[], n: number) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : NaN);

const dailyCache = new Map<string, Daily | null>();
function dailyFor(ctx: DayContext, sym: string): Daily | null {
  const key = ctx.date + '|' + sym;
  let v = dailyCache.get(key);
  if (v !== undefined) return v;
  const bars: Bar[] = ctx.dailyBefore(sym);
  v = null;
  if (bars.length >= 25) {
    const b = bars.slice(-15);
    let tr = 0;
    for (let i = 1; i < b.length; i++) tr += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    const c = bars.map((x) => x.c);
    const last = c[c.length - 1];
    const l20 = bars.slice(-20);
    v = {
      atr: tr / (b.length - 1), c: last, sma10: sma(c, 10), sma20: sma(c, 20), sma50: sma(c, 50),
      r5: last / c[c.length - 6] - 1, r20: last / c[c.length - 21] - 1,
      hi20: Math.max(...l20.map((x) => x.h)), lo20: Math.min(...l20.map((x) => x.l)),
    };
  }
  dailyCache.set(key, v);
  return v;
}

function score(d: Daily): number {
  const v = (x: boolean) => (x ? 1 : -1);
  let s = v(d.c > d.sma10) + v(d.c > d.sma20) + v(d.sma10 > d.sma20) + v(d.r20 > 0) + v(d.r5 > 0);
  if (Number.isFinite(d.sma50)) s += v(d.c > d.sma50);
  return s;
}

/** Compact daily-trend features for the trade tag (analysis only). */
function describe(d: Daily): string {
  const ma = classify(d, { trend: 'ma' } as P);
  return `sc=${score(d)};ma=${ma[0] ? 'U' : ma[1] ? 'D' : 'N'};r20=${(d.r20 * 100).toFixed(1)};hi=${((d.hi20 - d.c) / d.atr).toFixed(2)};lo=${((d.c - d.lo20) / d.atr).toFixed(2)}`;
}

/** Daily trend classification → [allowLong, allowShort]. */
function classify(d: Daily, p: P): [boolean, boolean] {
  switch (p.trend) {
    case 'none': return [true, true];
    case 'ma': {
      const f50 = Number.isFinite(d.sma50);
      return [d.c > d.sma20 && d.sma10 > d.sma20 && (!f50 || d.c > d.sma50), d.c < d.sma20 && d.sma10 < d.sma20 && (!f50 || d.c < d.sma50)];
    }
    case 'mom': return [d.r20 > p.mom / 100 && d.r5 > 0, d.r20 < -p.mom / 100 && d.r5 < 0];
    case 'hilo': return [d.c >= d.hi20 - p.prox * d.atr && d.c > d.sma20, d.c <= d.lo20 + p.prox * d.atr && d.c < d.sma20];
    case 'score': { const s = score(d); return [s >= p.minScore, s <= -p.minScore]; }
    case 'anti': { const s = score(d); return [s <= -p.minScore, s >= p.minScore]; }
  }
}

/** Update one side's pullback state machine with a completed signal bar against `level` (dir +1 long, −1 short). */
function step(st: Side, bk: Bk, level: number, dir: number, a: number, p: P, nb: number, isOrh: boolean) {
  if (st.done || !Number.isFinite(level)) return;
  const cl = (bk.c - level) * dir;                 // signed close distance on the trend side
  const exc = dir > 0 ? bk.h - level : level - bk.l; // excursion beyond the level
  const pull = dir > 0 ? bk.l - level : level - bk.h; // how close the counter-extreme got (≤ tol·a = touch)
  if (st.touch >= 0) {
    if (cl < -p.pierce * a || nb - st.touch > p.maxWait) { st.done = true; return; } // failed / expired: first pullback only
    st.pb = dir > 0 ? Math.min(st.pb, bk.l) : Math.max(st.pb, bk.h);
    return;
  }
  if (isOrh) {
    if (!st.broke) { if (cl > 0) { st.broke = true; st.run = 1; st.ext = Math.max(0, exc); } return; }
    if (cl < -p.pierce * a) { st.done = true; return; }
  } else if (cl < -p.pierce * a) { st.run = 0; st.ext = 0; return; }
  if (st.run >= p.minHold && st.ext >= p.ext * a && pull <= p.tol * a) { st.touch = nb; st.pb = dir > 0 ? bk.l : bk.h; return; }
  st.run++;
  st.ext = Math.max(st.ext, exc);
}

function complete(s: S, bk: Bk, p: P, a: number, orDone: boolean) {
  const vw = s.vwap;
  step(s.vL, bk, vw, 1, a, p, s.nb, false);
  step(s.vS, bk, vw, -1, a, p, s.nb, false);
  if (orDone) { step(s.oL, bk, s.orH, 1, a, p, s.nb, true); step(s.oS, bk, s.orL, -1, a, p, s.nb, true); }
  s.prev = s.last; s.last = bk; s.lastVwap = vw; s.nb++; s.fresh = true;
}

const strategy: Strategy<P> = {
  name: 'r2_dailytrend',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < 5) return false;
        if (p.universe === 'gap' && !m.tags.includes('gap')) return false;
        if (p.universe === 'liquid' && !(m.tags.includes('liquid') || m.tags.includes('index'))) return false;
        const d = dailyFor(ctx, m.symbol);
        if (!d || !(d.atr > 0)) return false;
        const [L, S] = classify(d, p);
        return (L && p.side !== 'short') || (S && p.side !== 'long');
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
        const d = dailyFor(ctx, sym) ?? undefined;
        const [L, Sh] = d ? classify(d, p) : [false, false];
        s = {
          seen: 0, d, up: L && p.side !== 'short', dn: Sh && p.side !== 'long', sc: d ? describe(d) : '', pv: 0, vol: 0, vwap: NaN, orH: -Infinity, orL: Infinity,
          lastVwap: NaN, nb: 0, fresh: false, vL: newSide(), vS: newSide(), oL: newSide(), oS: newSide(),
        };
        ctx.state.set(sym, s);
      }
      if (!s.d || (!s.up && !s.dn)) { s.seen = bars.length; continue; }
      const a = s.d.atr;
      s.fresh = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const k = Math.floor((bm - OPEN) / p.barMin);
        if (s.cur && s.cur.k !== k) { complete(s, s.cur, p, a, OPEN + s.cur.k * p.barMin >= OPEN + p.orMin); s.cur = undefined; }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        if (bm < OPEN + p.orMin) { s.orH = Math.max(s.orH, b.h); s.orL = Math.min(s.orL, b.l); }
        if (!s.cur) s.cur = { k, o: b.o, h: b.h, l: b.l, c: b.c };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      if (s.cur && ctx.minute >= OPEN + (s.cur.k + 1) * p.barMin) {
        complete(s, s.cur, p, a, OPEN + s.cur.k * p.barMin >= OPEN + p.orMin);
        s.cur = undefined;
      }
      if (!s.fresh || rel < p.startMin || rel > p.endMin) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !s.prev) continue;
      const b = s.last, pr = s.prev;
      const common = {
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined, noStop: p.noStop || undefined,
      };
      const opts: [Side, number, number, string][] = [];
      if (s.up) {
        if (p.setup !== 'orh') opts.push([s.vL, s.lastVwap, 1, 'vw']);
        if (p.setup !== 'vwap') opts.push([s.oL, s.orH, 1, 'or']);
      }
      if (s.dn) {
        if (p.setup !== 'orh') opts.push([s.vS, s.lastVwap, -1, 'vw']);
        if (p.setup !== 'vwap') opts.push([s.oS, s.orL, -1, 'or']);
      }
      for (const [st, lvl, d, nm] of opts) {
        if (st.done || !Number.isFinite(lvl)) continue;
        const side = d > 0 ? 'long' as const : 'short' as const;
        let sig: Signal | undefined;
        if (p.entry === 'level') {
          if (st.touch >= 0 || st.run < p.minHold || st.ext < p.ext * a || (nm === 'or' && !st.broke)) continue;
          const dist = (b.c - lvl) * d;
          if (dist <= 0 || dist > p.near * a) continue;
          const lim = Math.round((lvl + d * p.lOff * a) * 100) / 100;
          const stop = p.stopMode === 'pb' ? lvl - d * p.stopBuf * a : lim - d * p.stopAtr * a;
          sig = { symbol: sym, side, stop, entryLimit: lim, limitTtl: p.ttl, ...common, tag: `${nm}L-${side}|${s.sc}` };
          st.done = true;
        } else {
          const t = st.touch;
          if (t < 0 || t >= s.nb - 1) continue;
          if (d > 0 ? !(b.c > pr.h && b.c > lvl) : !(b.c < pr.l && b.c < lvl)) continue;
          const ref = d > 0 ? Math.min(st.pb, lvl) : Math.max(st.pb, lvl);
          const stop = p.stopMode === 'pb' ? ref - d * p.stopBuf * a : b.c - d * p.stopAtr * a;
          if (p.entry === 'market') sig = { symbol: sym, side, stop, ...common, tag: `${nm}M-${side}|${s.sc}` };
          else {
            const lim = Math.round((b.c - d * p.lFrac * Math.abs(b.c - stop)) * 100) / 100;
            sig = { symbol: sym, side, stop, entryLimit: lim, limitTtl: p.ttl, ...common, tag: `${nm}R-${side}|${s.sc}` };
          }
          st.done = true;
        }
        cands.push({ sig, score: st.ext / a });
        break;
      }
    }
    return cands.sort((x, y) => y.score - x.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    universe: ['all'], trend: ['score', 'mom'], mom: [3], prox: [0.5], minScore: [2], side: ['both', 'long'],
    setup: ['orh'], orMin: [30], barMin: [5], startMin: [30], endMin: [330],
    minHold: [3], ext: [0.3], tol: [0.1], pierce: [0.05], maxWait: [3],
    entry: ['level', 'retrace'], lFrac: [0.3], lOff: [0.02], near: [0.15], ttl: [5, 15],
    stopMode: ['atr'], stopBuf: [0.05], stopAtr: [0.3], targetR: [0], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false, true],
    'rule.riskPerTrade': [50, 200], 'rule.maxTrades': [3, 0], 'rule.maxConcurrent': [0], 'rule.dailyLossLimit': [0],
  },
};
