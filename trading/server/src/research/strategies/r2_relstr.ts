// Intraday relative strength vs the market (round 2).
// Idea: at a decision time, measure each stock's move from a reference (today's open or yesterday's close) minus
// SPY's move over the same window, scaled by the stock's daily ATR (in %). Go long the strongest / short the
// weakest names whose relative move exceeds a threshold, optionally only when SPY moved the other way ("holds up
// on index dips"), and hold to a time exit or the flatten.
// Score modes:
//   'total' = (stock return − SPY return) / ATR%      (classic relative strength)
//   'dip'   = Σ over minutes where SPY fell of (stock 1m return − SPY 1m return), / ATR%  (holds up on dips)
//   'abs'   = stock return / ATR%  (CONTROL: plain absolute trend, no market adjustment)
//   'inv'   = minus 'total' (CONTROL: long the WEAKEST / short the strongest; no direction-of-move check)
// No look-ahead: universe() uses ctx.meta only (SPY is always watched for its bars, never traded);
// onMinute() folds in closed bars incrementally; ATR from ctx.dailyBefore().
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'liquid' | 'gap' | 'all';
  refMode: 'open' | 'prev';   // reference price: 09:30 open, or previous close (includes the gap)
  scoreMode: 'total' | 'dip' | 'abs' | 'inv';
  decMin: number;             // decision minute after 09:30 (e.g. 30 = 10:00)
  scanEnd: number;            // 0 = one-shot at decMin; else re-scan every minute up to this minute after 09:30
  thr: number;                // minimum |score| (ATR units)
  topN: number;               // names per side
  direction: 'long' | 'short' | 'both';
  spyFilter: 'none' | 'against' | 'with'; // against: long only if SPY ≤ 0 since ref (short only if SPY ≥ 0)
  vwapFilter: boolean;        // long above / short below session VWAP
  entry: 'mkt' | 'lim';
  limOff: number;             // limit: ATR fraction better than the last close
  limTtl: number;
  stopMode: 'atr' | 'ext';    // atr: atrK × ATR from the entry reference; ext: beyond the day's extreme + stopK × ATR
  atrK: number;
  stopK: number;
  targetR: number;            // 0 = none
  trailR: number;             // 0 = off
  breakevenAtR: number;       // 0 = off
  noStop: boolean;            // size from the stop but do not place it
  exitMin: number;            // 0 = flatten; else exit at this minute after 09:30
}

interface S {
  seen: number;
  atrPct: number;
  atr: number;
  ref: number;
  hi: number; lo: number;
  pv: number; vol: number;
  dip: number;
  prevC?: number;
  last?: Bar;
}

const OPEN = 9 * 60 + 30;
const SPY = 'SPY';

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function tradeable(m: DayContext['meta'][string], p: P): boolean {
  if (m.tags.includes('index') || m.open < 5) return false;
  if (p.uni === 'liquid') return m.tags.includes('liquid');
  if (p.uni === 'gap') return m.tags.includes('gap');
  return true;
}

