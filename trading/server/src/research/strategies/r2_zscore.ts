// r2_zscore: rolling z-score mean reversion on N-minute buckets (aligned to 09:30).
//  z = (close − SMA_len(close)) / SD_len(close), using only today's completed buckets.
//  Entry against an extreme: bucket n−1 closed with |z| ≥ zIn and bucket n "failed to extend" (no new extreme
//  beyond bucket n−1's high/low and closed back toward the mean) → fade. confirm 'none' = enter on the bucket
//  that first crosses |z| ≥ zIn.
//  Exits: target at the rolling mean as of the signal (z → 0), at mean ± zOut·SD (z → ±zOut), a fixed R, or
//  none; a time limit (holdMinutes); stop beyond the excursion extreme (+ stopSd·SD), or c ± stopSd·SD, widened
//  to at least minStopPct of price; optional noStop (time exit only), breakeven, trailing.
//  Filters: universe tag, time-of-day window, daily trend filter (skip a symbol whose |prevClose − SMA20| exceeds
//  trendMax × ATR14 of daily bars), intraday trend filter (skip while |close − today's open| > dayMoveMax × ATR14).
// Limitation: the harness has no dynamic exits, so "z back to 0" is the mean frozen at signal time.
// No look-ahead: universe() uses ctx.meta only; daily stats use ctx.dailyBefore (strictly before today);
// onMinute() folds closed 1-minute bars incrementally and acts only on buckets whose last minute has closed.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  barMinutes: number;
  len: number;                // rolling window in buckets
  zIn: number;                // |z| threshold of the extreme bucket
  confirm: 'fail' | 'none';
  tags: 'index' | 'liquid' | 'gap' | 'all';
  startMinute: number;        // first NY minute for signals
  cutoffMinute: number;       // last NY minute for signals
  trendMax: number;           // daily trend filter in ATRs (0 = off)
  dayMoveMax: number;         // intraday move filter in ATRs (0 = off)
  direction: 'both' | 'long' | 'short';
  stopMode: 'extreme' | 'sd';
  stopSd: number;
  minStopPct: number;         // widen stops to at least this % of price
  noStop: boolean;
  target: 'mean' | 'zout' | 'r' | 'none';
  zOut: number;
  targetR: number;
  minTargetR: number;         // skip mean/zout targets closer than this many R
  breakevenAtR: number;       // 0 = off
  trailR: number;             // 0 = off
  holdMinutes: number;        // 0 = until flatten
  entry: 'market' | 'limit';
  limitSd: number;            // limit = signal close ∓ limitSd × SD (better price)
  limitTtl: number;
  maxPerSymbol: number;
  /** Optional exit preset (overrides the individual exit fields) so a grid can compare coherent exit packages. */
  exitSet?: 'none' | 'meanTight' | 'r2be' | 'nostop15' | 'none60';
  /** Optional entry preset: market, or a limit 0.25 SD better than the signal close with a 3- or 10-minute TTL. */
  entryMode?: 'none' | 'market' | 'limit3' | 'limit10';
}

const EXIT_SETS: Record<string, Partial<P>> = {
  // stop 0.5 SD beyond the extreme (≥ 0.2%), target = rolling mean, 15-minute time limit
  meanTight: { stopMode: 'extreme', stopSd: 0.5, minStopPct: 0.2, noStop: false, target: 'mean', breakevenAtR: 0, trailR: 0, holdMinutes: 15 },
  // stop 1 SD beyond the extreme (≥ 0.15%), fixed 2R target, breakeven at 1R, 30 minutes
  r2be: { stopMode: 'extreme', stopSd: 1, minStopPct: 0.15, noStop: false, target: 'r', targetR: 2, breakevenAtR: 1, trailR: 0, holdMinutes: 30 },
  // no stop (sized from a 0.2%-min extreme stop), target = rolling mean, 15-minute time exit
  nostop15: { stopMode: 'extreme', stopSd: 0.5, minStopPct: 0.2, noStop: true, target: 'mean', breakevenAtR: 0, trailR: 0, holdMinutes: 15 },
  // stop 0.5 SD beyond the extreme, no target, 60-minute time exit
  none60: { stopMode: 'extreme', stopSd: 0.5, minStopPct: 0.2, noStop: false, target: 'none', breakevenAtR: 0, trailR: 0, holdMinutes: 60 },
};
const ENTRY_MODES: Record<string, Partial<P>> = {
  market: { entry: 'market' },
  limit3: { entry: 'limit', limitSd: 0.25, limitTtl: 3 },
  limit10: { entry: 'limit', limitSd: 0.25, limitTtl: 10 },
};

