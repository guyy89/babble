// Power-hour breakout of the midday range, with the day's trend (r2_powerhour).
// Midday range = high/low of the 1-minute bars with NY minute in [rangeStart, rangeEnd) (e.g. 12:00–14:30).
// From rangeEnd on, a signal bar (barMinutes, aligned from rangeEnd) that CLOSES beyond the range
// (+ breakBuf × daily ATR) in the direction of the day's trend goes with the break:
//   trend 'open' : close vs the session open; 'vwap': close vs session VWAP; 'both'; 'none'.
//   minTrend     : |close − open| ≥ minTrend × daily ATR in the trade direction (0 = off).
//   maxRangeAtr  : midday range width ≤ maxRangeAtr × daily ATR (a quiet midday; 0 = off).
//   newExtreme   : the break must also be a new high (low) of the day.
// Entry at market (next bar open) or LIMIT: at the broken range edge (retest) or limOff ATR better than the close.
// Stop: other side of the range ('range'), the range middle ('mid') or stopAtr × ATR from the close ('atr').
// Exits: targetR / breakeven / trail; or noStop (exits only by target or the 15:55 flatten).
// One entry per symbol per day. No look-ahead: universe() uses meta + dailyBefore; onMinute() folds closed bars only.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minPrice: number;
  rangeStart: number;
  rangeEnd: number;
  barMinutes: number;
  direction: 'long' | 'short' | 'both';
  trend: 'open' | 'vwap' | 'both' | 'none';
  minTrend: number;
  maxRangeAtr: number;
  newExtreme: boolean;
  breakBuf: number;
  entry: 'market' | 'level' | 'offset';
  limOff: number;
  limitTtl: number;
  stopMode: 'range' | 'mid' | 'atr';
  stopAtr: number;
  targetR: number;
  breakevenAtR: number;
  trailR: number;
  noStop: boolean;
}

