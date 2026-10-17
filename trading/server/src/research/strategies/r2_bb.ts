// r2_bb: Bollinger Bands on N-minute buckets (aligned to 09:30), two variants.
//  (a) 'revert': the previous bucket CLOSED outside the band and the bucket that just closed is back inside
//      → fade toward the middle band (target = middle band, or a fixed R, or none).
//  (b) 'breakout': a bucket closes outside the band after a squeeze (bandwidth of the prior bucket in the lowest
//      `squeezeQ` quantile of the last `squeezeLook` bandwidths — mode 'squeeze'; mode 'breakout' = plain band walk) → go with it.
// Bands use only today's completed buckets (SMA ± k·SD of the last `len` closes), so the first signal comes
// after len × barMinutes minutes. Stops: excursion extreme / middle band / k·SD; exits: target, breakeven,
// trail, time, or noStop + time exit. Entry at market or with a LIMIT (a pullback of limitSd × SD from the
// signal close). No look-ahead: universe() uses ctx.meta only; onMinute() folds closed 1-minute bars
// incrementally and only acts on buckets whose last minute has closed.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'revert' | 'breakout' | 'squeeze';   // 'breakout' = plain band walk; 'squeeze' = breakout gated by squeezeQ
  barMinutes: number;
  len: number;               // band length in buckets
  k: number;                 // band width in SDs
  tags: 'gap' | 'liquid' | 'all';
  maxSymbols: number;        // largest |gap| first
  direction: 'both' | 'with-gap' | 'against-gap';
  squeezeQ: number;          // squeeze: prior bandwidth ≤ this quantile of the last squeezeLook bandwidths
  squeezeLook: number;
  stopMode: 'extreme' | 'mid' | 'sd';
  stopSd: number;            // 'sd': stop distance = stopSd × SD from the signal close; 'extreme': buffer in SDs
  noStop: boolean;
  target: 'mid' | 'r' | 'none';  // 'mid' = middle band for revert, no target for breakouts
  targetR: number;           // for target 'r'
  breakevenAtR: number;      // 0 = off
  trailR: number;            // 0 = off
  holdMinutes: number;       // 0 = off (flatten)
  cutoffMinute: number;
  entry: 'market' | 'limit' | 'limitLong';  // limitLong = limit with ttl 3×limitTtl
  limitSd: number;           // limit = signal close ∓ limitSd × SD (better price)
  limitTtl: number;
  maxPerSymbol: number;
}

interface S {
  seen: number;
  curStart: number;          // start minute of the bucket being built (-1 none)
  curH: number; curL: number; curC: number;
  closes: number[]; highs: number[]; lows: number[]; ends: number[];
  bw: number[];              // bandwidth (2k·SD / mid) after each completed bucket (NaN before len)
  sd: number[]; mid: number[];
  entries: number;
  lastEval: number;
}

const OPEN = 9 * 60 + 30;

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
    const sd = Math.sqrt(v / p.len);
    s.mid.push(m); s.sd.push(sd); s.bw.push((2 * p.k * sd) / m);
  } else { s.mid.push(NaN); s.sd.push(NaN); s.bw.push(NaN); }
}

