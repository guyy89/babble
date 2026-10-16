// "index" family.
//  Type 1 — index-only (SPY/QQQ):
//    variant 'orb'  : opening-range breakout on the index; signal-bar close beyond the range (+ optional VWAP filter).
//    variant 'momo' : intraday momentum — at `entryMin` trade in the direction of the index move since the
//                     previous close (ref 'prev') or since the open (ref 'open') if |move| ≥ `thr`%; hold to `exitMin`.
//    variant 'gap'  : gap continuation ('cont') or fade ('fade') at `entryMin` if |gap| ≥ minGap and price since
//                     the open confirms the chosen direction.
//  Type 2 — relative strength vs SPY (variant 'rs'): on a weak market morning (SPY since open ≤ −mkt%) a stock
//    whose % change since the open exceeds SPY's by ≥ thr% and that prints a new intraday high is bought
//    (mirror for shorts on a strong morning). SPY is in the universe only as the reference.
// Stops are in units of the 14-day daily ATR (known at 09:30), or session VWAP / opening range.
// All decisions use only bars closed before ctx.minute; state is folded in incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'orb' | 'momo' | 'gap' | 'rs';
  idx: 'SPY' | 'QQQ' | 'both';
  // orb
  orMinutes: number;
  barMinutes: number;
  vwapFilter: boolean;
  orStop: 'or' | 'mid' | 'atr';
  // momo / gap
  entryMin: number;      // minutes after 09:30 for the momo/gap decision
  exitMin: number;       // minutes after 09:30 for time exit (0 = harness flatten)
  ref: 'prev' | 'open';
  momoDir: 'with' | 'fade';
  thr: number;           // momo: |move| % ; rs: relative strength %
  minGap: number;
  gapMode: 'cont' | 'fade';
  // rs
  mkt: number;           // |SPY move since open| % required (weak/strong morning)
  side: 'both' | 'long' | 'short';
  startMin: number;      // rs entry window (minutes after 09:30)
  endMin: number;
  trig: 'close' | 'high';// new-high trigger: bar close above prior HOD, or bar high above prior HOD
  rsUni: 'liquid' | 'gap' | 'all';
  minAtrPct: number;
  minBeta: number;       // rs universe: 20-day daily beta to SPY (excludes inverse/vol ETFs); -99 = off
  rsMode: 'raw' | 'beta'; // rs = stock % − SPY %, or stock % − beta × SPY % (residual)
  minPrice: number;
  stopMode: 'atr' | 'vwap';
  // common
  stopAtr: number;
  targetR: number;       // 0 = none
  breakevenAtR: number;  // 0 = off
  trailR: number;        // 0 = off
}

interface S {
  seen: number;
  pv: number; vol: number;
  hi: number; lo: number;          // session extremes
  orHi: number; orLo: number;
  first?: number;                  // first bar open
  last?: Bar;
  newHigh: boolean; newLow: boolean; // last closed bar broke the prior HOD/LOD
  closeAbove: boolean; closeBelow: boolean;
  atr: number;
  beta?: number;
}

const OPEN = 9 * 60 + 30;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

/** Beta of daily close-to-close returns vs SPY over the last n days (bars strictly before today). */
function beta(sym: Bar[], spy: Bar[], n = 20): number {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const spyRet = new Map<string, number>();
  for (let i = 1; i < spy.length; i++) spyRet.set(day(spy[i].t), spy[i].c / spy[i - 1].c - 1);
  const xs: number[] = [], ys: number[] = [];
  for (let i = Math.max(1, sym.length - n); i < sym.length; i++) {
    const m = spyRet.get(day(sym[i].t));
    if (m === undefined) continue;
    xs.push(m); ys.push(sym[i].c / sym[i - 1].c - 1);
  }
  if (xs.length < 10) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, v = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); v += (xs[i] - mx) ** 2; }
  return v > 0 ? cov / v : NaN;
}

