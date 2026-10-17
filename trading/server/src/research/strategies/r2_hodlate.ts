// Late new-high-of-day continuation (r2_hodlate).
// After `startMin` NY (default 11:00) a signal bar (barMinutes, aligned from 09:30) CLOSES above the session high
// that stood before the bar (long) — or below the session low (short). Optional qualifiers:
//   baseMin   : the old extreme was set at least this many minutes before the signal bar (a base / consolidation);
//   maxDepth  : while basing, price held near the extreme: the pullback from the old high, as a fraction of the
//               day's range so far, is ≤ maxDepth (1 = off);
//   volMult   : signal-bar volume ≥ volMult × the session's average volume per bar before it (0 = off);
//   vwapFilter: close on the breakout side of the stock's session VWAP;
//   spyFilter : SPY's last close on the same side of SPY's session VWAP.
// Entry at market (next bar open) or LIMIT: at the broken level (retest) or `limOff` daily-ATR better than the
// signal close. Stop: base low ('base'), just under the broken level ('level'), or `stopAtr` ATR from the close
// ('atr'), each with `stopBuf` ATR buffer. Exits: targetR / breakeven / trail / time (holdMin) / noStop+time.
// No look-ahead: universe() uses meta + dailyBefore; onMinute() folds in closed bars only, incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minPrice: number;
  startMin: number;        // NY minute-of-day of the earliest signal-bar CLOSE (660 = 11:00)
  endMin: number;          // NY minute-of-day of the latest decision
  barMinutes: number;
  direction: 'long' | 'short' | 'both' | 'with-gap';
  baseMin: number;
  maxDepth: number;
  volMult: number;
  vwapFilter: boolean;
  spyFilter: boolean;
  entry: 'market' | 'level' | 'offset';
  limOff: number;          // ATR, entry 'offset'
  limitTtl: number;
  stopMode: 'base' | 'level' | 'atr';
  stopAtr: number;         // ATR distance for 'atr'
  stopBuf: number;         // ATR buffer for 'base'/'level'
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = to the flatten time
  noStop: boolean;         // with holdMin: no protective stop, time exit only
}

interface S {
  seen: number;
  atr: number;
  pv: number; vol: number;
  // per-bar running values (index = bar index): state AFTER that bar
  hi: number[]; hiMin: number[]; lo: number[]; loMin: number[];
  lowSinceHi: number[]; highSinceLo: number[]; vwap: number[]; cumVol: number[];
  min: number[];
}

const OPEN = 9 * 60 + 30;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function fold(ctx: MinuteContext, sym: string, bars: Bar[]): S {
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), pv: 0, vol: 0, hi: [], hiMin: [], lo: [], loMin: [], lowSinceHi: [], highSinceLo: [], vwap: [], cumVol: [], min: [] };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const i = s.seen, b = bars[i], m = ctx.minuteOf(b.t);
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    s.vwap.push(s.vol > 0 ? s.pv / s.vol : b.c);
    s.cumVol.push(s.vol);
    s.min.push(m);
    if (i === 0) {
      s.hi.push(b.h); s.hiMin.push(m); s.lo.push(b.l); s.loMin.push(m); s.lowSinceHi.push(b.l); s.highSinceLo.push(b.h);
      continue;
    }
    if (b.h > s.hi[i - 1]) { s.hi.push(b.h); s.hiMin.push(m); s.lowSinceHi.push(b.l); }
    else { s.hi.push(s.hi[i - 1]); s.hiMin.push(s.hiMin[i - 1]); s.lowSinceHi.push(Math.min(s.lowSinceHi[i - 1], b.l)); }
    if (b.l < s.lo[i - 1]) { s.lo.push(b.l); s.loMin.push(m); s.highSinceLo.push(b.h); }
    else { s.lo.push(s.lo[i - 1]); s.loMin.push(s.loMin[i - 1]); s.highSinceLo.push(Math.max(s.highSinceLo[i - 1], b.h)); }
  }
  return s;
}