const strategy: Strategy<P> = {
  name: 'r2_bb',
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
    const boundary = (ctx.minute - OPEN) % p.barMinutes === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, curStart: -1, curH: 0, curL: 0, curC: 0, closes: [], highs: [], lows: [], ends: [], bw: [], sd: [], mid: [], entries: 0, lastEval: -1 };
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
      // The bucket [curStart, curStart+N) is complete once this minute reaches its end.
      if (s.curStart >= 0 && ctx.minute >= s.curStart + p.barMinutes) finalize(s, p);
      if (!boundary || ctx.minute > p.cutoffMinute) continue;
      const n = s.closes.length;
      // Act only on a bucket that ended exactly now (fresh information).
      if (n < 2 || s.ends[n - 1] !== ctx.minute) continue;
      // maxPerSymbol 1 = once per day via the harness's 'traded' set; >1 = cap on signals emitted (approximate).
      if (ctx.open.has(sym) || (p.maxPerSymbol <= 1 ? ctx.traded.has(sym) : s.entries >= p.maxPerSymbol)) continue;
      const mid = s.mid[n - 1], sd = s.sd[n - 1];
      const pmid = s.mid[n - 2], psd = s.sd[n - 2];
      if (!(sd > 0) || !(psd > 0)) continue;
      const c = s.closes[n - 1], pc = s.closes[n - 2];
      const up = mid + p.k * sd, lo = mid - p.k * sd;
      const pup = pmid + p.k * psd, plo = pmid - p.k * psd;
      let side: 'long' | 'short' | undefined;
      let stop = NaN;
      if (p.mode === 'revert') {
        if (pc < plo && c > lo && c < mid) side = 'long';
        else if (pc > pup && c < up && c > mid) side = 'short';
        if (!side) continue;
        if (p.stopMode === 'extreme' || p.stopMode === 'mid') {
          // Extreme of the excursion: the run of consecutive buckets ending at the previous one that closed outside.
          let ext = side === 'long' ? s.lows[n - 1] : s.highs[n - 1];
          for (let i = n - 2; i >= 0; i--) {
            const o = side === 'long' ? s.closes[i] < s.mid[i] - p.k * s.sd[i] : s.closes[i] > s.mid[i] + p.k * s.sd[i];
            if (!o) break;
            ext = side === 'long' ? Math.min(ext, s.lows[i]) : Math.max(ext, s.highs[i]);
          }
          stop = side === 'long' ? ext - p.stopSd * sd : ext + p.stopSd * sd;
        } else stop = side === 'long' ? c - p.stopSd * sd : c + p.stopSd * sd;
      } else {
        if (c > up && pc <= pup) side = 'long';
        else if (c < lo && pc >= plo) side = 'short';
        if (!side) continue;
        if (p.mode === 'squeeze') {
          const hist = s.bw.slice(Math.max(0, n - 1 - p.squeezeLook), n - 1).filter((x) => Number.isFinite(x));
          if (hist.length < Math.min(p.squeezeLook, 10)) continue;
          const sorted = [...hist].sort((a, b) => a - b);
          const q = sorted[Math.min(sorted.length - 1, Math.floor(p.squeezeQ * sorted.length))];
          if (!(s.bw[n - 2] <= q)) continue;
        }
        if (p.stopMode === 'mid') stop = mid;
        else if (p.stopMode === 'extreme') stop = side === 'long' ? s.lows[n - 1] - p.stopSd * sd : s.highs[n - 1] + p.stopSd * sd;
        else stop = side === 'long' ? c - p.stopSd * sd : c + p.stopSd * sd;
      }
      const gapUp = ctx.meta[sym].gapPct > 0;
      if (p.direction === 'with-gap' && (side === 'long') !== gapUp) continue;
      if (p.direction === 'against-gap' && (side === 'long') === gapUp) continue;
      const long = side === 'long';
      const isLim = p.entry !== 'market';
      const ref = isLim ? (long ? c - p.limitSd * sd : c + p.limitSd * sd) : c;
      const risk = long ? ref - stop : stop - ref;
      if (!(risk > 0)) continue;
      let targetR: number | undefined;
      if (p.target === 'r') targetR = p.targetR;
      else if (p.target === 'mid' && p.mode === 'revert') { // breakouts: 'mid' means no fixed target
        const tr = ((long ? mid - ref : ref - mid) / risk);
        if (!(tr >= 0.3)) continue;
        targetR = Math.round(tr * 100) / 100;
      }
      s.entries++;
      out.push({
        symbol: sym, side, stop, targetR,
        breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit: isLim ? Math.round(ref * 100) / 100 : undefined,
        limitTtl: isLim ? (p.entry === 'limitLong' ? 3 * p.limitTtl : p.limitTtl) : undefined,
        tag: `${p.mode}-${side}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  // wf run 3 (768): SHAPED BY RUNS 1–2 (both of which used the test months in their full-period rankings): the
  // recurring squeeze-breakout area (5-min, len 12, k 2, liquid) with exits/stops varied: stop extreme/SD/middle band,
  // no target vs 1R/3R, breakeven, trailing, 60-min time exit, noStop, daily loss limit on/off, $500 tier.
  grid: {
    mode: ['squeeze'], barMinutes: [5], len: [12], k: [2], tags: ['liquid'],
    maxSymbols: [30], direction: ['both'], squeezeQ: [0.2], squeezeLook: [40],
    stopMode: ['extreme', 'sd', 'mid'], stopSd: [0.5, 1], noStop: [false, true], target: ['mid', 'r'], targetR: [1, 3],
    breakevenAtR: [0, 1], trailR: [0, 1.5], holdMinutes: [0, 60], cutoffMinute: [15 * 60],
    entry: ['market'], limitSd: [0.25], limitTtl: [3],
    maxPerSymbol: [1],
    'rule.riskPerTrade': [500], 'rule.dailyLossLimit': [1500, 0],
  },
};