const strategy: Strategy<P> = {
  name: 'r2_relstr',
  universe(ctx: DayContext, p: P) {
    const syms = Object.values(ctx.meta).filter((m) => tradeable(m, p)).map((m) => m.symbol);
    return ctx.meta[SPY] ? [SPY, ...syms] : syms;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    // SPY first, so per-minute SPY returns are known when the other symbols fold in the same minute.
    let spy = ctx.state.get('__spy') as { s: S; closes: Map<number, number> } | undefined;
    const spyBars = ctx.bars(SPY);
    if (!spyBars.length) return [];
    if (!spy) {
      spy = { s: { seen: 0, atrPct: NaN, atr: NaN, ref: p.refMode === 'open' ? spyBars[0].o : ctx.meta[SPY].prevClose, hi: -Infinity, lo: Infinity, pv: 0, vol: 0, dip: 0 }, closes: new Map() };
      ctx.state.set('__spy', spy);
    }
    for (; spy.s.seen < spyBars.length; spy.s.seen++) {
      const b = spyBars[spy.s.seen];
      spy.closes.set(ctx.minuteOf(b.t), b.c);
      spy.s.last = b;
    }
    const spyRet = spy.s.last!.c / spy.s.ref - 1;

    const evalNow = p.scanEnd ? rel >= p.decMin && rel <= p.scanEnd : rel === p.decMin;
    const longs: { sig: Signal; score: number }[] = [];
    const shorts: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      if (sym === SPY || !tradeable(ctx.meta[sym], p)) continue;
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const db = ctx.dailyBefore(sym);
        const atr = dailyAtr(db);
        const lastClose = db.length ? db[db.length - 1].c : ctx.meta[sym].prevClose;
        s = { seen: 0, atr, atrPct: atr / lastClose, ref: p.refMode === 'open' ? bars[0].o : ctx.meta[sym].prevClose, hi: -Infinity, lo: Infinity, pv: 0, vol: 0, dip: 0 };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const m = ctx.minuteOf(b.t);
        s.hi = Math.max(s.hi, b.h);
        s.lo = Math.min(s.lo, b.l);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        // "Holds up on dips": excess 1-minute return on minutes where SPY fell (both returns on the same minute).
        const sc = spy.closes.get(m), sp = spy.closes.get(m - 1);
        if (s.prevC !== undefined && sc !== undefined && sp !== undefined && sc < sp) s.dip += (b.c / s.prevC - 1) - (sc / sp - 1);
        s.prevC = b.c;
        s.last = b;
      }
      if (!evalNow || ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !(s.atrPct > 0)) continue;
      const c = s.last.c;
      const ret = c / s.ref - 1;
      const score = p.scoreMode === 'abs' ? ret / s.atrPct : p.scoreMode === 'dip' ? s.dip / s.atrPct : p.scoreMode === 'inv' ? -(ret - spyRet) / s.atrPct : (ret - spyRet) / s.atrPct;
      if (Math.abs(score) < p.thr) continue;
      const side: 'long' | 'short' = score > 0 ? 'long' : 'short';
      if (p.direction !== 'both' && p.direction !== side) continue;
      // The stock itself must be moving in the trade direction (RS of a falling stock is not "strength").
      if (p.scoreMode !== 'inv' && (side === 'long' ? ret <= 0 : ret >= 0)) continue;
      if (p.spyFilter === 'against' && (side === 'long' ? spyRet > 0 : spyRet < 0)) continue;
      if (p.spyFilter === 'with' && (side === 'long' ? spyRet < 0 : spyRet > 0)) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : c;
      if (p.vwapFilter && (side === 'long' ? c <= vwap : c >= vwap)) continue;
      const d = side === 'long' ? 1 : -1;
      const ref = p.entry === 'lim' ? c - d * p.limOff * s.atr : c;
      const stop = p.stopMode === 'atr' || p.noStop ? ref - d * p.atrK * s.atr : (side === 'long' ? s.lo : s.hi) - d * p.stopK * s.atr;
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
      (side === 'long' ? longs : shorts).push({ sig, score: Math.abs(score) });
    }
    if (!longs.length && !shorts.length) return [];
    // Top-N per side by |score| (in scan mode: per minute, minus names already traded/open).
    const already = ctx.state.get('__n') as { long: number; short: number } | undefined ?? { long: 0, short: 0 };
    const L = longs.sort((a, b) => b.score - a.score).slice(0, Math.max(0, p.topN - already.long));
    const Sh = shorts.sort((a, b) => b.score - a.score).slice(0, Math.max(0, p.topN - already.short));
    already.long += L.length;
    already.short += Sh.length;
    ctx.state.set('__n', already);
    return [...L, ...Sh].sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

// Run log (exploration on 2026-04-16..2026-06-15 only; see report):
//  wf run 1: idea dimensions (liquid; long vs both; ref prev/open; total RS vs abs control; decision 10:00/10:30/11:00 + 09:45 control; thr; topN).
//         96 cfg -> WF +0.58R, t 0.05, PF 1.00, 132 trades, months -2.9/-5.9/+8.4/+1.0, stress -4.1R: FAIL.
//  wf run 2 (planned from the design months only, not from run 1): core = liquid, long, prev-close ref, RS 'total',
//         decision 10:00/10:30, top 2/3; risk tiers 50/100/200/500, maxConcurrent 2/0, maxTrades 3/0, market vs
//         limit (0.05 ATR better, ttl 10/30).
//         256 cfg -> WF -2.08R, t -0.18, PF 0.96, 147 trades, months +1.3/-1.6/+0.4/-2.2, stress -4.1R: FAIL.
//  wf run 3 (exits; planned from the design months before run 1, not tuned on runs 1-2): core at decision 10:30, top 3,
//         limits off; stop 0.35/0.5/1 ATR vs noStop (sized from that distance), target 0/2R, trail 0/1.5R,
//         breakeven 0/1R, time exit 14:30 vs flatten; risk 100/500.
//         192 cfg -> WF +14.1R, t 1.06, PF 1.23, 189 trades, months +8.9/-6.3/+13.0/-1.5, stress +10.2R: FAIL (2/4 months, t).
//         Picks were noStop sized from a 0.35-ATR stop (worst trade -$1.6k = 3.3R, worst day -$3.7k at $500 risk);
//         with the stop placed the same core makes ~0R over the test months. RS vs SPY ~ plain absolute-move control.
//  Verdict: no robust edge; the residual is long-only drift in liquid leaders, amplified by tight-stop sizing.
export default {
  strategy,
  grid: {
    uni: ['liquid'],
    refMode: ['prev'],
    scoreMode: ['total'],
    decMin: [60],
    scanEnd: [0],
    thr: [0.25],
    topN: [3],
    direction: ['long'],
    spyFilter: ['none'],
    vwapFilter: [true],
    entry: ['mkt'],
    limOff: [0.05],
    limTtl: [10],
    stopMode: ['atr'],
    atrK: [0.35, 0.5, 1],
    stopK: [0.1],
    targetR: [0, 2],
    trailR: [0, 1.5],
    breakevenAtR: [0, 1],
    noStop: [false, true],
    exitMin: [0, 300],
    'rule.riskPerTrade': [100, 500],
    'rule.dailyLossLimit': [0],
    'rule.maxTrades': [0],
    'rule.maxConcurrent': [0],
  },
};
