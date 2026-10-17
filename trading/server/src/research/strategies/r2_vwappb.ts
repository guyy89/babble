// r2_vwappb — VWAP pullback in a trend.
// A stock that has held on one side of session VWAP (consecutive signal-bar closes on that side, with an
// excursion of at least `ext` daily-ATR away from VWAP) pulls back to within `tol` ATR of VWAP (the "touch").
// Entry with the trend, three ways:
//   entry 'market'  : after the touch, a signal bar closes beyond the previous bar's extreme and on the trend
//                     side of VWAP (the resumption bar) → market at the next minute's open.
//   entry 'retrace' : same resumption signal, but a LIMIT at signal close − lFrac × (close − stop) (long).
//   entry 'vwap'    : no confirmation — while the trend is established and price is approaching VWAP
//                     (close within `near` ATR of it), rest a LIMIT at VWAP + lOff ATR (long).
// Stop: beyond min(pullback low, VWAP) by stopBuf ATR (stopMode 'pb'), or entry-reference ∓ stopAtr ATR ('atr').
// Signal bars are `barMin` minutes long, built from closed 1-minute bars; VWAP is the cumulative session VWAP
// from 1-minute bars. ATR = 14-day daily ATR from dailyBefore (known at 09:30). One trade per symbol per day.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;          // gap universe: |gap| % threshold
  barMin: number;          // signal bar length (minutes)
  startMin: number;        // minutes after 09:30 before entries allowed
  endMin: number;          // minutes after 09:30 after which no new entries
  direction: 'both' | 'with-gap' | 'long';
  minHold: number;         // signal bars closed on the trend side before a touch counts
  ext: number;             // excursion from VWAP during the run, in ATR
  tol: number;             // touch: bar low ≤ VWAP + tol ATR (long)
  pierce: number;          // closes up to pierce ATR on the wrong side of VWAP don't break the run
  slope: boolean;          // require VWAP rising (long) over the last 30 minutes
  maxWait: number;         // resumption must come within this many signal bars after the touch
  entry: 'market' | 'retrace' | 'vwap';
  lFrac: number;           // retrace: fraction of signal risk to wait for
  lOff: number;            // vwap: limit offset from VWAP in ATR (positive = above VWAP for longs)
  near: number;            // vwap: place limit when close within this many ATR of VWAP
  ttl: number;             // limit TTL (minutes)
  stopMode: 'pb' | 'atr';
  stopBuf: number;         // pb: ATR beyond the pullback/VWAP reference
  stopAtr: number;         // atr: fixed distance from the entry reference
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = off; time exit after this many minutes
  noStop: boolean;         // true: size from stop but exit only by target/time
  reentry: boolean;        // allow another entry in a symbol already traded (needs a new setup)
}

interface Bk { k: number; o: number; h: number; l: number; c: number }

interface S {
  seen: number;
  atr: number;
  pv: number; vol: number; vwap: number;
  vwHist: number[];          // VWAP after each 1-minute bar
  cur?: Bk;                  // bucket under construction
  prev?: Bk; last?: Bk;      // last two completed signal bars
  lastVwap: number;          // VWAP at the close of `last`
  nb: number;                // completed signal bars
  above: number; below: number;
  hiExt: number; loExt: number;
  touchL: number; touchS: number;   // signal-bar index of the touch (-1 none)
  pbLow: number; pbHigh: number;
  lastSig: number;           // signal-bar index of the last emitted signal (-1 none)
  fresh: boolean;            // a signal bar completed since the last decision
}

const OPEN = 9 * 60 + 30;

// ATR depends only on (date, symbol) and daily bars strictly before the date: memoise across configurations.
const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const key = ctx.date + '|' + sym;
  let v = atrCache.get(key);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(key, v); }
  return v;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

/** Fold a completed signal bar into the trend/touch state. */
function complete(s: S, bk: Bk, p: P) {
  const vw = s.vwap;
  const a = s.atr;
  if (bk.c >= vw - p.pierce * a) s.above++; else { s.above = 0; s.hiExt = 0; s.touchL = -1; }
  if (bk.c <= vw + p.pierce * a) s.below++; else { s.below = 0; s.loExt = 0; s.touchS = -1; }
  if (s.touchL >= 0 && s.nb - s.touchL > p.maxWait) s.touchL = -1;
  if (s.touchS >= 0 && s.nb - s.touchS > p.maxWait) s.touchS = -1;
  if (s.above > 0) {
    if (s.touchL < 0 && s.above > p.minHold && s.hiExt >= p.ext * a && bk.l <= vw + p.tol * a) { s.touchL = s.nb; s.pbLow = bk.l; }
    else if (s.touchL >= 0) s.pbLow = Math.min(s.pbLow, bk.l);
    if (s.touchL < 0) s.hiExt = Math.max(s.hiExt, bk.h - vw);
  }
  if (s.below > 0) {
    if (s.touchS < 0 && s.below > p.minHold && s.loExt >= p.ext * a && bk.h >= vw - p.tol * a) { s.touchS = s.nb; s.pbHigh = bk.h; }
    else if (s.touchS >= 0) s.pbHigh = Math.max(s.pbHigh, bk.h);
    if (s.touchS < 0) s.loExt = Math.max(s.loExt, vw - bk.l);
  }
  s.prev = s.last; s.last = bk; s.lastVwap = vw; s.nb++; s.fresh = true;
}