const strategy: Strategy<P> = {
  name: 'r2_hodlate',
  universe(ctx: DayContext, p: P) {
    const syms = Object.values(ctx.meta)
      .filter((m) => {
        if (m.tags.includes('index')) return false;
        if (m.open < p.minPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap');
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return true;
      })
      .map((m) => m.symbol);
    if (ctx.meta.SPY) syms.push('SPY'); // context only (never traded)
    return syms;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute < p.startMin || ctx.minute > p.endMin || (ctx.minute - OPEN) % p.barMinutes !== 0) return [];
    let spyUp: boolean | undefined;
    if (p.spyFilter) {
      const sb = ctx.bars('SPY');
      if (!sb.length) return [];
      const ss = fold(ctx, 'SPY', sb);
      spyUp = sb[sb.length - 1].c > ss.vwap[sb.length - 1];
    }
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const meta = ctx.meta[sym];
      if (sym === 'SPY' || meta.tags.includes('index')) continue;
      const bars = ctx.bars(sym);
      if (bars.length < 2 * p.barMinutes) continue;
      const s = fold(ctx, sym, bars);
      if (!(s.atr > 0) || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      // signal bucket = closed bars with minute in [minute - barMinutes, minute)
      const n = bars.length;
      let k = n;
      while (k > 0 && s.min[k - 1] >= ctx.minute - p.barMinutes) k--;
      if (k === n || k === 0 || s.min[n - 1] !== ctx.minute - 1) continue; // need the bucket's last bar and history
      const prev = k - 1;
      let bh = -Infinity, bl = Infinity, bv = 0;
      for (let i = k; i < n; i++) { bh = Math.max(bh, bars[i].h); bl = Math.min(bl, bars[i].l); bv += bars[i].v; }
      const close = bars[n - 1].c;
      const bucketStart = ctx.minute - p.barMinutes;
      const range = s.hi[prev] - s.lo[prev];
      if (!(range > 0)) continue;
      const avgBucketVol = (s.cumVol[prev] / (prev + 1)) * p.barMinutes;
      if (p.volMult > 0 && !(bv >= p.volMult * avgBucketVol)) continue;
      const vw = s.vwap[n - 1];
      const gapUp = meta.gapPct > 0;
      const allowLong = p.direction === 'long' || p.direction === 'both' || (p.direction === 'with-gap' && gapUp);
      const allowShort = p.direction === 'short' || p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
      const atr = s.atr;
      const common = {
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined, noStop: p.noStop || undefined,
      };
      let sig: Signal | undefined;
      if (allowLong && close > s.hi[prev]
        && bucketStart - s.hiMin[prev] >= p.baseMin
        && (s.hi[prev] - s.lowSinceHi[prev]) / range <= p.maxDepth
        && (!p.vwapFilter || close > vw) && (!p.spyFilter || spyUp)) {
        const level = s.hi[prev];
        const stop = p.stopMode === 'base' ? Math.min(s.lowSinceHi[prev], bl) - p.stopBuf * atr
          : p.stopMode === 'level' ? level - p.stopBuf * atr : close - p.stopAtr * atr;
        sig = { symbol: sym, side: 'long', stop, ...common, tag: 'hod-long' };
        if (p.entry === 'level') sig.entryLimit = Math.round((level + 0.01) * 100) / 100;
        else if (p.entry === 'offset') sig.entryLimit = Math.round((close - p.limOff * atr) * 100) / 100;
      } else if (allowShort && close < s.lo[prev]
        && bucketStart - s.loMin[prev] >= p.baseMin
        && (s.highSinceLo[prev] - s.lo[prev]) / range <= p.maxDepth
        && (!p.vwapFilter || close < vw) && (!p.spyFilter || spyUp === false)) {
        const level = s.lo[prev];
        const stop = p.stopMode === 'base' ? Math.max(s.highSinceLo[prev], bh) + p.stopBuf * atr
          : p.stopMode === 'level' ? level + p.stopBuf * atr : close + p.stopAtr * atr;
        sig = { symbol: sym, side: 'short', stop, ...common, tag: 'lod-short' };
        if (p.entry === 'level') sig.entryLimit = Math.round((level - 0.01) * 100) / 100;
        else if (p.entry === 'offset') sig.entryLimit = Math.round((close + p.limOff * atr) * 100) / 100;
      }
      if (!sig) continue;
      // a limit must be on the correct side of the stop
      if (sig.entryLimit !== undefined) {
        sig.limitTtl = p.limitTtl;
        if (sig.side === 'long' ? sig.entryLimit <= sig.stop : sig.entryLimit >= sig.stop) continue;
      }
      cands.push({ sig, score: avgBucketVol > 0 ? bv / avgBucketVol : 0 });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    universe: ['gap', 'all'], minPrice: [5], startMin: [660], endMin: [930], barMinutes: [5], direction: ['long'],
    baseMin: [30, 60, 120], maxDepth: [1, 0.4], volMult: [1.5, 2.5], vwapFilter: [true], spyFilter: [false, true],
    entry: ['offset'], limOff: [0.05, 0.1], limitTtl: [15],
    stopMode: ['atr'], stopAtr: [0.2], stopBuf: [0.02],
    targetR: [0], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false, true],
    'rule.riskPerTrade': [100], 'rule.maxTrades': [0], 'rule.dailyLossLimit': [0], 'rule.maxLosses': [0],
  },
};