interface S {
  seen: number;
  atr: number;
  open: number;
  pv: number; vol: number;
  dayHi: number; dayLo: number;   // before the latest folded bar
  prevDayHi: number; prevDayLo: number;
  rHi: number; rLo: number; rCnt: number;
  lastMin: number; lastClose: number;
  bucketHi: number; bucketLo: number; bucketStart: number;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

const strategy: Strategy<P> = {
  name: 'r2_powerhour',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.tags.includes('index')) return false;
        if (m.open < p.minPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap');
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute < p.rangeStart) return [];
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = {
          seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, pv: 0, vol: 0,
          dayHi: -Infinity, dayLo: Infinity, prevDayHi: -Infinity, prevDayLo: Infinity,
          rHi: -Infinity, rLo: Infinity, rCnt: 0, lastMin: -1, lastClose: NaN,
          bucketHi: -Infinity, bucketLo: Infinity, bucketStart: -1,
        };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const m = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (m >= p.rangeStart && m < p.rangeEnd) { s.rHi = Math.max(s.rHi, b.h); s.rLo = Math.min(s.rLo, b.l); s.rCnt++; }
        // day extreme before the current signal bucket: frozen at each bucket start
        if (m >= p.rangeEnd) {
          const bs = p.rangeEnd + Math.floor((m - p.rangeEnd) / p.barMinutes) * p.barMinutes;
          if (bs !== s.bucketStart) { s.bucketStart = bs; s.prevDayHi = s.dayHi; s.prevDayLo = s.dayLo; s.bucketHi = -Infinity; s.bucketLo = Infinity; }
          s.bucketHi = Math.max(s.bucketHi, b.h); s.bucketLo = Math.min(s.bucketLo, b.l);
        }
        s.dayHi = Math.max(s.dayHi, b.h); s.dayLo = Math.min(s.dayLo, b.l);
        s.lastMin = m; s.lastClose = b.c;
      }
      if (ctx.minute < p.rangeEnd + p.barMinutes || (ctx.minute - p.rangeEnd) % p.barMinutes !== 0) continue;
      if (s.lastMin !== ctx.minute - 1) continue; // the signal bar's last minute must exist
      if (ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (!(s.atr > 0) || s.rCnt < 0.6 * (p.rangeEnd - p.rangeStart)) continue;
      const width = s.rHi - s.rLo;
      if (!(width > 0)) continue;
      if (p.maxRangeAtr > 0 && width > p.maxRangeAtr * s.atr) continue;
      const close = s.lastClose;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const atr = s.atr;
      const trendOk = (dir: 1 | -1) => {
        const vsOpen = dir * (close - s!.open) > 0;
        const vsVwap = dir * (close - vwap) > 0;
        if (p.trend === 'open' && !vsOpen) return false;
        if (p.trend === 'vwap' && !vsVwap) return false;
        if (p.trend === 'both' && !(vsOpen && vsVwap)) return false;
        if (p.minTrend > 0 && dir * (close - s!.open) < p.minTrend * atr) return false;
        return true;
      };
      const common = {
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        noStop: p.noStop || undefined,
      };
      let sig: Signal | undefined;
      if (p.direction !== 'short' && close > s.rHi + p.breakBuf * atr && trendOk(1) && (!p.newExtreme || close > s.prevDayHi)) {
        const stop = p.stopMode === 'range' ? s.rLo : p.stopMode === 'mid' ? (s.rHi + s.rLo) / 2 : close - p.stopAtr * atr;
        sig = { symbol: sym, side: 'long', stop, ...common, tag: 'ph-long' };
        if (p.entry === 'level') sig.entryLimit = r2(s.rHi + 0.01);
        else if (p.entry === 'offset') sig.entryLimit = r2(close - p.limOff * atr);
      } else if (p.direction !== 'long' && close < s.rLo - p.breakBuf * atr && trendOk(-1) && (!p.newExtreme || close < s.prevDayLo)) {
        const stop = p.stopMode === 'range' ? s.rHi : p.stopMode === 'mid' ? (s.rHi + s.rLo) / 2 : close + p.stopAtr * atr;
        sig = { symbol: sym, side: 'short', stop, ...common, tag: 'ph-short' };
        if (p.entry === 'level') sig.entryLimit = r2(s.rLo - 0.01);
        else if (p.entry === 'offset') sig.entryLimit = r2(close + p.limOff * atr);
      }
      if (!sig) continue;
      if (sig.entryLimit !== undefined) {
        sig.limitTtl = p.limitTtl;
        if (sig.side === 'long' ? sig.entryLimit <= sig.stop : sig.entryLimit >= sig.stop) continue;
      }
      // strongest trend (in ATR) first
      cands.push({ sig, score: Math.abs(close - s.open) / atr });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    // wf run 1 (256 configs): universe liquid/all × barMinutes 1/5 × minTrend 0/0.5 × entry market/offset × stopAtr 0.3/0.6
    //   × targetR 0/2 × risk 50/500 → WF −5.83R, FAIL.
    // wf run 2: the design-period (Apr 16–Jun 15) best area — liquid, 1-min signal bar, offset LIMIT entry — with
    // limit offset/TTL, risk tiers and limits on/off.
    universe: ['liquid'], minPrice: [5], rangeStart: [720], rangeEnd: [870], barMinutes: [1],
    direction: ['both'], trend: ['both'], minTrend: [0.4, 0.7], maxRangeAtr: [0], newExtreme: [false], breakBuf: [0],
    entry: ['offset'], limOff: [0.05, 0.1], limitTtl: [5, 15],
    stopMode: ['atr'], stopAtr: [0.3],
    targetR: [0], breakevenAtR: [0], trailR: [0], noStop: [false],
    'rule.riskPerTrade': [50, 100, 200, 500], 'rule.lastEntryMinute': [930],
    'rule.maxTrades': [3, 0], 'rule.maxConcurrent': [2, 0], 'rule.maxLosses': [2, 0],
  },
};
