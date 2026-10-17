// r2_pairs: intraday pairs / spread reversion on the liquid + index names.
// At 09:30 (daily bars strictly before today only): candidate pairs are the liquid/index symbols in today's
// dataset whose close-to-close log returns over the last `lookback` days correlate ≥ minCorr (clones above
// 0.995, e.g. SPY/IVV/VOO or GOOG/GOOGL, are excluded in 'corr' mode; 'fixed' mode trades a fixed list incl.
// SPY/QQQ and GOOG/GOOGL whenever both legs are present). Intraday, each symbol's return from today's open is
// divided by its daily ATR(14)% → z; the spread s = zA − zB is compared with a threshold:
//   sd 'daily'   : k × sd(open→close spread of the prior `lookback` days, same ATR units) × √(elapsed/390)
//   sd 'session' : k × sd(1-minute spread increments so far today) × √(elapsed)
// When |s| ≥ threshold (from startMin to lastMin), go long the laggard and short the leader, both legs sized to the
// same $ risk with stop = stopAtr × daily ATR($) from the last close (so share counts are ATR-normalised).
// The harness has no signal-driven exit, so "convergence" can only be approximated: per-leg targetR, a time exit
// holdMin minutes after entry (0 = hold to the flatten), or no stop (noStop). Each pair at most once per day;
// a symbol is in at most one open pair. Entry: market, or LIMIT limOff × ATR better than the last close (legs can
// then fill one-sided). Trades are tagged '<A>/<B>:L' / ':S' so legs can be matched in analysis.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  pairs: 'corr' | 'fixed';
  lookback: number;
  minCorr: number;
  maxPairs: number;     // top pairs by correlation considered per day
  sdMode: 'daily' | 'session';
  k: number;
  startMin: number;     // NY minute-of-day of the first allowed entry
  lastMin: number;
  stopAtr: number;      // per-leg stop distance in daily ATRs (sizing)
  noStop: boolean;
  targetR: number;      // 0 = none
  holdMin: number;      // 0 = hold to the flatten
  entry: 'market' | 'limit';
  limOff: number;       // limit offset in daily ATRs better than the last close
  limTtl: number;
}

const OPEN = 9 * 60 + 30;
const FIXED: [string, string][] = [['SPY', 'QQQ'], ['GOOG', 'GOOGL'], ['SPY', 'IWM'], ['QQQ', 'IWM'], ['QQQ', 'SMH']];

function atr14(d: Bar[]): number | undefined {
  if (d.length < 15) return undefined;
  const x = d.slice(-15);
  let s = 0;
  for (let i = 1; i < x.length; i++) { const pc = x[i - 1].c; s += Math.max(x[i].h - x[i].l, Math.abs(x[i].h - pc), Math.abs(x[i].l - pc)); }
  return s / 14;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function corr(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b);
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}

interface Sym { atr: number; atrPct: number; open: number; seen: number; last?: number }
interface Pair { a: string; b: string; corr: number; sdD: number; n: number; s1: number; s2: number; prev?: number; done: boolean }
interface Day { syms: Map<string, Sym>; pairs: Pair[] }

function candidates(ctx: DayContext): string[] {
  return Object.values(ctx.meta).filter((m) => m.tags.includes('liquid') || m.tags.includes('index')).map((m) => m.symbol).sort();
}

function setup(ctx: DayContext, p: P): Day {
  const syms = new Map<string, Sym>();
  const oc = new Map<string, number[]>(), rc = new Map<string, number[]>();
  for (const s of candidates(ctx)) {
    const d = ctx.dailyBefore(s);
    if (d.length < p.lookback + 15) continue;
    const atr = atr14(d);
    if (!atr || !(atr > 0)) continue;
    const atrPct = atr / d.at(-1)!.c;
    const last = d.slice(-p.lookback - 1);
    rc.set(s, last.slice(1).map((b, i) => Math.log(b.c / last[i].c)));
    oc.set(s, last.slice(1).map((b) => (b.c / b.o - 1) / atrPct));
    syms.set(s, { atr, atrPct, open: ctx.meta[s].open, seen: 0 });
  }
  const list: Pair[] = [];
  const mk = (a: string, b: string): Pair | undefined => {
    if (!syms.has(a) || !syms.has(b)) return undefined; // a leg missing today → no pair
    const c = corr(rc.get(a)!, rc.get(b)!);
    const sdD = stdev(oc.get(a)!.map((x, i) => x - oc.get(b)![i]));
    return { a, b, corr: c, sdD, n: 0, s1: 0, s2: 0, done: false };
  };
  if (p.pairs === 'fixed') {
    for (const [a, b] of FIXED) { const pr = mk(a, b); if (pr && pr.corr >= p.minCorr) list.push(pr); }
  } else {
    const ks = [...syms.keys()];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const pr = mk(ks[i], ks[j]);
      if (pr && pr.corr >= p.minCorr && pr.corr <= 0.995) list.push(pr);
    }
    list.sort((x, y) => y.corr - x.corr);
  }
  return { syms, pairs: list.slice(0, p.maxPairs) };
}

