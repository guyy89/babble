// r2_keltner: Keltner channel on N-minute buckets (aligned to 09:30): EMA(emaLen) of bucket closes ± k × ATR(atrLen)
// of bucket true ranges, both built from today's completed buckets only. Two families:
//  (a) 'breakout': a bucket closes outside the channel (previous close inside) right after a squeeze — the prior
//      bucket's ATR is ≤ squeezeRatio × its own average over the last squeezeLook buckets — trade with the break.
//      Optional trend filter: EMA slope in the trade direction, or close on the right side of VWAP.
//  (b) 'revert': in a non-trending context (|EMA change over slopeLook buckets| ≤ flatMax × ATR) a bucket closes
//      outside the channel ('close': fade immediately; 'reenter': previous bucket closed outside and this one closed
//      back inside) → fade toward the EMA.
// Stops: 'atr' (stopAtr × ATR from the reference price), 'extreme' (signal-bucket/excursion extreme ± stopAtr × ATR),
// 'ema' (breakout only: the EMA). Targets: 'ema' (revert: the EMA), 'band' (revert: the opposite band),
// 'r' (targetR), 'none'. Exits also: breakeven, trailing, time (holdMinutes), noStop + time exit.
// Entry at market, or LIMIT at the signal close ∓ limitAtr × ATR (a better price) with limitTtl minutes.
// No look-ahead: universe() uses ctx.meta only; onMinute() folds closed 1-minute bars incrementally and acts only
// on a bucket whose last minute has just closed.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'breakout' | 'revert';
  barMinutes: number;
  emaLen: number;
  atrLen: number;
  warmup: number;            // completed buckets required before the first signal
  k: number;
  tags: 'gap' | 'liquid' | 'all';
  maxSymbols: number;
  direction: 'both' | 'with-gap' | 'against-gap' | 'long' | 'short';
  squeezeRatio: number;      // breakout: prior ATR ≤ ratio × mean ATR of the last squeezeLook buckets (≥ 9 = off)
  squeezeLook: number;
  trend: 'none' | 'ema' | 'vwap';   // breakout trend filter
  revTrigger: 'close' | 'reenter';
  flatMax: number;           // revert: |EMA[n]-EMA[n-slopeLook]| / ATR ≤ flatMax (≥ 9 = off)
  slopeLook: number;
  stopMode: 'atr' | 'extreme' | 'ema';
  stopAtr: number;
  noStop: boolean;
  target: 'ema' | 'band' | 'r' | 'none';
  targetR: number;
  breakevenAtR: number;      // 0 = off
  trailR: number;            // 0 = off
  holdMinutes: number;       // 0 = off
  cutoffMinute: number;
  entry: 'market' | 'limit';
  limitAtr: number;
  limitTtl: number;
}

interface S {
  seen: number;
  curStart: number;
  curH: number; curL: number; curC: number;
  pv: number; vol: number;
  closes: number[]; highs: number[]; lows: number[]; ends: number[];
  ema: number[]; atr: number[]; tr: number[]; vwap: number[];
}

const OPEN = 9 * 60 + 30;

function finalize(s: S, p: P) {
  if (s.curStart < 0) return;
  const n0 = s.closes.length;
  const prevC = n0 ? s.closes[n0 - 1] : NaN;
  s.closes.push(s.curC); s.highs.push(s.curH); s.lows.push(s.curL); s.ends.push(s.curStart + p.barMinutes);
  s.vwap.push(s.vol > 0 ? s.pv / s.vol : s.curC);
  s.curStart = -1;
  const tr = Number.isFinite(prevC) ? Math.max(s.curH - s.curL, Math.abs(s.curH - prevC), Math.abs(s.curL - prevC)) : s.curH - s.curL;
  s.tr.push(tr);
  const a = 2 / (p.emaLen + 1);
  s.ema.push(n0 === 0 ? s.curC : s.ema[n0 - 1] + a * (s.curC - s.ema[n0 - 1]));
  // ATR: simple mean while fewer than atrLen buckets, then Wilder smoothing.
  const n = s.tr.length;
  if (n <= p.atrLen) s.atr.push(s.tr.reduce((x, y) => x + y, 0) / n);
  else s.atr.push(s.atr[n - 2] + (tr - s.atr[n - 2]) / p.atrLen);
}

