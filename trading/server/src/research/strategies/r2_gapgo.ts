// r2_gapgo: "gap and go" — large gappers that HOLD the gap, traded in the gap direction.
// Universe (09:30 info only): 'gap'-tagged names with |gap| >= minGap, price band, 20d avg volume floor,
// top maxSymbols by |gap|.
// After an opening range of orMinutes, a 1-minute bar closing beyond the range in the gap direction is the break.
// Filters at signal time: the gap must hold (worst excursion since the open has filled at most maxFill of the gap,
// and the signal close is still beyond the open-to-prevClose midpoint), optional VWAP side, and optional relative
// volume (volume since open per minute vs 20d avg per minute).
// Entry modes:
//   market  — market at the next bar after the break bar;
//   retest  — LIMIT at the range level (orHi for longs) after the break, limitTtl minutes;
//   mpb     — first micro-pullback after the break: a counter-colour bar (red for longs) that holds above the range
//             level; then a bar closing beyond that pullback bar's extreme → market;
//   mpblim  — on that first pullback bar, a LIMIT at pbRetrace of the breakout leg (from the leg extreme back
//             toward the range level), limitTtl minutes.
// Stops: far side of range ('or'), mid-range ('mid'), ATR fraction from the entry reference ('atr'), pullback bar
// extreme (pb, mpb modes only, falls back to mid), or none (noStop; sized from the far side of the range).
// All decisions use closed bars only; state is folded in incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  minGap: number;
  maxSymbols: number;
  minPrice: number;
  maxPrice: number;
  minAvgVol: number;
  side: 'both' | 'long' | 'short';     // which gap direction to trade (always WITH the gap)
  orMinutes: number;
  maxFill: number;                      // max fraction of the gap filled since the open (9 = off)
  vwapFilter: boolean;
  minRvol: number;                      // 0 = off
  cutoffMinutes: number;                // no new signals after OPEN + this
  entry: 'market' | 'retest' | 'mpb' | 'mpblim';
  pbRetrace: number;                    // mpblim: limit at legHigh - pbRetrace × (legHigh - orHi)
  limitTtl: number;
  stopMode: 'or' | 'mid' | 'atr' | 'pb' | 'none';
  atrStop: number;
  targetR: number;                      // 0 = none
  breakevenAtR: number;                 // 0 = off
  trailR: number;                       // 0 = off
  holdMinutes: number;                  // 0 = hold to flatten
}

interface S {
  seen: number;
  hi: number; lo: number;               // opening range
  hod: number; lod: number;             // session extremes
  pv: number; vol: number;
  atr?: number;
  last?: Bar;
  broke: boolean;                       // break bar seen (mpb modes)
  legExt: number;                       // extreme of the breakout leg
  pb?: Bar;                             // first pullback bar
  done: boolean;
}

const OPEN = 9 * 60 + 30;

function atr14(daily: Bar[]): number | undefined {
  if (daily.length < 15) return undefined;
  const d = daily.slice(-15);
  let sum = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc));
  }
  return sum / 14;
}

