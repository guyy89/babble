// Multi-condition confluence (round 2).
// Idea: only trade when several independent conditions agree on a direction, then enter on a pullback.
//   a  last close on the trade side of the stock's session VWAP
//   b  EMA9 vs EMA20 aligned with the trade (on 1- or 5-minute closes)
//   c  SPY's last close on the same side of SPY's own session VWAP
//   d  relative volume: cumulative volume ≥ rvolK × avgVolume × (elapsed session fraction)
//   e  the stock has already moved ≥ moveAtr × daily ATR(14) from today's open in that direction
// `req` lists the conditions considered; at least `nReq` of them must hold (nReq ≥ req.length = all).
// Entry: 'now' = market on the next bar as soon as the confluence holds (no pullback; used as the simple
// control "trended ≥ k ATR by 09:45 → hold to close"); 'pb' = market after a 1-min bar whose low (high for
// shorts) touched the pullback level (EMA9 / EMA20 / VWAP) and closed back on the trade side; 'lim' = a LIMIT at
// the pullback level while the confluence holds and price is still away from it (fills on a trade-through).
// Stop: 'pb' = beyond the low/high of the last 3 bars ± stopK × ATR; 'atr' = atrK × ATR from the entry reference.
// noStop: size from atrK × ATR (never from the tight pullback stop) but do not place it (exit by target / time / close).
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore only; onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'gap' | 'liquid' | 'all';
  req: string;             // subset of 'abcde'
  nReq: number;            // how many of req must hold
  emaTf: 1 | 5;            // bar size for the EMA alignment (b) and EMA pullback levels
  rvolK: number;           // (d) threshold
  moveAtr: number;         // (e) threshold, in daily ATR
  start: number;           // first entry minute after 09:30
  end: number;             // last entry minute after 09:30
  direction: 'both' | 'long' | 'short';
  entry: 'now' | 'pb' | 'lim';
  pbLevel: 'ema9' | 'ema20' | 'vwap';
  limTtl: number;
  stopMode: 'pb' | 'atr';
  stopK: number;           // pb mode: buffer beyond the 3-bar extreme, in ATR
  atrK: number;            // atr mode: distance, in ATR
  targetR: number;         // 0 = none
  trailR: number;          // 0 = off
  breakevenAtR: number;    // 0 = off
  noStop: boolean;
  exitMin: number;         // 0 = flatten; else exit at this minute after 09:30
  maxPerDay: number;       // candidates per minute (best move/ATR first); 0 = all
}

interface S {
  seen: number;
  atr: number;
  avgVol: number;
  open: number;
  pv: number; vol: number;
  e9: number; e20: number; n1: number;          // 1-min EMAs
  f9: number; f20: number; n5: number;          // 5-min EMAs (updated at bucket closes)
  bucketClose?: number;
  last?: Bar;
  recent: Bar[];                                // last 3 bars
}

const OPEN = 9 * 60 + 30;
const a9 = 2 / 10, a20 = 2 / 21;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function fold(ctx: MinuteContext, sym: string): S | undefined {
  const bars = ctx.bars(sym);
  if (!bars.length) return undefined;
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), avgVol: ctx.meta[sym]?.avgVolume ?? 0, open: bars[0].o, pv: 0, vol: 0,
      e9: bars[0].c, e20: bars[0].c, n1: 0, f9: NaN, f20: NaN, n5: 0, recent: [] };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const b = bars[s.seen];
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    if (s.n1 === 0) { s.e9 = b.c; s.e20 = b.c; } else { s.e9 += a9 * (b.c - s.e9); s.e20 += a20 * (b.c - s.e20); }
    s.n1++;
    const bm = ctx.minuteOf(b.t);
    if ((bm - OPEN + 1) % 5 === 0) { // bar closes a 5-minute bucket
      if (s.n5 === 0) { s.f9 = b.c; s.f20 = b.c; } else { s.f9 += a9 * (b.c - s.f9); s.f20 += a20 * (b.c - s.f20); }
      s.n5++;
    }
    s.last = b;
    s.recent.push(b);
    if (s.recent.length > 3) s.recent.shift();
  }
  return s;
}

