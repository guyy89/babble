// Afternoon trend continuation (r2_afternoon).
// Morning trend is read at consStart (e.g. 13:00) from the bars of [09:30, consStart):
//   trend 'open'|'vwap'|'both': the last close is above (long) / below (short) the session open and/or VWAP;
//   minTrend: |close − open| ≥ minTrend × daily ATR in the trend direction (0 = off);
//   structure 'none' | 'halves' | 'thirds': the morning split into 2/3 equal segments must show higher lows
//     (long) / lower highs (short), and the last segment must also make a higher high (lower low).
// Midday consolidation = high/low of [consStart, consEnd) (e.g. 13:00–14:00). It must not violate the trend:
//   maxConsAtr: width ≤ maxConsAtr × ATR (0 = off); holdVwap: the consolidation's last close is still on the
//   trend side of VWAP.
// From consEnd until lastEntry, on each completed signal bar (barMinutes, aligned from consEnd):
//   trigger 'break': close beyond the consolidation high (low) + breakBuf × ATR in the trend direction;
//   trigger 'vwap' : the bar dipped to within vwapTol × ATR of VWAP (or through it) and closed back on the
//                    trend side of VWAP, in the trend direction (close > open for long);
//   trigger 'either': whichever comes first.
// Entry: market (next bar open), LIMIT at the broken level / VWAP ('level'), or limOff × ATR better than the close.
// Stop: other side of the consolidation ('cons'), its middle ('mid'), stopAtr × ATR from the close ('atr'),
//   or the signal bar's extreme ('bar'). Exits: targetR / breakeven / trail / exitMinute, or noStop + time.
// One entry per symbol per day. No look-ahead: universe() uses meta + dailyBefore; onMinute() folds closed bars only.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minPrice: number;
  consStart: number;
  consEnd: number;
  lastEntry: number;
  barMinutes: number;
  direction: 'long' | 'short' | 'both';
  trend: 'open' | 'vwap' | 'both';
  minTrend: number;
  structure: 'none' | 'halves' | 'thirds';
  maxConsAtr: number;
  holdVwap: boolean;
  trigger: 'break' | 'vwap' | 'either';
  breakBuf: number;
  vwapTol: number;
  entry: 'market' | 'level' | 'offset';
  limOff: number;
  limitTtl: number;
  stopMode: 'cons' | 'mid' | 'atr' | 'bar';
  stopAtr: number;
  targetR: number;
  breakevenAtR: number;
  trailR: number;
  exitMinute: number;
  noStop: boolean;
}