const strategy: Strategy<P> = {
  name: 'r2_gapgo',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap)
      .filter((m) => m.open >= p.minPrice && m.open <= p.maxPrice && m.avgVolume >= p.minAvgVol)
      .filter((m) => p.side === 'both' || (p.side === 'long' ? m.gapPct > 0 : m.gapPct < 0))
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const rangeEnd = OPEN + p.orMinutes;
    if (ctx.minute < rangeEnd + 1 || ctx.minute > OPEN + p.cutoffMinutes) return out;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      const meta = ctx.meta[sym];
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, hi: -Infinity, lo: Infinity, hod: -Infinity, lod: Infinity, pv: 0, vol: 0, broke: false, legExt: NaN, done: false, atr: atr14(ctx.dailyBefore(sym)) };
        ctx.state.set(sym, s);
      }
      const prevSeen = s.seen;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        if (ctx.minuteOf(b.t) < rangeEnd) { s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l); }
        s.hod = Math.max(s.hod, b.h); s.lod = Math.min(s.lod, b.l);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.last = b;
      }
      if (s.done || s.seen === prevSeen) continue;           // nothing new closed
      if (ctx.traded.has(sym) || ctx.open.has(sym)) { s.done = true; continue; }
      const last = s.last!;
      if (ctx.minuteOf(last.t) < rangeEnd || !Number.isFinite(s.hi)) continue;
      const long = meta.gapPct > 0;
      const dir = long ? 1 : -1;
      const gapSize = Math.abs(meta.open - meta.prevClose);
      if (!(gapSize > 0)) { s.done = true; continue; }
      // Gap must hold: worst excursion against the gap since the open.
      const filled = long ? (meta.open - s.lod) / gapSize : (s.hod - meta.open) / gapSize;
      if (filled > p.maxFill) { s.done = true; continue; }   // gap failed: no gap-and-go today
      const close = last.c;
      const level = long ? s.hi : s.lo;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const beyond = (x: number, y: number) => (long ? x > y : x < y);
      const filtersOk = () => {
        if (!beyond(close, (meta.open + meta.prevClose) / 2)) return false;
        if (p.vwapFilter && !beyond(close, vwap)) return false;
        if (p.minRvol) {
          const mins = ctx.minuteOf(last.t) - OPEN + 1;
          const perMin = meta.avgVolume / 390;
          if (!(perMin > 0) || s.vol / mins / perMin < p.minRvol) return false;
        }
        return true;
      };

      let entryLimit: number | undefined;
      let ref = close;
      let pbStop: number | undefined;
      let fire = false;
      if (p.entry === 'market' || p.entry === 'retest') {
        if (!beyond(close, level) || !filtersOk()) continue;
        fire = true;
        if (p.entry === 'retest') { entryLimit = Math.round(level * 100) / 100; ref = entryLimit; }
      } else {
        if (!s.broke) {
          if (beyond(close, level) && filtersOk()) { s.broke = true; s.legExt = long ? last.h : last.l; }
          continue;
        }
        const counter = long ? last.c < last.o : last.c > last.o;
        // Any bar trading back through the range level voids the setup.
        if (!beyond(long ? last.l : last.h, level)) { s.done = true; continue; }
        if (!s.pb || (p.entry === 'mpb' && counter)) {
          if (!counter) { s.legExt = long ? Math.max(s.legExt, last.h) : Math.min(s.legExt, last.l); continue; }
          s.pb = last;                                       // latest pullback bar
          if (p.entry === 'mpblim') {
            const lim = s.legExt - dir * p.pbRetrace * Math.abs(s.legExt - level);
            entryLimit = Math.round(lim * 100) / 100;
            ref = entryLimit;
            pbStop = long ? Math.min(last.l, level) - 0.01 : Math.max(last.h, level) + 0.01;
            if (!filtersOk() || !beyond(close, entryLimit)) { s.done = true; continue; }
            fire = true;
          } else continue;
        } else {
          // mpb: bar closing beyond the pullback bar's extreme.
          const trig = long ? s.pb.h : s.pb.l;
          if (!beyond(close, trig)) continue;
          if (!filtersOk()) { s.done = true; continue; }
          pbStop = long ? Math.min(s.pb.l, last.l) - 0.01 : Math.max(s.pb.h, last.h) + 0.01;
          fire = true;
        }
      }
      if (!fire) continue;
      let stop: number;
      const sm = p.stopMode === 'pb' && pbStop === undefined ? 'mid' : p.stopMode;
      if (sm === 'or' || sm === 'none') stop = long ? s.lo : s.hi; // 'none': sized from the range, not placed
      else if (sm === 'mid') stop = (s.hi + s.lo) / 2;
      else if (sm === 'pb') stop = pbStop!;
      else { // 'atr'
        if (!s.atr) { s.done = true; continue; }
        stop = ref - dir * p.atrStop * s.atr;
      }
      if (!beyond(ref, stop)) { s.done = true; continue; }
      s.done = true;
      out.push({
        symbol: sym, side: long ? 'long' : 'short', stop,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        noStop: p.stopMode === 'none' || undefined,
        tag: `${long ? 'long' : 'short'}-${p.entry}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    minGap: [6, 10], maxSymbols: [10], minPrice: [5], maxPrice: [150], minAvgVol: [1_000_000], side: ['both', 'long'],
    orMinutes: [5], maxFill: [9], vwapFilter: [true], minRvol: [0], cutoffMinutes: [60],
    entry: ['retest', 'mpblim'], pbRetrace: [0.3, 0.6], limitTtl: [3, 10],
    stopMode: ['pb', 'atr', 'none'], atrStop: [0.4], targetR: [0, 4], breakevenAtR: [0], trailR: [0], holdMinutes: [0, 90],
    'rule.riskPerTrade': [100], 'rule.dailyLossLimit': [0], 'rule.maxLosses': [0],
  },
};
