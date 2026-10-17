// r2_squeeze — volatility contraction → expansion.
// Bars are aggregated into `barMin`-minute buckets. When a bucket completes, the "box" is checked for a squeeze:
//   mode 'atr'  : box = last N buckets (N = boxMin / barMin); range ≤ k × 14-day daily ATR
//                 (tight 1/2/3 → k = 0.15 / 0.10 / 0.07)
//   mode 'intra': same box; range ≤ k × mean of all earlier N-bucket box ranges today (≥ 6 earlier boxes)
//                 (tight 1/2/3 → k = 0.6 / 0.5 / 0.4)  — "unusually tight versus the stock's own intraday vol"
//   mode 'nr'   : box = the last bucket alone; it must be the narrowest of the last N buckets (NR-N);
//                 tight 2 also requires an inside bar; tight 3 additionally range ≤ 0.5 × mean bucket range today
// A squeeze arms the box for `armMin` minutes. The first 1-minute close beyond the box (± buf × ATR) is the breakout;
// optional trend filter (VWAP side / side of the day's open). Entry at market (next bar open) or a LIMIT
// <pct>% of the box range better than the signal close (entry 'lim<pct>_<ttl>'), cancelled after <ttl> minutes.
// Stop: opposite box edge ('box'), box middle ('mid'), or close ∓ stopAtr × ATR ('atr'); never closer than minStopPct.
// Exits: preset strings (target / breakeven / trail / time / hold to flatten), or noStop + time exit.
// Only closed bars are used (ctx.bars), state is folded incrementally; universe uses only meta + dailyBefore.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'atr' | 'intra' | 'nr';
  tight: number;          // 1..3, see above
  barMin: number;         // bucket length in minutes
  boxMin: number;         // box / lookback length in minutes (N = boxMin / barMin buckets)
  armMin: number;         // minutes a squeeze box stays armed
  buf: number;            // breakout buffer in daily ATR
  uni: 'gap' | 'liquid' | 'all';
  filter: 'none' | 'vwap' | 'open';
  side: 'both' | 'long' | 'short';
  startMin: number;       // minutes after 09:30 before a squeeze can be detected
  endMin: number;         // minutes after 09:30 after which no new signals
  entry: string;          // 'market' or 'lim<pct>_<ttl>': LIMIT <pct>% of the box range better than the signal close, TTL minutes
  stop: 'box' | 'mid' | 'atr';
  stopAtr: number;
  minStopPct: number;     // floor of the stop distance, % of price
  exit: 'tgt1' | 'tgt2' | 'tgt3' | 'tgt2be1' | 'trail1' | 'trail05' | 'time30' | 'time60' | 'flat' | 'nostop30' | 'nostop60' | 'nostop120' | 'nostopflat';
}

interface Bucket { h: number; l: number }
interface Box { hi: number; lo: number; until: number; score: number }
interface S {
  seen: number;
  pv: number; vol: number;
  first?: number;
  atr: number;
  curIdx: number; cur?: Bucket;
  buckets: Bucket[];
  sumBox: number; nBox: number;     // intra: stats of earlier box ranges
  sumBar: number; nBar: number;     // nr tight 3: stats of bucket ranges
  box?: Box;
  last?: Bar; lastMin: number;
  newSince: boolean;                // a 1m bar closed after the box was armed
}

const OPEN = 9 * 60 + 30;
const ATR_K = [0, 0.15, 0.1, 0.07];
const INTRA_K = [0, 0.6, 0.5, 0.4];

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

// Pure function of daily bars strictly before the date: cached per symbol/date (speed only, no look-ahead).
const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const k = sym + '|' + ctx.date;
  let v = atrCache.get(k);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(k, v); }
  return v;
}

