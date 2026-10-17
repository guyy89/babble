// Laggard catch-up: when a leader basket (index ETFs, or the semiconductor group) has made a strong move by a
// decision time, liquid names that historically co-move with it (daily beta/correlation from PRIOR daily bars only)
// but have not moved yet are bought (sold short) in the leaders' direction, expecting them to catch up.
//   leader move  L = mean over leaders of (last close / ref - 1), ref = today's open or yesterday's close
//   trigger      |L| >= moveZ × σ(daily basket return)
//   follower c   corr(c, basket) >= minCorr; expected = β_c × L_(-c) (leave-one-out basket); actual = c's move
//   laggard      actual/expected in [minFrac, lagFrac]  → enter in sign(L); rank by (expected - actual)/σ_c
// Stops are a fraction of the follower's 14-day ATR (also used for sizing when noStop is set).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  leaders: 'index' | 'semis';
  ref: 'open' | 'prev';
  cands: 'liquid' | 'liquid+gap';
  lookback: number;   // daily bars for beta/corr/σ
  minCorr: number;
  moveZ: number;      // leader-basket move threshold in daily σ units
  lagFrac: number;    // follower has done at most this fraction of its expected move
  minFrac: number;    // ... and at least this fraction (negative = moving against, allowed up to this)
  decTimes: string;   // NY minutes-of-day at which to decide, comma-separated (e.g. "600" or "600,660,720")
  topK: number;       // laggards per decision
  dir: 'both' | 'long' | 'short';
  stopAtr: number;    // stop distance in daily ATR
  noStop: boolean;    // size from stopAtr but exit only by target/time/close
  targetR: number;    // 0 = none
  beR: number;        // 0 = off
  trailR: number;     // 0 = off
  holdMin: number;    // time exit this many minutes after the decision (0 = flatten time)
  entry: 'market' | 'limit';
  limAtr: number;     // limit this many ATR better than the last close
  limitTtl: number;
}

const ETF = new Set(['SPY', 'QQQ', 'IWM', 'IVV', 'VOO', 'TQQQ', 'SQQQ', 'SMH', 'SOXX', 'SOXL', 'GLD', 'HYG', 'TLT', 'DIA', 'XLK', 'SPCX']);
const LEADERS: Record<P['leaders'], string[]> = {
  index: ['SPY', 'QQQ'],
  semis: ['NVDA', 'AMD', 'MU', 'AVGO', 'SMH', 'SOXX', 'TSM', 'MRVL', 'INTC', 'QCOM', 'AMAT', 'LRCX', 'ARM', 'SNDK', 'SKHY'],
};

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily close-to-close returns keyed by date (strictly before today). */
function rets(bars: Bar[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0) m.set(dayKey(bars[i].t), bars[i].c / bars[i - 1].c - 1);
  return m;
}

