// r2_double: intraday double top / double bottom.
// 1-minute bars are folded into barMinutes buckets (aligned to 09:30). Swing pivots need `pivotLen` buckets on each
// side (so a pivot is known only pivotLen buckets later — no look-ahead). When a new swing high H2 is confirmed and
// an earlier swing high H1 (minSep..maxSep buckets before) is within tolerance (tolFrac × pattern depth) and nothing
// between them traded above the pair, the pattern is armed: neckline = lowest low between H1 and H2, extreme = max(H1,H2).
// The pattern must be deep enough (minDepthAtr × bucket ATR). A later bucket CLOSING below the neckline triggers a
// short (mirror: double bottom → long). A close beyond the extreme cancels; maxWait buckets after H2 expires it.
// Options: only at the day's high/low (hodOnly), VWAP side filter, gap/liquid universe, market vs limit entry,
// stop beyond the extreme / mid-pattern / ATR / none, R or measured-move target, breakeven, trailing, time exit.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;
  barMinutes: number;
  pivotLen: number;          // buckets on each side of a swing pivot
  minSep: number;            // min buckets between the two tops
  maxSep: number;            // max buckets between the two tops
  tolFrac: number;           // |H1 − H2| ≤ tolFrac × depth
  minDepthAtr: number;       // depth (top − neckline) ≥ this × bucket ATR
  minDepthBps: number;       // depth ≥ this many basis points of price (costs dominate tiny patterns)
  maxWait: number;           // buckets after H2 for the neckline break
  hodOnly: boolean;          // the double extreme must be the day's high (low) so far
  vwapFilter: boolean;       // short only below VWAP at the break, long only above
  direction: 'both' | 'long' | 'short';
  startMin: number;          // minutes after 09:30 before the first entry
  cutoffMin: number;         // minutes after 09:30 for the last entry
  entry: 'market' | 'neck' | 'close';
  limitBps: number;          // entry 'close': limit = close × (1 ± bps) (better than the close)
  limitTtl: number;
  stopMode: 'extreme' | 'mid' | 'atr' | 'none';
  stopBufAtr: number;        // extreme stop: buffer beyond the extreme in bucket ATRs
  atrStop: number;           // atr stop: distance in bucket ATRs; 'none': sizing distance
  targetMode: 'r' | 'mm';    // fixed R or measured move (neckline ∓ depth)
  targetR: number;           // 0 = none; < 0 = measured move (same as targetMode 'mm')
  breakevenAtR: number;
  trailR: number;
  holdMinutes: number;       // 0 = to flatten
  reentry: boolean;          // allow another trade in the same symbol after the first closes
}

interface Bk { o: number; h: number; l: number; c: number; start: number }
interface Piv { i: number; px: number }
interface Arm { side: 'long' | 'short'; neck: number; extreme: number; depth: number; h2: number }
interface S {
  seen: number;
  cur?: Bk;
  bk: Bk[];
  ranges: number[];
  pivH: Piv[]; pivL: Piv[];
  arms: Arm[];
  pv: number; vol: number;
  dayHi: number; dayLo: number;
}

const OPEN = 9 * 60 + 30;

function bucketAtr(s: S): number {
  const r = s.ranges;
  const from = Math.max(0, r.length - 14);
  let sum = 0;
  for (let i = from; i < r.length; i++) sum += r[i];
  return sum / Math.max(1, r.length - from);
}

/** Process a just-finalised bucket: pivots, pattern arming, triggers. Returns a trigger (side + pattern) or undefined. */
function onBucket(s: S, p: P): { arm: Arm; close: number; atr: number } | undefined {
  const bk = s.bk;
  const n = bk.length;
  const last = bk[n - 1];
  s.ranges.push(last.h - last.l);
  const atr = bucketAtr(s);

  // 1. Triggers / cancellations for armed patterns (decided on this closed bucket).
  let trig: { arm: Arm; close: number; atr: number } | undefined;
  const keep: Arm[] = [];
  for (const a of s.arms) {
    if (n - 1 - a.h2 > p.maxWait) continue;
    if (a.side === 'short') {
      if (last.c > a.extreme) continue;
      if (last.c < a.neck) { if (!trig) trig = { arm: a, close: last.c, atr }; continue; }
    } else {
      if (last.c < a.extreme) continue;
      if (last.c > a.neck) { if (!trig) trig = { arm: a, close: last.c, atr }; continue; }
    }
    keep.push(a);
  }
  s.arms = keep;

  // 2. Pivot confirmation at j = n-1-k.
  const k = p.pivotLen;
  const j = n - 1 - k;
  if (j >= k && s.ranges.length >= 5) {
    let isH = true, isL = true;
    for (let q = j - k; q <= j + k; q++) {
      if (q === j) continue;
      if (q < j ? bk[q].h >= bk[j].h : bk[q].h > bk[j].h) isH = false;
      if (q < j ? bk[q].l <= bk[j].l : bk[q].l < bk[j].l) isL = false;
    }
    if (isH) { tryArm(s, p, 'short', j, atr); s.pivH.push({ i: j, px: bk[j].h }); }
    if (isL) { tryArm(s, p, 'long', j, atr); s.pivL.push({ i: j, px: bk[j].l }); }
  }
  return trig;
}