function fold(ctx: MinuteContext, sym: string, p: P): S | undefined {
  const bars = ctx.bars(sym);
  if (!bars.length) return undefined;
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, pv: 0, vol: 0, hi: -Infinity, lo: Infinity, orHi: -Infinity, orLo: Infinity, newHigh: false, newLow: false, closeAbove: false, closeBelow: false, atr: dailyAtr(ctx.dailyBefore(sym)) };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const b = bars[s.seen];
    const bm = ctx.minuteOf(b.t);
    if (s.first === undefined) s.first = b.o;
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    s.newHigh = Number.isFinite(s.hi) && b.h > s.hi;
    s.newLow = Number.isFinite(s.lo) && b.l < s.lo;
    s.closeAbove = Number.isFinite(s.hi) && b.c > s.hi;
    s.closeBelow = Number.isFinite(s.lo) && b.c < s.lo;
    s.hi = Math.max(s.hi, b.h);
    s.lo = Math.min(s.lo, b.l);
    if (bm < OPEN + p.orMinutes) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
    s.last = b;
  }
  return s;
}

const mgmt = (p: P) => ({
  targetR: p.targetR || undefined,
  breakevenAtR: p.breakevenAtR || undefined,
  trailR: p.trailR || undefined,
  exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
});

function indexSignals(ctx: MinuteContext, p: P): Signal[] {
  const out: Signal[] = [];
  const syms = p.idx === 'both' ? ['SPY', 'QQQ'] : [p.idx];
  const rel = ctx.minute - OPEN;
  for (const sym of syms) {
    const s = fold(ctx, sym, p);
    if (!s || !s.last || ctx.traded.has(sym) || ctx.open.has(sym) || !(s.atr > 0)) continue;
    const close = s.last.c;
    const vwap = s.vol > 0 ? s.pv / s.vol : close;
    let side: 'long' | 'short' | undefined;
    let stop: number | undefined;
    if (p.variant === 'orb') {
      if (rel < p.orMinutes + p.barMinutes || rel % p.barMinutes !== 0 || !Number.isFinite(s.orHi)) continue;
      if (close > s.orHi && (!p.vwapFilter || close > vwap)) side = 'long';
      else if (close < s.orLo && (!p.vwapFilter || close < vwap)) side = 'short';
      if (!side) continue;
      if (p.orStop === 'or') stop = side === 'long' ? s.orLo : s.orHi;
      else if (p.orStop === 'mid') stop = (s.orHi + s.orLo) / 2;
    } else if (p.variant === 'momo') {
      if (rel !== p.entryMin) continue;
      const base = p.ref === 'prev' ? ctx.meta[sym].prevClose : s.first!;
      const mv = (close / base - 1) * 100;
      if (Math.abs(mv) < p.thr) continue;
      side = (mv > 0) === (p.momoDir !== 'fade') ? 'long' : 'short';
      if (p.vwapFilter && (side === 'long' ? close < vwap : close > vwap)) continue;
    } else if (p.variant === 'gap') {
      if (rel !== p.entryMin) continue;
      const g = ctx.meta[sym].gapPct;
      if (Math.abs(g) < p.minGap) continue;
      const dir = (g > 0 ? 1 : -1) * (p.gapMode === 'cont' ? 1 : -1);
      const sinceOpen = close - s.first!;
      if (sinceOpen * dir <= 0) continue; // price action since the open must agree
      side = dir > 0 ? 'long' : 'short';
      if (p.vwapFilter && (side === 'long' ? close < vwap : close > vwap)) continue;
    }
    if (!side) continue;
    if (stop === undefined) stop = side === 'long' ? close - p.stopAtr * s.atr : close + p.stopAtr * s.atr;
    out.push({ symbol: sym, side, stop, ...mgmt(p), tag: `${p.variant}-${side}` });
  }
  return out;
}