const strategy: Strategy<P> = {
  name: 'r2_pairs',
  universe(ctx: DayContext, p: P) {
    return [...new Set(setup(ctx, p).pairs.flatMap((x) => [x.a, x.b]))];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    let day = ctx.state.get('day') as Day | undefined;
    if (!day) ctx.state.set('day', (day = setup(ctx, p)));
    // Fold in newly closed bars: last close per symbol.
    for (const [s, st] of day.syms) {
      const bars = ctx.bars(s);
      if (bars.length > st.seen) { st.last = bars[bars.length - 1].c; st.seen = bars.length; }
    }
    const tau = ctx.minute - OPEN; // minutes elapsed (bars closed so far)
    const cands: { pr: Pair; s: number; ratio: number }[] = [];
    for (const pr of day.pairs) {
      const A = day.syms.get(pr.a)!, B = day.syms.get(pr.b)!;
      if (A.last === undefined || B.last === undefined) continue;
      const s = (A.last / A.open - 1) / A.atrPct - (B.last / B.open - 1) / B.atrPct;
      if (pr.prev !== undefined) { const d = s - pr.prev; pr.n++; pr.s1 += d; pr.s2 += d * d; }
      pr.prev = s;
      if (pr.done || ctx.minute < p.startMin || ctx.minute > p.lastMin) continue;
      let thr: number;
      if (p.sdMode === 'daily') thr = p.k * pr.sdD * Math.sqrt(tau / 390);
      else {
        if (pr.n < 20) continue;
        const v = (pr.s2 - (pr.s1 * pr.s1) / pr.n) / (pr.n - 1);
        thr = p.k * Math.sqrt(Math.max(v, 0)) * Math.sqrt(tau);
      }
      if (!(thr > 0) || Math.abs(s) < thr) continue;
      cands.push({ pr, s, ratio: Math.abs(s) / thr });
    }
    cands.sort((x, y) => y.ratio - x.ratio);
    const out: Signal[] = [];
    const used = new Set<string>();
    for (const { pr, s } of cands) {
      if (used.has(pr.a) || used.has(pr.b) || ctx.open.has(pr.a) || ctx.open.has(pr.b)) continue;
      pr.done = true;
      used.add(pr.a); used.add(pr.b);
      // s > 0: A has outrun B → short A (leader), long B (laggard).
      const legs: [string, 'long' | 'short'][] = s > 0 ? [[pr.b, 'long'], [pr.a, 'short']] : [[pr.a, 'long'], [pr.b, 'short']];
      const id = `${pr.a}/${pr.b}`;
      for (const [sym, side] of legs) {
        const st = day.syms.get(sym)!;
        const px = st.last!;
        const dist = p.stopAtr * st.atr;
        const sig: Signal = {
          symbol: sym, side, stop: side === 'long' ? px - dist : px + dist, tag: `${id}:${side === 'long' ? 'L' : 'S'}`,
          targetR: p.targetR > 0 ? p.targetR : undefined, noStop: p.noStop || undefined,
          exitMinute: p.holdMin > 0 ? ctx.minute + p.holdMin : undefined,
        };
        if (p.entry === 'limit') {
          const off = p.limOff * st.atr;
          sig.entryLimit = Math.round((side === 'long' ? px - off : px + off) * 100) / 100;
          sig.limitTtl = p.limTtl;
        }
        out.push(sig);
      }
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    pairs: ['corr', 'fixed'], lookback: [40], minCorr: [0.75], maxPairs: [30], sdMode: ['daily', 'session'], k: [1.5, 3],
    startMin: [600], lastMin: [900], stopAtr: [1], noStop: [true], targetR: [0], holdMin: [0, 120],
    entry: ['market'], limOff: [0.05], limTtl: [10],
    // limits ON: daily loss limit = default 3x risk, max 2 losers, max 4 entries (2 pairs); concurrency 2 (one pair) or unlimited
    'rule.riskPerTrade': [50, 100, 200, 500], 'rule.maxTrades': [4], 'rule.maxConcurrent': [2, 0], 'rule.maxLosses': [2],
  },
};