const strategy: Strategy<P> = {
  name: 'r2_confluence',
  universe(ctx: DayContext, p: P) {
    const syms = Object.values(ctx.meta)
      .filter((m) => {
        if (m.symbol === 'SPY') return true; // watched for condition (c), never traded
        if (m.tags.includes('index') || m.open < 5) return false;
        if (p.uni === 'gap') return m.tags.includes('gap');
        if (p.uni === 'liquid') return m.tags.includes('liquid');
        return true;
      })
      .map((m) => m.symbol);
    return syms;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    const spy = fold(ctx, 'SPY');
    const syms = Object.keys(ctx.meta).filter((x) => x !== 'SPY');
    const states = syms.map((x) => [x, fold(ctx, x)] as const);
    if (rel < p.start || rel > p.end || !spy?.last) return [];
    const spyVw = spy.pv / spy.vol;
    const frac = Math.min(1, rel / 390);
    const cands: { sig: Signal; score: number }[] = [];
    for (const [sym, s] of states) {
      if (!s?.last || ctx.traded.has(sym) || ctx.open.has(sym) || !(s.atr > 0) || !(s.vol > 0)) continue;
      if (p.emaTf === 5 && s.n5 < 2) continue;
      const c = s.last.c;
      const vw = s.pv / s.vol;
      const f = p.emaTf === 5 ? [s.f9, s.f20] : [s.e9, s.e20];
      const rv = s.avgVol > 0 ? s.vol / (s.avgVol * frac) : 0;
      const mv = (c - s.open) / s.atr;
      for (const side of ['long', 'short'] as const) {
        if (p.direction !== 'both' && p.direction !== side) continue;
        const d = side === 'long' ? 1 : -1;
        const cond: Record<string, boolean> = {
          a: (c - vw) * d > 0,
          b: (f[0] - f[1]) * d > 0,
          c: (spy.last.c - spyVw) * d > 0,
          d: rv >= p.rvolK,
          e: mv * d >= p.moveAtr,
        };
        const held = [...p.req].filter((k) => cond[k]).length;
        if (held < Math.min(p.nReq, p.req.length)) continue;
        const lvl = p.pbLevel === 'vwap' ? vw : p.pbLevel === 'ema9' ? f[0] : f[1];
        let ref: number;
        if (p.entry === 'now') ref = c;
        else if (p.entry === 'pb') {
          // pullback bar: touched the level and closed back on the trade side of it
          const touched = side === 'long' ? s.last.l <= lvl : s.last.h >= lvl;
          if (!touched || (c - lvl) * d <= 0) continue;
          ref = c;
        } else {
          if ((c - lvl) * d <= 0) continue; // already through the level: no pullback limit
          ref = lvl;
        }
        const ext = side === 'long' ? Math.min(...s.recent.map((b) => b.l), ref) : Math.max(...s.recent.map((b) => b.h), ref);
        // noStop always sizes from the ATR distance (a tight pullback stop would inflate R on an unstopped trade)
        const stop = p.stopMode === 'pb' && !p.noStop ? ext - d * p.stopK * s.atr : ref - d * p.atrK * s.atr;
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
        cands.push({ sig, score: Math.abs(mv) });
        break;
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return (p.maxPerDay ? cands.slice(0, p.maxPerDay) : cands).map((x) => x.sig);
  },
};

// Run log (design exploration on 2026-04-16..06-15 only, scratch explore.ts; ~470 configs):
//  liquid >> gap/all; LIMIT at the pullback level >> market-after-pullback; maxConcurrent 2 >> unlimited;
//  limTtl 10 > 5/20; ablation: VWAP (a) redundant, SPY (c) and rvol (d) add most; 'e' alone ~half; 09:45 ≥k ATR
//  hold-to-close control negative in the design period. noStop with tight-stop sizing inflated R (fixed: ATR sizing).
//  wf1 (128 cfg): pre-registered core grid from the design period → WF +9.5R, t 0.43, PF 1.08, stress -1.4R, FAIL.
//  wf2 (192 cfg): design-period core (nReq 5, move 0.3 ATR, EMA9, 0.25 ATR stop) × risk tiers × maxTrades/maxConcurrent
//         × market-after-pullback vs limit (ttl 5/10/20) × target 0/2; default daily loss limit (not shaped by wf1).
//         → WF -16.7R, t -0.80, PF 0.77, stress -20.9R, FAIL (later months picked maxConcurrent 0 / market entries).
//  wf3 (96 cfg): exits on the design core with the daily loss limit OFF: stop vs noStop (noStop sized from atrK × ATR),
//         target 0/2/4R, trail 0/1.5R, breakeven 0/1R, atrK 0.25/0.5, flatten vs 14:30 time exit, $100 tier.
//         → WF -10.2R, t -0.38, PF 0.93, stress -17.3R, FAIL. Best full-period config +50R / 326 trades
//         (~+27R of it in the design months) — inside the random-control best-of-hundreds range (+40–75R).
//  Control (fixed, not tuned): liquid names ≥0.5 ATR from the open at 09:45, market, hold to close, ATR-sized
//         noStop: +12.4R / 215 trades / $1,093 at $100 risk (long +28R, short -16R); ≥1 ATR: 15 trades, +2.3R.
//  Verdict: no edge.
export default {
  strategy,
  grid: {
    uni: ['liquid'],
    req: ['abcde'],
    nReq: [5],
    emaTf: [1],
    rvolK: [1],
    moveAtr: [0.3],
    start: [15],
    end: [240],
    direction: ['both'],
    entry: ['lim'],
    pbLevel: ['ema9'],
    limTtl: [10],
    stopMode: ['atr'],
    stopK: [0.05],
    atrK: [0.25, 0.5],
    targetR: [0, 2, 4],
    trailR: [0, 1.5],
    breakevenAtR: [0, 1],
    noStop: [false, true],
    exitMin: [0, 300],
    maxPerDay: [0],
    'rule.riskPerTrade': [100],
    'rule.dailyLossLimit': [0],
  },
};