interface S {
  seen: number;
  curStart: number; curH: number; curL: number; curC: number;
  closes: number[]; highs: number[]; lows: number[]; ends: number[];
  z: number[]; mid: number[]; sd: number[];
  entries: number;
  lastExitBucket: number;
  atr: number; dayOpen: number; skip: boolean;
}

const OPEN = 9 * 60 + 30;
// Same-index duplicates in the 'liquid' list (VOO/IVV ≈ SPY, GOOG ≈ GOOGL): keep one of each.
const DUPES = new Set(['VOO', 'IVV', 'SPLG', 'GOOG']);

function finalize(s: S, p: P) {
  if (s.curStart < 0) return;
  s.closes.push(s.curC); s.highs.push(s.curH); s.lows.push(s.curL); s.ends.push(s.curStart + p.barMinutes);
  s.curStart = -1;
  const n = s.closes.length;
  if (n >= p.len) {
    let sum = 0;
    for (let i = n - p.len; i < n; i++) sum += s.closes[i];
    const m = sum / p.len;
    let v = 0;
    for (let i = n - p.len; i < n; i++) v += (s.closes[i] - m) ** 2;
    const sd = Math.sqrt(v / (p.len - 1));
    s.mid.push(m); s.sd.push(sd); s.z.push(sd > 0 ? (s.curC - m) / sd : 0);
  } else { s.mid.push(NaN); s.sd.push(NaN); s.z.push(NaN); }
}

function dailyStats(daily: Bar[]): { atr: number; trend: number } {
  if (daily.length < 21) return { atr: NaN, trend: NaN };
  const last = daily.slice(-15);
  let tr = 0;
  for (let i = 1; i < last.length; i++) {
    const b = last[i], pc = last[i - 1].c;
    tr += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  const atr = tr / (last.length - 1);
  const sma = daily.slice(-20).reduce((a, b) => a + b.c, 0) / 20;
  return { atr, trend: Math.abs(daily[daily.length - 1].c - sma) / atr };
}

const strategy: Strategy<P> = {
  name: 'r2_zscore',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (p.tags === 'index') return m.tags.includes('index');
        if (p.tags === 'liquid') return m.tags.includes('liquid') || m.tags.includes('index');
        if (p.tags === 'gap') return m.tags.includes('gap');
        return true;
      })
      .filter((m) => !DUPES.has(m.symbol) && m.open >= 5)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p0: P): Signal[] {
    const p: P = { ...p0, ...(p0.exitSet ? EXIT_SETS[p0.exitSet] : {}), ...(p0.entryMode ? ENTRY_MODES[p0.entryMode] : {}) };
    const out: Signal[] = [];
    const boundary = (ctx.minute - OPEN) % p.barMinutes === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const ds = dailyStats(ctx.dailyBefore(sym));
        s = {
          seen: 0, curStart: -1, curH: 0, curL: 0, curC: 0, closes: [], highs: [], lows: [], ends: [], z: [], mid: [], sd: [],
          entries: 0, lastExitBucket: -1, atr: ds.atr, dayOpen: bars[0].o,
          skip: !(ds.atr > 0) || (p.trendMax > 0 && ds.trend > p.trendMax),
        };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const start = OPEN + Math.floor((bm - OPEN) / p.barMinutes) * p.barMinutes;
        if (s.curStart >= 0 && start !== s.curStart) finalize(s, p);
        if (s.curStart < 0) { s.curStart = start; s.curH = b.h; s.curL = b.l; }
        s.curH = Math.max(s.curH, b.h); s.curL = Math.min(s.curL, b.l); s.curC = b.c;
      }
      if (s.curStart >= 0 && ctx.minute >= s.curStart + p.barMinutes) finalize(s, p);
      if (s.skip || !boundary || ctx.minute < p.startMinute || ctx.minute > p.cutoffMinute) continue;
      const n = s.closes.length;
      if (n < 2 || s.ends[n - 1] !== ctx.minute) continue;
      if (ctx.open.has(sym) || s.entries >= p.maxPerSymbol) continue;
      const zPrev = s.z[n - 2], zNow = s.z[n - 1], mid = s.mid[n - 1], sd = s.sd[n - 1];
      if (!Number.isFinite(zPrev) || !Number.isFinite(zNow) || !(sd > 0)) continue;
      const c = s.closes[n - 1];
      let side: 'long' | 'short' | undefined;
      let ext = NaN;
      if (p.confirm === 'fail') {
        // Extreme bucket n−1, then bucket n makes no new extreme and closes back toward the mean.
        if (zPrev >= p.zIn && s.highs[n - 1] <= s.highs[n - 2] && c < s.closes[n - 2] && c > mid) { side = 'short'; ext = s.highs[n - 2]; }
        else if (zPrev <= -p.zIn && s.lows[n - 1] >= s.lows[n - 2] && c > s.closes[n - 2] && c < mid) { side = 'long'; ext = s.lows[n - 2]; }
      } else {
        if (zNow >= p.zIn && zPrev < p.zIn) { side = 'short'; ext = s.highs[n - 1]; }
        else if (zNow <= -p.zIn && zPrev > -p.zIn) { side = 'long'; ext = s.lows[n - 1]; }
      }
      if (!side) continue;
      if (p.direction !== 'both' && p.direction !== side) continue;
      if (p.dayMoveMax > 0 && Math.abs(c - s.dayOpen) > p.dayMoveMax * s.atr) continue;
      const long = side === 'long';
      const ref = p.entry === 'limit' ? (long ? c - p.limitSd * sd : c + p.limitSd * sd) : c;
      let dist = p.stopMode === 'extreme' ? (long ? ref - (ext - p.stopSd * sd) : ext + p.stopSd * sd - ref) : p.stopSd * sd;
      dist = Math.max(dist, (p.minStopPct / 100) * ref);
      if (!(dist > 0)) continue;
      const stop = long ? ref - dist : ref + dist;
      let targetR: number | undefined;
      if (p.target === 'r') targetR = p.targetR;
      else if (p.target === 'mean' || p.target === 'zout') {
        const tp = p.target === 'mean' ? mid : long ? mid - p.zOut * sd : mid + p.zOut * sd;
        const tr = (long ? tp - ref : ref - tp) / dist;
        if (!(tr >= p.minTargetR)) continue;
        targetR = Math.round(tr * 100) / 100;
      }
      s.entries++;
      out.push({
        symbol: sym, side, stop: Math.round(stop * 100) / 100, targetR,
        breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit: p.entry === 'limit' ? Math.round(ref * 100) / 100 : undefined,
        limitTtl: p.entry === 'limit' ? p.limitTtl : undefined,
        tag: side,
      });
    }
    return out;
  },
};