interface S {
  seen: number;
  atr: number;
  open: number;
  pv: number; vol: number;
  seg: { hi: number; lo: number }[];   // morning segments
  cHi: number; cLo: number; cCnt: number; cLastClose: number; cLastVwap: number;
  dir: 0 | 1 | -1;                     // morning trend, fixed at consStart (0 = none / not yet)
  dirSet: boolean;
  trendSize: number;
  lastMin: number; lastClose: number;
  bucketStart: number; bO: number; bHi: number; bLo: number;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const OPEN = 9 * 60 + 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

const strategy: Strategy<P> = {
  name: 'r2_afternoon',
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
    const nSeg = p.structure === 'thirds' ? 3 : p.structure === 'halves' ? 2 : 1;
    const segLen = (p.consStart - OPEN) / nSeg;
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = {
          seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, pv: 0, vol: 0,
          seg: Array.from({ length: nSeg }, () => ({ hi: -Infinity, lo: Infinity })),
          cHi: -Infinity, cLo: Infinity, cCnt: 0, cLastClose: NaN, cLastVwap: NaN,
          dir: 0, dirSet: false, trendSize: 0, lastMin: -1, lastClose: NaN,
          bucketStart: -1, bO: NaN, bHi: -Infinity, bLo: Infinity,
        };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const m = ctx.minuteOf(b.t);
        // Morning trend is fixed from bars before consStart, before this bar is folded in.
        if (m >= p.consStart && !s.dirSet) setTrend(s, p);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const vwapNow = s.vol > 0 ? s.pv / s.vol : b.c;
        if (m < p.consStart) {
          const k = Math.min(nSeg - 1, Math.floor((m - OPEN) / segLen));
          s.seg[k].hi = Math.max(s.seg[k].hi, b.h); s.seg[k].lo = Math.min(s.seg[k].lo, b.l);
        } else if (m < p.consEnd) {
          s.cHi = Math.max(s.cHi, b.h); s.cLo = Math.min(s.cLo, b.l); s.cCnt++;
          s.cLastClose = b.c; s.cLastVwap = vwapNow;
        } else {
          const bs = p.consEnd + Math.floor((m - p.consEnd) / p.barMinutes) * p.barMinutes;
          if (bs !== s.bucketStart) { s.bucketStart = bs; s.bO = b.o; s.bHi = -Infinity; s.bLo = Infinity; }
          s.bHi = Math.max(s.bHi, b.h); s.bLo = Math.min(s.bLo, b.l);
        }
        s.lastMin = m; s.lastClose = b.c;
      }
      if (ctx.minute < p.consEnd + p.barMinutes || (ctx.minute - p.consEnd) % p.barMinutes !== 0) continue;
      if (ctx.minute > p.lastEntry) continue;
      if (s.lastMin !== ctx.minute - 1) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (!s.dirSet || s.dir === 0 || !(s.atr > 0)) continue;
      const dir = s.dir;
      if (p.direction === 'long' && dir < 0) continue;
      if (p.direction === 'short' && dir > 0) continue;
      if (s.cCnt < 0.6 * (p.consEnd - p.consStart)) continue;
      const width = s.cHi - s.cLo;
      if (!(width > 0)) continue;
      if (p.maxConsAtr > 0 && width > p.maxConsAtr * s.atr) continue;
      if (p.holdVwap && !(dir * (s.cLastClose - s.cLastVwap) > 0)) continue;
      const atr = s.atr;
      const close = s.lastClose;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      // still on the trend side of VWAP at the trigger
      if (!(dir * (close - vwap) > 0)) continue;
      const level = dir > 0 ? s.cHi : s.cLo;
      const isBreak = dir * (close - level) > p.breakBuf * atr;
      const touched = dir > 0 ? s.bLo <= vwap + p.vwapTol * atr : s.bHi >= vwap - p.vwapTol * atr;
      const isVwap = touched && dir * (close - s.bO) > 0;
      let kind: 'break' | 'vwap' | undefined;
      if ((p.trigger === 'break' || p.trigger === 'either') && isBreak) kind = 'break';
      else if ((p.trigger === 'vwap' || p.trigger === 'either') && isVwap) kind = 'vwap';
      if (!kind) continue;
      const side = dir > 0 ? 'long' : 'short';
      const stop =
        p.stopMode === 'cons' ? (dir > 0 ? s.cLo : s.cHi)
        : p.stopMode === 'mid' ? (s.cHi + s.cLo) / 2
        : p.stopMode === 'bar' ? (dir > 0 ? s.bLo - 0.01 : s.bHi + 0.01)
        : close - dir * p.stopAtr * atr;
      if (!(dir * (close - stop) > 0)) continue;
      const sig: Signal = {
        symbol: sym, side, stop,
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.exitMinute || undefined, noStop: p.noStop || undefined, tag: `${kind}-${side}`,
      };
      if (p.entry === 'level') sig.entryLimit = r2(kind === 'break' ? level + dir * 0.01 : vwap + dir * 0.01);
      else if (p.entry === 'offset') sig.entryLimit = r2(close - dir * p.limOff * atr);
      if (sig.entryLimit !== undefined) {
        sig.limitTtl = p.limitTtl;
        if (dir * (sig.entryLimit - stop) <= 0) continue;
      }
      cands.push({ sig, score: s.trendSize });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

function setTrend(s: S, p: P) {
  s.dirSet = true;
  if (!(s.atr > 0) || !Number.isFinite(s.lastClose)) return;
  const close = s.lastClose;
  const vwap = s.vol > 0 ? s.pv / s.vol : close;
  const ok = (dir: 1 | -1) => {
    const vsOpen = dir * (close - s.open) > 0;
    const vsVwap = dir * (close - vwap) > 0;
    if ((p.trend === 'open' || p.trend === 'both') && !vsOpen) return false;
    if ((p.trend === 'vwap' || p.trend === 'both') && !vsVwap) return false;
    if (p.minTrend > 0 && dir * (close - s.open) < p.minTrend * s.atr) return false;
    if (p.structure !== 'none') {
      for (let i = 1; i < s.seg.length; i++) {
        const a = s.seg[i - 1], b = s.seg[i];
        if (!Number.isFinite(a.lo) || !Number.isFinite(b.lo)) return false;
        if (dir > 0 ? !(b.lo > a.lo && b.hi > a.hi) : !(b.hi < a.hi && b.lo < a.lo)) return false;
      }
    }
    return true;
  };
  if (ok(1)) s.dir = 1;
  else if (ok(-1)) s.dir = -1;
  s.trendSize = Math.abs(close - s.open) / s.atr;
}

export default {
  strategy,
  grid: {
    universe: ['gap', 'all'], minPrice: [5], consStart: [780], consEnd: [840], lastEntry: [930], barMinutes: [5],
    direction: ['both'], trend: ['both'], minTrend: [0.5], structure: ['halves'], maxConsAtr: [0], holdVwap: [true],
    trigger: ['break', 'vwap'], breakBuf: [0], vwapTol: [0.05],
    entry: ['market', 'offset'], limOff: [0.05], limitTtl: [15],
    stopMode: ['atr'], stopAtr: [0.4],
    targetR: [0, 2], breakevenAtR: [0, 1], trailR: [0, 1], exitMinute: [0, 915], noStop: [false],
    'rule.riskPerTrade': [50, 500], 'rule.dailyLossLimit': [0], 'rule.maxTrades': [0], 'rule.maxLosses': [0],
  },
};