function rsSignals(ctx: MinuteContext, p: P): Signal[] {
  const spy = fold(ctx, 'SPY', p);
  // Keep every symbol's state current even outside the window.
  const syms = Object.keys(ctx.meta).filter((x) => x !== 'SPY' && x !== 'QQQ');
  const states = syms.map((sym) => [sym, fold(ctx, sym, p)] as const);
  const rel = ctx.minute - OPEN;
  if (!spy?.last || rel < p.startMin || rel > p.endMin) return [];
  const spyRet = (spy.last.c / spy.first! - 1) * 100;
  const weak = spyRet <= -p.mkt, strong = spyRet >= p.mkt;
  if (!weak && !strong) return [];
  const cands: { sig: Signal; score: number }[] = [];
  for (const [sym, s] of states) {
    if (!s?.last || ctx.traded.has(sym) || ctx.open.has(sym) || !(s.atr > 0)) continue;
    // Only consider symbols whose last bar is fresh (sparse IEX bars).
    if (ctx.minuteOf(s.last.t) !== ctx.minute - 1) continue;
    const close = s.last.c;
    if (p.rsMode === 'beta' && s.beta === undefined) s.beta = beta(ctx.dailyBefore(sym), ctx.dailyBefore('SPY'));
    const b = p.rsMode === 'beta' ? s.beta! : 1;
    if (!Number.isFinite(b)) continue;
    const rs = (close / s.first! - 1) * 100 - b * spyRet;
    const vwap = s.vol > 0 ? s.pv / s.vol : close;
    let side: 'long' | 'short' | undefined;
    if (weak && rs >= p.thr && p.side !== 'short' && (p.trig === 'close' ? s.closeAbove : s.newHigh)) side = 'long';
    else if (strong && rs <= -p.thr && p.side !== 'long' && (p.trig === 'close' ? s.closeBelow : s.newLow)) side = 'short';
    if (!side) continue;
    const long = side === 'long';
    let stop = long ? close - p.stopAtr * s.atr : close + p.stopAtr * s.atr;
    if (p.stopMode === 'vwap') {
      const v = long ? vwap - 0.1 * s.atr : vwap + 0.1 * s.atr;
      // VWAP stop, but never tighter than half the ATR stop distance
      stop = long ? Math.min(v, close - 0.5 * p.stopAtr * s.atr) : Math.max(v, close + 0.5 * p.stopAtr * s.atr);
    }
    cands.push({ sig: { symbol: sym, side, stop, ...mgmt(p), tag: `rs-${side}` }, score: Math.abs(rs) });
  }
  return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
}

const strategy: Strategy<P> = {
  name: 'index',
  universe(ctx: DayContext, p: P) {
    if (p.variant !== 'rs') return p.idx === 'both' ? ['SPY', 'QQQ'] : [p.idx];
    const picks = Object.values(ctx.meta)
      .filter((m) => !m.tags.includes('index') && (p.rsUni === 'all' ? m.tags.includes('liquid') || m.tags.includes('gap') : m.tags.includes(p.rsUni)) && m.open >= p.minPrice)
      .filter((m) => {
        const atr = dailyAtr(ctx.dailyBefore(m.symbol));
        if (!(atr > 0 && (atr / m.open) * 100 >= p.minAtrPct)) return false;
        if (p.minBeta > -99) { const b = beta(ctx.dailyBefore(m.symbol), ctx.dailyBefore('SPY')); if (!(b >= p.minBeta)) return false; }
        return true;
      })
      .map((m) => m.symbol);
    return ['SPY', ...picks];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    return p.variant === 'rs' ? rsSignals(ctx, p) : indexSignals(ctx, p);
  },
};

const base = {
  idx: ['both'], orMinutes: [15], barMinutes: [5], vwapFilter: [false], orStop: ['atr'], entryMin: [30], exitMin: [0], ref: ['prev'], momoDir: ['with'],
  thr: [1], minGap: [0.5], gapMode: ['cont'], mkt: [0.3], side: ['both'], startMin: [30], endMin: [240], trig: ['close'],
  rsUni: ['all'], minAtrPct: [2], minBeta: [-99], rsMode: ['raw'], minPrice: [5], stopMode: ['atr'], stopAtr: [0.5], targetR: [2], breakevenAtR: [0], trailR: [0],
};

export default {
  strategy,
  grid: {
    ...base,
    variant: ['rs'],
    rsUni: ['gap'], thr: [3, 4, 5], mkt: [0.4, 0.5, 0.6], startMin: [30], endMin: [240], trig: ['close', 'high'], stopAtr: [0.5], stopMode: ['vwap'], targetR: [3],
  },
};