export default {
  strategy,
  // wf run 1 (192): core idea, designed on M1–M2 only — bar size, window, threshold, confirmation, universe, target, hold.
  // wf run 1 (192) result: WF -36.2R, FAIL. Grid: barMinutes [1,5], len [20,40], zIn [2,2.5,3], confirm [none,fail],
  //   tags [liquid,gap], target [mean,none], holdMinutes [15,60], stop 0.5 SD beyond extreme (min 0.2%), market, $100.
  // wf run 2 (384): area chosen from M1–M2 exploration BEFORE wf1 results (1-min, len 20, confirm none, liquid):
  //   exit packages × entry (market / limit 3 / limit 10) × risk tiers × maxTrades × maxLosses.
  // wf run 2 (384) result: WF -47.2R, FAIL; full-period top 20 all nostop15 (≤ +41R, random-control level).
  // wf run 3 (128): filters requested by the idea (daily trend filter, intraday-move filter, afternoon-only window,
  //   long-only, index-only), each also explored on M1–M2 only. Risk $500, maxTrades 3 and nostop15/meanTight were also
  //   the best on M1–M2 exploration, but they coincide with the wf2 full-period ranking, so this run is partly shaped by
  //   wf2. Daily loss limit and maxConcurrent switched off (did not bind on M1–M2).
  grid: {
    barMinutes: [1], len: [20], zIn: [2.5, 3], confirm: ['none'], tags: ['liquid', 'index'],
    startMinute: [10 * 60, 13 * 60], cutoffMinute: [15 * 60 + 30], trendMax: [0, 1.5], dayMoveMax: [0, 1], direction: ['both', 'long'],
    stopMode: ['extreme'], stopSd: [0.5], minStopPct: [0.2], noStop: [false],
    target: ['mean'], zOut: [0.5], targetR: [2], minTargetR: [0.5], breakevenAtR: [0], trailR: [0], holdMinutes: [15],
    entry: ['market'], limitSd: [0.25], limitTtl: [5], maxPerSymbol: [3],
    exitSet: ['meanTight', 'nostop15'], entryMode: ['market'],
    'rule.riskPerTrade': [500], 'rule.maxTrades': [3], 'rule.dailyLossLimit': [0], 'rule.maxConcurrent': [0],
  },
};