/** A bucket has completed: update stats and maybe arm a squeeze box (armed from minute `nowMin`). */
function closeBucket(s: S, p: P, b: Bucket, endMin: number) {
  const B = s.buckets;
  B.push(b);
  const n = Math.max(2, Math.round(p.boxMin / p.barMin));
  const range = b.h - b.l;
  const rel = endMin - OPEN;
  const L = B.length;
  let arm: Box | undefined;
  if (p.mode === 'nr') {
    if (L >= n) {
      let narrowest = true;
      for (let i = L - n; i < L - 1; i++) if (!(range < B[i].h - B[i].l)) { narrowest = false; break; }
      const pb = B[L - 2];
      const inside = b.h <= pb.h && b.l >= pb.l;
      const meanBar = s.nBar > 0 ? s.sumBar / s.nBar : NaN;
      let ok = narrowest && range > 0;
      if (p.tight >= 2) ok = ok && inside;
      if (p.tight >= 3) ok = ok && s.nBar >= 6 && range <= 0.5 * meanBar;
      if (ok) arm = { hi: b.h, lo: b.l, until: endMin + p.armMin, score: range / s.atr };
    }
    s.sumBar += range; s.nBar++;
  } else if (L >= n) {
    let hi = -Infinity, lo = Infinity;
    for (let i = L - n; i < L; i++) { if (B[i].h > hi) hi = B[i].h; if (B[i].l < lo) lo = B[i].l; }
    const br = hi - lo;
    let ok = false, score = Infinity;
    if (p.mode === 'atr') { score = br / s.atr; ok = score <= ATR_K[p.tight]; }
    else if (s.nBox >= 6) { score = br / (s.sumBox / s.nBox); ok = score <= INTRA_K[p.tight]; }
    s.sumBox += br; s.nBox++;
    if (ok && br > 0) arm = { hi, lo, until: endMin + p.armMin, score };
  }
  if (arm && rel >= p.startMin && rel < p.endMin) { s.box = arm; s.newSince = false; }
}

function fold(ctx: MinuteContext, sym: string, p: P): S | undefined {
  const bars = ctx.bars(sym);
  if (!bars.length) return undefined;
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, pv: 0, vol: 0, atr: atrFor(ctx, sym), curIdx: -1, buckets: [], sumBox: 0, nBox: 0, sumBar: 0, nBar: 0, lastMin: -1, newSince: false };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const b = bars[s.seen];
    const bm = ctx.minuteOf(b.t);
    if (s.first === undefined) s.first = b.o;
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    const idx = Math.floor((bm - OPEN) / p.barMin);
    if (s.cur && idx !== s.curIdx) { closeBucket(s, p, s.cur, OPEN + (s.curIdx + 1) * p.barMin); s.cur = undefined; }
    if (!s.cur) { s.cur = { h: b.h, l: b.l }; s.curIdx = idx; }
    else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); }
    // This 1m bar is evaluated against a box armed BEFORE it (box from earlier buckets).
    s.newSince = s.box !== undefined;
    s.last = b; s.lastMin = bm;
    // Bucket completes with its last minute.
    if ((bm - OPEN) % p.barMin === p.barMin - 1) { closeBucket(s, p, s.cur, bm + 1); s.cur = undefined; }
  }
  return s;
}

function mgmt(p: P, minute: number): Partial<Signal> {
  switch (p.exit) {
    case 'tgt1': return { targetR: 1 };
    case 'tgt2': return { targetR: 2 };
    case 'tgt3': return { targetR: 3 };
    case 'tgt2be1': return { targetR: 2, breakevenAtR: 1 };
    case 'trail1': return { trailR: 1 };
    case 'trail05': return { trailR: 0.5, breakevenAtR: 0.5 };
    case 'time30': return { exitMinute: minute + 30 };
    case 'time60': return { exitMinute: minute + 60 };
    case 'flat': return {};
    case 'nostop60': return { noStop: true, exitMinute: minute + 60 };
    case 'nostop30': return { noStop: true, exitMinute: minute + 30 };
    case 'nostop120': return { noStop: true, exitMinute: minute + 120 };
    case 'nostopflat': return { noStop: true };
  }
}