const strategy: Strategy<P> = {
  name: 'r2_vwappb',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < 5) return false;
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
          seen: 0, atr: atrFor(ctx, sym), pv: 0, vol: 0, vwap: NaN, vwHist: [], lastVwap: NaN, nb: 0,
          above: 0, below: 0, hiExt: 0, loExt: 0, touchL: -1, touchS: -1, pbLow: Infinity, pbHigh: -Infinity, lastSig: -1, fresh: false,
        };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      s.fresh = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const k = Math.floor((ctx.minuteOf(b.t) - OPEN) / p.barMin);
        if (s.cur && s.cur.k !== k) { complete(s, s.cur, p); s.cur = undefined; }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        s.vwHist.push(s.vwap);
        if (!s.cur) s.cur = { k, o: b.o, h: b.h, l: b.l, c: b.c };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      // The bucket is complete once the clock has passed its end (all its minutes are closed bars).
      if (s.cur && ctx.minute >= OPEN + (s.cur.k + 1) * p.barMin) { complete(s, s.cur, p); s.cur = undefined; }

      if (!s.fresh || rel < p.startMin || rel > p.endMin) continue;
      if (p.entry !== 'vwap' && s.touchL < 0 && s.touchS < 0) continue;
      if (ctx.open.has(sym) || !s.last || !s.prev) continue;
      if (ctx.traded.has(sym) && (!p.reentry || s.nb - s.lastSig < Math.max(2, Math.ceil(p.ttl / p.barMin)))) continue;
      const b = s.last, pr = s.prev, vw = s.lastVwap, a = s.atr;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allowLong = p.direction !== 'with-gap' || gapUp;
      const allowShort = p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
      const h = s.vwHist;
      const vwAgo = h.length > 30 ? h[h.length - 31] : h[0];
      const upOk = !p.slope || vw > vwAgo, dnOk = !p.slope || vw < vwAgo;
      const common = () => ({
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined, noStop: p.noStop || undefined,
      });

      for (const side of ['long', 'short'] as const) {
        const L = side === 'long';
        const d = L ? 1 : -1;
        if (L ? !allowLong || !upOk : !allowShort || !dnOk) continue;
        let sig: Signal | undefined;
        if (p.entry === 'vwap') {
          // Established trend, not yet touched, price approaching VWAP from the trend side.
          const run = L ? s.above : s.below, ext = L ? s.hiExt : s.loExt, touched = L ? s.touchL : s.touchS;
          const dist = (b.c - vw) * d;
          if (touched >= 0 || run <= p.minHold || ext < p.ext * a || dist <= 0 || dist > p.near * a) continue;
          const lim = Math.round((vw + d * p.lOff * a) * 100) / 100;
          const stop = p.stopMode === 'pb' ? vw - d * p.stopBuf * a : lim - d * p.stopAtr * a;
          sig = { symbol: sym, side, stop, entryLimit: lim, limitTtl: p.ttl, ...common(), tag: `vw-${side}` };
          s.lastSig = s.nb - 1;
          cands.push({ sig, score: ext / a });
          break;
        } else {
          const t = L ? s.touchL : s.touchS;
          if (t < 0 || t >= s.nb - 1 || s.nb - 1 - t > p.maxWait || t <= s.lastSig) continue;
          if (L ? !(b.c > pr.h && b.c > vw) : !(b.c < pr.l && b.c < vw)) continue;
          const ref = L ? Math.min(s.pbLow, vw) : Math.max(s.pbHigh, vw);
          const stop = p.stopMode === 'pb' ? ref - d * p.stopBuf * a : b.c - d * p.stopAtr * a;
          const ext = L ? s.hiExt : s.loExt;
          if (p.entry === 'market') sig = { symbol: sym, side, stop, ...common(), tag: `pb-${side}` };
          else {
            const lim = Math.round((b.c - d * p.lFrac * Math.abs(b.c - stop)) * 100) / 100;
            sig = { symbol: sym, side, stop, entryLimit: lim, limitTtl: p.ttl, ...common(), tag: `rt-${side}` };
          }
          s.lastSig = s.nb - 1;
          cands.push({ sig, score: ext / a });
          break;
        }
      }
    }
    return cands.sort((x, y) => y.score - x.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    universe: ['gap', 'all'], minGap: [3], barMin: [1, 5], startMin: [15], endMin: [120, 300],
    direction: ['both', 'with-gap'], minHold: [15], ext: [0.5, 1.0], tol: [0.05], pierce: [0], slope: [true],
    maxWait: [3], entry: ['market', 'retrace', 'vwap'], lFrac: [0.3], lOff: [0.02], near: [0.15], ttl: [10],
    stopMode: ['atr'], stopBuf: [0.03], stopAtr: [0.25, 0.4], targetR: [0, 2], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false], reentry: [false],
    'rule.riskPerTrade': [100],
  },
};