function atr(bars: Bar[], n = 14): number {
  const xs: number[] = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    xs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

interface Stat { beta: number; corr: number; sigC: number; atr: number }
interface DayInfo { leaders: string[]; cands: string[]; sigB: number; stats: Map<string, Stat> }

// Pure function of (date, meta, dailyBefore, params) → safe to cache across configurations.
const cache = new Map<string, DayInfo>();

function dayInfo(ctx: DayContext, p: P): DayInfo {
  const key = `${ctx.date}|${p.leaders}|${p.cands}|${p.lookback}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 2000) cache.clear();
  const leaders = LEADERS[p.leaders].filter((s) => ctx.meta[s]);
  const cands = Object.values(ctx.meta)
    .filter((m) => !ETF.has(m.symbol) && !(p.leaders === 'index' && leaders.includes(m.symbol)))
    .filter((m) => m.tags.includes('liquid') || (p.cands === 'liquid+gap' && m.tags.includes('gap') && m.open >= 10 && m.avgVolume >= 1_000_000))
    .map((m) => m.symbol);
  const R = new Map<string, Map<string, number>>();
  const getR = (s: string) => { let r = R.get(s); if (!r) R.set(s, (r = rets(ctx.dailyBefore(s)))); return r; };
  const basket = (excl: string) => {
    const ls = leaders.filter((s) => s !== excl);
    const dates = [...getR(ls[0] ?? '').keys()].slice(-p.lookback);
    const out = new Map<string, number>();
    for (const d of dates) {
      const xs = ls.map((s) => getR(s).get(d)).filter((x): x is number => x !== undefined);
      if (xs.length) out.set(d, xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    return out;
  };
  const sd = (xs: number[]) => { const mu = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const full = basket('');
  const sigB = full.size > 5 ? sd([...full.values()]) : NaN;
  const stats = new Map<string, Stat>();
  for (const c of cands) {
    const b = leaders.includes(c) ? basket(c) : full;
    const rc = getR(c);
    const xs: number[] = [], ys: number[] = [];
    for (const [d, bv] of b) { const cv = rc.get(d); if (cv !== undefined) { xs.push(bv); ys.push(cv); } }
    if (xs.length < Math.min(15, p.lookback * 0.75)) continue;
    const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    if (!(sxx > 0 && syy > 0)) continue;
    stats.set(c, { beta: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy), sigC: Math.sqrt(syy / (ys.length - 1)), atr: atr(ctx.dailyBefore(c)) });
  }
  const info = { leaders, cands, sigB, stats };
  cache.set(key, info);
  return info;
}

const strategy: Strategy<P> = {
  name: 'r2_laggard',
  universe(ctx: DayContext, p: P) {
    const info = dayInfo(ctx, p);
    return [...new Set([...info.leaders, ...info.cands])];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    let times = ctx.state.get('times') as number[] | undefined;
    if (!times) ctx.state.set('times', (times = String(p.decTimes).split(',').map(Number)));
    if (!times.includes(ctx.minute)) return [];
    const info = dayInfo(ctx, p);
    if (!(info.sigB > 0)) return [];
    // Current move of each leader from the reference price, using only closed bars.
    const move = (s: string): number | undefined => {
      const bars = ctx.bars(s);
      const last = bars.at(-1);
      const m = ctx.meta[s];
      const ref = p.ref === 'open' ? m?.open : m?.prevClose;
      if (!last || !(ref! > 0)) return undefined;
      return last.c / ref! - 1;
    };
    const lm = new Map<string, number>();
    for (const s of info.leaders) { const x = move(s); if (x !== undefined) lm.set(s, x); }
    if (!lm.size) return [];
    const avg = (excl: string) => { const xs = [...lm].filter(([s]) => s !== excl).map(([, v]) => v); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; };
    const L = avg('');
    if (!(Math.abs(L) >= p.moveZ * info.sigB)) return [];
    const side = L > 0 ? 'long' : 'short';
    if (p.dir !== 'both' && p.dir !== side) return [];
    const sgn = L > 0 ? 1 : -1;
    const picks: { sym: string; score: number; px: number; atr: number }[] = [];
    for (const c of info.cands) {
      if (ctx.open.has(c) || ctx.traded.has(c)) continue;
      const st = info.stats.get(c);
      if (!st || st.corr < p.minCorr || st.beta <= 0 || !(st.atr > 0)) continue;
      const a = move(c);
      if (a === undefined) continue;
      const Lc = info.leaders.includes(c) ? avg(c) : L;
      if (!Number.isFinite(Lc) || Math.sign(Lc) !== sgn) continue;
      const exp = st.beta * Lc;
      const frac = a / exp;
      if (frac > p.lagFrac || frac < p.minFrac) continue;
      picks.push({ sym: c, score: (exp - a) * sgn / st.sigC, px: ctx.bars(c).at(-1)!.c, atr: st.atr });
    }
    picks.sort((x, y) => y.score - x.score);
    return picks.slice(0, p.topK).map(({ sym, px, atr: A }) => {
      const d = p.stopAtr * A;
      const lim = p.entry === 'limit' ? Math.round((px - sgn * p.limAtr * A) * 100) / 100 : undefined;
      const base = lim ?? px;
      return {
        symbol: sym, side, stop: Math.round((base - sgn * d) * 100) / 100,
        targetR: p.targetR || undefined, breakevenAtR: p.beR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined, noStop: p.noStop || undefined,
        entryLimit: lim, limitTtl: lim !== undefined ? p.limitTtl : undefined, tag: `${p.leaders}-${side}`,
      } as Signal;
    });
  },
};

export default {
  strategy,
  grid: {
    // wf run 3: sensible sizing only (stop/sizing 0.75–1.0 daily ATR) with real-stop exits; chosen knowing runs 1–2
    // (all their picks were noStop at 0.3 ATR, i.e. inflated R) — measures the honest version, not a rescue attempt.
    leaders: ['index'], ref: ['prev'], cands: ['liquid'], lookback: [40], minCorr: [0.5], moveZ: [0.5, 0.8], lagFrac: [0.3, 1], minFrac: [-5],
    decTimes: ['660,690,720,750,780,810,840,870'], topK: [3], dir: ['long', 'both'], stopAtr: [0.75, 1.0], noStop: [true, false],
    targetR: [0, 2], beR: [0], trailR: [0, 1], holdMin: [0], entry: ['market'], limAtr: [0.03], limitTtl: [5],
    'rule.riskPerTrade': [50, 500], 'rule.maxConcurrent': [0],
  } as Record<string, unknown[]>,
};
export { dayInfo };