function tryArm(s: S, p: P, side: 'long' | 'short', j: number, atr: number) {
  const bk = s.bk;
  const top = side === 'short';
  const h2 = top ? bk[j].h : bk[j].l;
  const pivs = top ? s.pivH : s.pivL;
  // Must be the day's extreme so far (incl. bars up to now)?
  if (p.hodOnly) {
    const tolAbs = 0.25 * atr;
    if (top ? h2 < s.dayHi - tolAbs : h2 > s.dayLo + tolAbs) return;
  }
  // Running stats of the buckets strictly between H1 and H2, extended backwards as older pivots are tried.
  let q = j - 1;
  let segExt = top ? -Infinity : Infinity; // most extreme high (low) between
  let neck = top ? Infinity : -Infinity;   // lowest low (highest high) between
  for (let x = pivs.length - 1; x >= 0; x--) {
    const h1p = pivs[x];
    const sep = j - h1p.i;
    if (sep > p.maxSep) break;
    for (; q > h1p.i; q--) {
      segExt = top ? Math.max(segExt, bk[q].h) : Math.min(segExt, bk[q].l);
      neck = top ? Math.min(neck, bk[q].l) : Math.max(neck, bk[q].h);
    }
    if (sep < p.minSep) continue;
    const h1 = h1p.px;
    const ext = top ? Math.max(h1, h2) : Math.min(h1, h2);
    // Between the two tops: nothing beyond the pair; neckline = extreme low (high) between.
    if (top ? segExt > ext : segExt < ext) {
      // A bar between exceeds this pair; older pivots contain it too unless they are themselves higher.
      continue;
    }
    if (!Number.isFinite(neck)) continue;
    const inner = top ? Math.min(h1, h2) : Math.max(h1, h2);
    const depth = top ? inner - neck : neck - inner;
    if (!(depth > 0) || depth < p.minDepthAtr * atr || depth < (p.minDepthBps / 10_000) * inner) continue;
    if (Math.abs(h1 - h2) > p.tolFrac * depth) continue;
    // The break must not already have happened in the pivotLen buckets after H2.
    let broke = false;
    for (let q = j + 1; q < bk.length; q++) if (top ? bk[q].c < neck || bk[q].c > ext : bk[q].c > neck || bk[q].c < ext) broke = true;
    if (broke) return;
    s.arms.push({ side, neck, extreme: ext, depth, h2: j });
    return;
  }
}

function finalize(s: S, p: P) {
  const b = s.cur!;
  s.cur = undefined;
  s.bk.push(b);
  return onBucket(s, p);
}

const strategy: Strategy<P> = {
  name: 'r2_double',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && m.open >= 5 && m.open <= 150)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const B = p.barMinutes;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, bk: [], ranges: [], pivH: [], pivL: [], arms: [], pv: 0, vol: 0, dayHi: -Infinity, dayLo: Infinity }));
      let trig: { arm: Arm; close: number; atr: number } | undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const start = OPEN + Math.floor((bm - OPEN) / B) * B;
        if (s.cur && s.cur.start !== start) trig = finalize(s, p) ?? trig;
        if (!s.cur) s.cur = { o: b.o, h: b.h, l: b.l, c: b.c, start };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.dayHi = Math.max(s.dayHi, b.h);
        s.dayLo = Math.min(s.dayLo, b.l);
      }
      // The bucket is complete once all of its minutes have closed.
      if (s.cur && s.cur.start + B <= ctx.minute) trig = finalize(s, p) ?? trig;
      if (!trig) continue;
      const { arm, close, atr } = trig;
      const side = arm.side;
      if (ctx.minute < OPEN + p.startMin || ctx.minute > OPEN + p.cutoffMin) continue;
      if (p.direction !== 'both' && p.direction !== side) continue;
      if (ctx.open.has(sym) || (!p.reentry && ctx.traded.has(sym))) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      if (p.vwapFilter && (side === 'short' ? close > vwap : close < vwap)) continue;
      const dir = side === 'long' ? 1 : -1;
      let stop: number;
      if (p.stopMode === 'extreme') stop = arm.extreme - dir * p.stopBufAtr * atr;
      else if (p.stopMode === 'mid') stop = (arm.neck + arm.extreme) / 2;
      else stop = close - dir * p.atrStop * atr;
      if ((side === 'long' && stop >= close) || (side === 'short' && stop <= close)) continue;
      let entryLimit: number | undefined;
      if (p.entry === 'neck') entryLimit = Math.round(arm.neck * 100) / 100;
      else if (p.entry === 'close') entryLimit = Math.round(close * (1 + dir * -p.limitBps / 10_000) * 100) / 100;
      // Limit must still be on the right side of the stop.
      if (entryLimit !== undefined && (side === 'long' ? entryLimit <= stop : entryLimit >= stop)) continue;
      const ref = entryLimit ?? close;
      let targetR: number | undefined = p.targetR || undefined;
      if (p.targetMode === 'mm' || p.targetR < 0) {
        const tgt = arm.neck - dir * arm.depth;
        const risk = Math.abs(ref - stop);
        targetR = risk > 0 ? Math.max(0.3, Math.abs(ref - tgt) / risk) : undefined;
      }
      out.push({
        symbol: sym, side, stop, targetR,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        noStop: p.stopMode === 'none' || undefined,
        tag: side,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    tags: ['all'],
    minGap: [0],
    barMinutes: [1],
    pivotLen: [2],
    minSep: [4],
    maxSep: [40],
    tolFrac: [0.3],
    minDepthAtr: [3],
    minDepthBps: [30],
    maxWait: [10],
    hodOnly: [true, false],
    vwapFilter: [true],
    direction: ['both'],
    startMin: [15],
    cutoffMin: [330],
    entry: ['market', 'neck'],
    limitBps: [5],
    limitTtl: [10],
    stopMode: ['none', 'extreme', 'mid'],
    stopBufAtr: [0.25],
    atrStop: [2],
    targetMode: ['r'],
    targetR: [0],
    breakevenAtR: [0],
    trailR: [0],
    holdMinutes: [0, 120],
    reentry: [false],
    'rule.riskPerTrade': [50, 500],
    'rule.dailyLossLimit': [0],
    'rule.maxTrades': [3],
    'rule.maxConcurrent': [2],
  },
};