const strategy: Strategy<P> = {
  name: 'r2_squeeze',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => !m.tags.includes('index') && (p.uni === 'all' || m.tags.includes(p.uni)) && m.open >= 5)
      .filter((m) => atrFor(ctx, m.symbol) > 0)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    for (const sym of Object.keys(ctx.meta)) {
      const s = fold(ctx, sym, p);
      if (!s || !s.last || !(s.atr > 0)) continue;
      const box = s.box;
      if (!box) continue;
      if (ctx.minute > box.until) { s.box = undefined; continue; }
      // Evaluate only a fresh 1m bar that closed after the box was armed.
      if (!s.newSince || s.lastMin !== ctx.minute - 1) continue;
      s.newSince = false;
      const c = s.last.c;
      const buf = p.buf * s.atr;
      let side: 'long' | 'short' | undefined;
      if (c > box.hi + buf) side = 'long';
      else if (c < box.lo - buf) side = 'short';
      if (!side) continue;
      s.box = undefined; // a breakout consumes the box (filtered or not)
      if (rel > p.endMin || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (p.side !== 'both' && p.side !== side) continue;
      const long = side === 'long';
      if (p.filter === 'vwap') { const v = s.vol > 0 ? s.pv / s.vol : c; if (long ? c < v : c > v) continue; }
      if (p.filter === 'open') { if (long ? c < s.first! : c > s.first!) continue; }
      const range = box.hi - box.lo;
      let stop = p.stop === 'box' ? (long ? box.lo : box.hi) : p.stop === 'mid' ? (box.hi + box.lo) / 2 : long ? c - p.stopAtr * s.atr : c + p.stopAtr * s.atr;
      const minDist = (c * p.minStopPct) / 100;
      if (long ? c - stop < minDist : stop - c < minDist) stop = long ? c - minDist : c + minDist;
      const sig: Signal = { symbol: sym, side, stop, ...mgmt(p, ctx.minute), tag: `${p.mode}-${side}` };
      if (p.entry !== 'market') {
        const [fr, ttl] = p.entry.slice(3).split('_').map(Number);
        const lim = long ? c - (fr / 100) * range : c + (fr / 100) * range;
        if (long ? lim <= stop : lim >= stop) continue;
        sig.entryLimit = Math.round(lim * 100) / 100;
        sig.limitTtl = ttl;
      }
      cands.push({ sig, score: box.score });
    }
    return cands.sort((a, b) => a.score - b.score).map((x) => x.sig);
  },
};

export default {
  strategy,
  grid: {
    // Run 1 (960 configs): mode atr/intra/nr × tight 1,3 × barMin 2,5 × boxMin 20,40 × uni gap/liquid × filter none/vwap
    //   × stop box/atr × exit tgt2/tgt2be1/trail1/time60/flat, market entries, risk 50, default limits.
    // Run 2 (576): liquid NR-squeezes on 5-min bars (chosen from run 1's full-period ranking — in-sample informed),
    //   tight 1,3 × boxMin 20,40 × filter × stop box/atr × entry market/lim0_5/lim25_10 × exit time60/flat/nostop60
    //   × maxTrades 3/0 × maxConcurrent 2/0, risk 50.
    // Run 3 (768): region from run 2's full-period ranking (in-sample informed): NR4/NR8 of 5-min bars, box stop,
    //   entry market/lim25_10/lim50_10/lim25_20 × exit nostop30/nostop60/time60 × filter none/vwap × boxMin 20/40
    //   × risk 50/100/200/500 × maxTrades 3/0 × maxConcurrent 2/0.  → WF PASS (+112R).
    // Run 4 (this grid, 432): robustness of the run-3 result to its neighbourhood (bar size, lookback, NR strictness)
    //   and to the daily loss limit / max losers on vs off, at risk 500. Not tuned toward run 3's walk-forward months.
    mode: ['nr'],
    tight: [1, 2],
    barMin: [3, 5, 10],
    boxMin: [15, 20, 30],
    armMin: [30],
    buf: [0],
    uni: ['liquid'],
    filter: ['none'],
    side: ['both'],
    startMin: [15],
    endMin: [330],
    entry: ['market', 'lim50_10'],
    stop: ['box'],
    stopAtr: [0.25],
    minStopPct: [0.2],
    exit: ['nostop60', 'nostop120', 'time60'],
    'rule.riskPerTrade': [500],
    'rule.dailyLossLimit': [1500, 0],
    'rule.maxLosses': [2, 0],
  },
};