const strategy: Strategy<P> = {
  name: 'r2_keltner',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => m.open >= 5)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, curStart: -1, curH: 0, curL: 0, curC: 0, pv: 0, vol: 0, closes: [], highs: [], lows: [], ends: [], ema: [], atr: [], tr: [], vwap: [] };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const start = OPEN + Math.floor((bm - OPEN) / p.barMinutes) * p.barMinutes;
        if (s.curStart >= 0 && start !== s.curStart) finalize(s, p);
        if (s.curStart < 0) { s.curStart = start; s.curH = b.h; s.curL = b.l; }
        s.curH = Math.max(s.curH, b.h); s.curL = Math.min(s.curL, b.l); s.curC = b.c;
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
      }
      if (s.curStart >= 0 && ctx.minute >= s.curStart + p.barMinutes) finalize(s, p);
      if (ctx.minute > p.cutoffMinute) continue;
      const n = s.closes.length;
      if (n < Math.max(2, p.warmup) || s.ends[n - 1] !== ctx.minute) continue;
      if (ctx.open.has(sym) || ctx.traded.has(sym)) continue;
      const ema = s.ema[n - 1], atr = s.atr[n - 1];
      const pema = s.ema[n - 2], patr = s.atr[n - 2];
      if (!(atr > 0) || !(patr > 0)) continue;
      const c = s.closes[n - 1], pc = s.closes[n - 2];
      const up = ema + p.k * atr, lo = ema - p.k * atr;
      const pup = pema + p.k * patr, plo = pema - p.k * patr;
      let side: 'long' | 'short' | undefined;
      let stop = NaN;
      let tgtPx = NaN;
      if (p.mode === 'breakout') {
        if (c > up && pc <= pup) side = 'long';
        else if (c < lo && pc >= plo) side = 'short';
        if (!side) continue;
        if (p.squeezeRatio < 9) {
          const from = Math.max(0, n - 1 - p.squeezeLook);
          const hist = s.atr.slice(from, n - 1);
          if (hist.length < Math.min(p.squeezeLook, 6)) continue;
          const mean = hist.reduce((x, y) => x + y, 0) / hist.length;
          if (!(patr <= p.squeezeRatio * mean)) continue;
        }
        if (p.trend === 'ema') {
          const back = s.ema[Math.max(0, n - 1 - p.slopeLook)];
          if (side === 'long' ? !(ema > back) : !(ema < back)) continue;
        } else if (p.trend === 'vwap') {
          const vw = s.vwap[n - 1];
          if (side === 'long' ? !(c > vw) : !(c < vw)) continue;
        }
        if (p.stopMode === 'ema') stop = ema;
        else if (p.stopMode === 'extreme') stop = side === 'long' ? s.lows[n - 1] - p.stopAtr * atr : s.highs[n - 1] + p.stopAtr * atr;
      } else {
        if (p.revTrigger === 'close') {
          if (c < lo && pc >= plo) side = 'long';
          else if (c > up && pc <= pup) side = 'short';
        } else {
          if (pc < plo && c >= lo && c < ema) side = 'long';
          else if (pc > pup && c <= up && c > ema) side = 'short';
        }
        if (!side) continue;
        if (p.flatMax < 9) {
          const back = s.ema[Math.max(0, n - 1 - p.slopeLook)];
          if (!(Math.abs(ema - back) / atr <= p.flatMax)) continue;
        }
        if (p.stopMode === 'extreme') {
          // Extreme of the excursion: the signal bucket plus the run of preceding buckets that closed outside.
          let ext = side === 'long' ? s.lows[n - 1] : s.highs[n - 1];
          for (let i = n - 2; i >= 0; i--) {
            const o = side === 'long' ? s.closes[i] < s.ema[i] - p.k * s.atr[i] : s.closes[i] > s.ema[i] + p.k * s.atr[i];
            if (!o) break;
            ext = side === 'long' ? Math.min(ext, s.lows[i]) : Math.max(ext, s.highs[i]);
          }
          stop = side === 'long' ? ext - p.stopAtr * atr : ext + p.stopAtr * atr;
        } else if (p.stopMode === 'ema') continue; // not meaningful for a fade
        if (p.target === 'ema') tgtPx = ema;
        else if (p.target === 'band') tgtPx = side === 'long' ? up : lo;
      }
      const gapUp = ctx.meta[sym].gapPct > 0;
      if (p.direction === 'with-gap' && (side === 'long') !== gapUp) continue;
      if (p.direction === 'against-gap' && (side === 'long') === gapUp) continue;
      if (p.direction === 'long' && side !== 'long') continue;
      if (p.direction === 'short' && side !== 'short') continue;
      const long = side === 'long';
      const isLim = p.entry === 'limit';
      const ref = isLim ? (long ? c - p.limitAtr * atr : c + p.limitAtr * atr) : c;
      if (p.stopMode === 'atr') stop = long ? ref - p.stopAtr * atr : ref + p.stopAtr * atr;
      const risk = long ? ref - stop : stop - ref;
      if (!(risk > 0)) continue;
      let targetR: number | undefined;
      if (p.target === 'r') targetR = p.targetR;
      else if (Number.isFinite(tgtPx)) {
        const tr = (long ? tgtPx - ref : ref - tgtPx) / risk;
        if (!(tr >= 0.3)) continue;
        targetR = Math.round(tr * 100) / 100;
      }
      out.push({
        symbol: sym, side, stop, targetR,
        breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit: isLim ? Math.round(ref * 100) / 100 : undefined,
        limitTtl: isLim ? p.limitTtl : undefined,
        tag: `${p.mode}-${side}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  // wf run 1 (288): designed on M1–M2 only. Both families on 'liquid' names (gap names were clearly worse on M1–M2):
  // revert vs squeeze-breakout × 5/15-min × k 1.5/2 × reenter/close trigger × ATR stop 0.35/0.5/1 × target none/EMA/2R
  // × market vs limit (0.15 ATR better, 10 min); default $50 tier and default limits. Result: WF −20.6R, FAIL.
  // wf run 2 (512): revert family only (breakout was negative on average in every M1–M2 slice), mandatory dimensions:
  // risk tiers, maxConcurrent 2 vs off, market vs limit, stop 0.35/0.75 ATR vs noStop (hold to close), target none/EMA.
  // Shaped by M1–M2 exploration only; wf run 1 showed the M1–M2 favourite decaying, which this run does not tune toward.
  // Result wf 2: WF +22.5R, t 0.34, FAIL (every pick was noStop/hold-to-close; worst trade −$3,251 at $500).
  // wf run 3 (384): SHAPED BY WF 1–2 in one respect: noStop is excluded because WF 2 picked only noStop variants, whose R
  // is inflated by sizing off a tight 0.35-ATR stop (see the random-baseline calibration). Everything else is from M1–M2:
  // stopped revert trades, 5/15-min, stop 0.35/0.5 ATR, target none/EMA/3R, breakeven 1R on/off, market vs limit,
  // $100 tier with daily loss limit $300 vs off, maxTrades 3 vs off, maxConcurrent 2 vs off.
  // Result wf 3: WF −56.5R, all four test months negative, FAIL. Verdict: no edge (see report).
  grid: {
    mode: ['revert'], barMinutes: [5, 15], emaLen: [20], atrLen: [14], warmup: [12], k: [1.5],
    tags: ['liquid'], maxSymbols: [60], direction: ['both'],
    squeezeRatio: [0.9], squeezeLook: [20], trend: ['none'],
    revTrigger: ['reenter'], flatMax: [99], slopeLook: [5],
    stopMode: ['atr'], stopAtr: [0.35, 0.5], noStop: [false],
    target: ['none', 'ema', 'r'], targetR: [3], breakevenAtR: [0, 1], trailR: [0], holdMinutes: [0],
    cutoffMinute: [15 * 60], entry: ['market', 'limit'], limitAtr: [0.15], limitTtl: [10],
    'rule.riskPerTrade': [100], 'rule.dailyLossLimit': [300, 0], 'rule.maxTrades': [3, 0], 'rule.maxConcurrent': [2, 0],
  },
};
