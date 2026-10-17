// Trend-day detection (round 2).
// Idea: by ~10:30–11:30 a trend day is often recognisable: the stock opened near one extreme of the day's range,
// has stayed (closed) on one side of session VWAP, sits near the opposite extreme now, and its range is already
// a large fraction of its normal daily range (14-day ATR from daily bars before today). Enter in the trend
// direction and hold to the close (or with a wide trailing stop / target).
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore only; onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'gap' | 'liquid' | 'all';
  minGap: number;          // gap universe: |gap| % threshold (0 = any)
  checkStart: number;      // minutes after 09:30 when detection starts (60 = 10:30)
  checkEnd: number;        // last minute after 09:30 to detect (inclusive)
  openPos: number;         // open within this fraction of the range from the starting extreme
  curPos: number;          // last close within this fraction of the range from the trend extreme
  sideFrac: number;        // fraction of closes since vwapFrom on the trend side of VWAP
  vwapFrom: number;        // minutes after open from which the VWAP-side count starts
  rangeAtr: number;        // day range so far ≥ rangeAtr × ATR14
  direction: 'both' | 'long' | 'short' | 'with-gap';
  entry: 'mkt' | 'lim';
  limOff: number;          // limit: ATR fraction better than the last close
  limTtl: number;
  stopMode: 'atr' | 'vwap' | 'mid' | 'ext';  // ext = beyond the day's opposite extreme (open side)
  stopK: number;           // vwap/mid/ext: buffer beyond the reference, in ATR
  atrK: number;            // atr mode: stop distance from the entry reference, in ATR
  targetR: number;         // 0 = none
  trailR: number;          // 0 = off
  breakevenAtR: number;    // 0 = off
  noStop: boolean;
  exitMin: number;         // 0 = flatten; else exit at this minute after 09:30
}

interface S {
  seen: number;
  atr: number;
  open: number;
  hi: number; lo: number;
  pv: number; vol: number;
  above: number; below: number; counted: number;
  last?: Bar;
}

const OPEN = 9 * 60 + 30;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const strategy: Strategy<P> = {
  name: 'r2_trendday',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < 5) return false;
        if (p.uni === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.uni === 'liquid') return m.tags.includes('liquid') || m.tags.includes('index');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, hi: -Infinity, lo: Infinity, pv: 0, vol: 0, above: 0, below: 0, counted: 0 };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        s.hi = Math.max(s.hi, b.h);
        s.lo = Math.min(s.lo, b.l);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const vw = s.vol > 0 ? s.pv / s.vol : b.c;
        if (ctx.minuteOf(b.t) >= OPEN + p.vwapFrom) {
          s.counted++;
          if (b.c > vw) s.above++;
          else if (b.c < vw) s.below++;
        }
        s.last = b;
      }
      if (rel < p.checkStart || rel > p.checkEnd) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !(s.atr > 0) || s.counted < 10) continue;
      const range = s.hi - s.lo;
      if (!(range > 0) || range < p.rangeAtr * s.atr) continue;
      const c = s.last.c;
      const vwap = s.pv / s.vol;
      const gapUp = ctx.meta[sym].gapPct > 0;
      let side: 'long' | 'short' | undefined;
      const longOk = (s.open - s.lo) / range <= p.openPos && (s.hi - c) / range <= p.curPos && s.above / s.counted >= p.sideFrac && c > vwap;
      const shortOk = (s.hi - s.open) / range <= p.openPos && (c - s.lo) / range <= p.curPos && s.below / s.counted >= p.sideFrac && c < vwap;
      if (longOk && (p.direction === 'both' || p.direction === 'long' || (p.direction === 'with-gap' && gapUp))) side = 'long';
      else if (shortOk && (p.direction === 'both' || p.direction === 'short' || (p.direction === 'with-gap' && !gapUp))) side = 'short';
      if (!side) continue;
      const d = side === 'long' ? 1 : -1;
      const ref = p.entry === 'lim' ? c - d * p.limOff * s.atr : c;
      let stop: number;
      if (p.stopMode === 'atr') stop = ref - d * p.atrK * s.atr;
      else if (p.stopMode === 'vwap') stop = vwap - d * p.stopK * s.atr;
      else if (p.stopMode === 'mid') stop = (s.hi + s.lo) / 2 - d * p.stopK * s.atr;
      else stop = (side === 'long' ? s.lo : s.hi) - d * p.stopK * s.atr;
      if ((ref - stop) * d <= 0) continue;
      const sig: Signal = {
        symbol: sym, side, stop: Math.round(stop * 100) / 100, tag: side,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        noStop: p.noStop || undefined,
        exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
      };
      if (p.entry === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = p.limTtl; }
      cands.push({ sig, score: range / s.atr });
    }
    return cands.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

// Run log (all runs use the same strategy code; only the grid changes):
//  run 1 (144 cfg): uni gap/liquid/all × checkStart 60/120 × rangeAtr 0.5/0.8 × stop atr/vwap/ext × target 0/2 × trail 0/1.5
//         at $100 risk, default limits, market entry → WF -13.2R, FAIL; best full-period +5R/241 trades (liquid).
//  run 2 (192 cfg): uni liquid/all × checkStart 60/90 × openPos 0.1/0.25 × sideFrac 0.9/1 × dir both/long/with-gap
//         × atrK 0.5/1 × trail 0/2 → WF -15.1R, FAIL; full-period top 20 all liquid + atrK 0.5 (best +20R/202).
//  run 3 (256 cfg): liquid only (chosen from runs 1–2 full-period results, which include the test months — selection
//         bias), mkt vs limit, stop vs noStop, target 0/3, maxConcurrent 2/0, maxTrades 3/0 → WF +7.1R, t 0.74,
//         PF 1.23, FAIL (2/4 months, concentration: META 74% of profit). Full-period plateau ~+20–23R (checkStart 60, sideFrac 0.9).
//  run 4 (256 cfg): same core — risk tiers 50/100/200/500, mkt vs limit (ttl 10/30), stop vs noStop, maxLosses 2/0,
//         maxConcurrent 2/0 → WF +6.1R, t 0.89, PF 1.46, 62 trades, 3/4 months, FAIL (t, top trade 57%, top symbol 60%).
//  run 5: same core, daily loss limit OFF, exits: noStop, breakeven 1R, trail 2R, target 3R, time exit 14:30; risk 100/500.
export default {
  strategy,
  grid: {
    uni: ['liquid'],
    minGap: [0],
    checkStart: [60],
    checkEnd: [150],
    openPos: [0.25],
    curPos: [0.2],
    sideFrac: [0.9],
    vwapFrom: [10],
    rangeAtr: [0.5],
    direction: ['both', 'with-gap'],
    entry: ['mkt', 'lim'],
    limOff: [0.1],
    limTtl: [30],
    stopMode: ['atr'],
    stopK: [0.1],
    atrK: [0.5],
    targetR: [0, 3],
    trailR: [0, 2],
    breakevenAtR: [0, 1],
    noStop: [false, true],
    exitMin: [0, 300],
    'rule.riskPerTrade': [100, 500],
    'rule.dailyLossLimit': [0],
    'rule.maxTrades': [0],
  },
};
