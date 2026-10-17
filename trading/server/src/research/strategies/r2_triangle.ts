// r2_triangle: converging price structure (pennant / symmetric triangle) breakout.
// 1-minute bars are aggregated into barMinutes buckets aligned to 09:30. Swing highs/lows are pivots
// confirmed pivotK buckets later (so only closed data is used). A triangle exists when the last
// `pivots` swing highs are descending and the last `pivots` swing lows are ascending, all inside the
// last `lookback` buckets, and the channel has contracted. A trade is taken on the first bucket CLOSE
// beyond the upper (long) or lower (short) trend line, optionally only in the direction of the prior trend.
// Pattern copied from orb.ts: universe() uses only 09:30 info; onMinute() folds new bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;          // |gap| % to qualify (gap names)
  maxSymbols: number;      // candidates per day (largest |gap| first)
  barMinutes: number;      // bucket length
  pivotK: number;          // swing pivot confirmation: buckets on each side
  pivots: number;          // number of descending highs / ascending lows required (2 or 3)
  lookback: number;        // all pivots must be within the last `lookback` buckets
  contraction: number;     // channel width at the break ≤ contraction × width at the first pivots
  trend: 'any' | 'day' | 'gap' | 'vwap' | 'counter'; // direction filter
  minTrendAtr: number;     // for 'day'/'counter': |pattern-start close − day open| ≥ this × ATR (0 = sign only)
  stopMode: 'pivot' | 'line' | 'atr'; // last opposite pivot / opposite trend line at the break / ATR
  stopAtr: number;         // ATR multiple for stopMode 'atr'
  limitFrac: number;       // 0 = market; else limit = close − limitFrac × (close − broken line) (1 = retest of the line)
  limitTtl: number;
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMinutes: number;     // time exit after entry (0 = off)
  noStop: boolean;         // size from stop but don't place it (requires holdMinutes or flatten)
  startMinutes: number;    // earliest entry, minutes after 09:30
  cutoffMinutes: number;   // latest entry, minutes after 09:30
  maxPerSym: number;       // entries per symbol per day
  mode: 'triangle' | 'control'; // control = same trend filter/exits/sizing but no triangle (baseline)
}

interface Agg { o: number; h: number; l: number; c: number }
interface Pivot { i: number; px: number }
interface S {
  seen: number;
  dayOpen?: number;
  pv: number; vol: number;
  cur?: Agg; curIdx: number;     // bucket being built
  aggs: Agg[]; idxs: number[];   // completed buckets and their bucket indices
  highs: Pivot[]; lows: Pivot[];
  used: Set<string>;
  entries: number;
  pivDone: number;               // next bucket index to test as a pivot
}

const OPEN = 9 * 60 + 30;

const lineAt = (a: Pivot, b: Pivot, i: number) => a.px + ((b.px - a.px) * (i - a.i)) / (b.i - a.i);

const strategy: Strategy<P> = {
  name: 'r2_triangle',
  universe(ctx: DayContext, p: P) {
    const ms = Object.values(ctx.meta);
    const gap = ms
      .filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap && m.open >= 5)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
    const liquid = ms.filter((m) => m.tags.includes('liquid') || m.tags.includes('index')).map((m) => m.symbol);
    if (p.tags === 'gap') return gap;
    if (p.tags === 'liquid') return liquid;
    return [...new Set([...gap, ...liquid])];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const B = p.barMinutes;
    const evalNow = (ctx.minute - OPEN) % B === 0;
    const doneIdx = (ctx.minute - OPEN) / B - 1; // bucket that has just completed when evalNow
    const canEnter = ctx.minute >= OPEN + p.startMinutes && ctx.minute <= OPEN + p.cutoffMinutes;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, pv: 0, vol: 0, curIdx: -1, aggs: [], idxs: [], highs: [], lows: [], used: new Set(), entries: 0, pivDone: 0 }));
      let newAgg = false;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        if (s.dayOpen === undefined) s.dayOpen = b.o;
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const bi = Math.floor((ctx.minuteOf(b.t) - OPEN) / B);
        if (s.cur && bi !== s.curIdx) { s.aggs.push(s.cur); s.idxs.push(s.curIdx); s.cur = undefined; newAgg = true; }
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curIdx = bi; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      // The current bucket is complete once the minute boundary passes.
      if (evalNow && s.cur && s.curIdx === doneIdx) { s.aggs.push(s.cur); s.idxs.push(s.curIdx); s.cur = undefined; newAgg = true; }
      if (!newAgg) continue;
      const A = s.aggs;
      const j = A.length - 1;
      // Confirm a pivot at j − K (strictly higher than the K buckets before, ≥ the K after).
      const K = p.pivotK;
      for (; s.pivDone <= j - K; s.pivDone++) {
        const c = s.pivDone;
        if (c < K) continue;
        let isH = true, isL = true;
        for (let d = 1; d <= K; d++) {
          if (!(A[c].h > A[c - d].h && A[c].h >= A[c + d].h)) isH = false;
          if (!(A[c].l < A[c - d].l && A[c].l <= A[c + d].l)) isL = false;
        }
        if (isH) s.highs.push({ i: c, px: A[c].h });
        if (isL) s.lows.push({ i: c, px: A[c].l });
      }
      // Only signal on a bucket that has just closed at this minute (not on stale catch-up).
      if (!evalNow || s.idxs[j] !== doneIdx || !canEnter) continue;
      if (ctx.open.has(sym) || s.entries >= p.maxPerSym || j < 15) continue;
      if (p.mode === 'control') {
        // Control (no pattern): first closed bucket after startMinutes where the day's move from the open is
        // ≥ minTrendAtr × ATR; enter with the move once per symbol. Stop: 0.5 ATR ('line'/'pivot') or stopAtr ATR.
        let rs0 = 0;
        const n0 = Math.min(14, A.length);
        for (let q = A.length - n0; q < A.length; q++) rs0 += A[q].h - A[q].l;
        const atr0 = rs0 / n0;
        const mv0 = A[j].c - s.dayOpen!;
        if (!(atr0 > 0) || Math.abs(mv0) < p.minTrendAtr * atr0) continue;
        const side0 = mv0 > 0 ? 'long' : 'short';
        const d0 = mv0 > 0 ? 1 : -1;
        s.entries = p.maxPerSym;
        out.push({
          symbol: sym, side: side0, stop: A[j].c - d0 * (p.stopMode === 'atr' ? p.stopAtr : 0.5) * atr0,
          targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
          exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined, noStop: p.noStop || undefined,
          entryLimit: p.limitFrac ? Math.round((A[j].c - d0 * p.limitFrac * 0.5 * atr0) * 100) / 100 : undefined,
          limitTtl: p.limitFrac ? p.limitTtl : undefined, tag: `ctl-${side0}`,
        });
        continue;
      }
      const n = p.pivots;
      if (s.highs.length < n || s.lows.length < n) continue;
      const H = s.highs.slice(-n), L = s.lows.slice(-n);
      if (H[0].i < j - p.lookback || L[0].i < j - p.lookback) continue;
      let ok = true;
      for (let q = 1; q < n; q++) if (!(H[q].px < H[q - 1].px && L[q].px > L[q - 1].px)) ok = false;
      if (!ok) continue;
      const h0 = H[0], h1 = H[n - 1], l0 = L[0], l1 = L[n - 1];
      const up = lineAt(h0, h1, j), lo = lineAt(l0, l1, j);
      const upPrev = lineAt(h0, h1, j - 1), loPrev = lineAt(l0, l1, j - 1);
      if (!(up > lo)) continue; // apex passed
      const startW = h0.px - l0.px;
      if (!(startW > 0) || up - lo > p.contraction * startW) continue;
      const key = `${h0.i},${h1.i},${l0.i},${l1.i}`;
      if (s.used.has(key)) continue;
      const bar = A[j], prev = A[j - 1];
      let side: 'long' | 'short' | undefined;
      if (bar.c > up && prev.c <= upPrev) side = 'long';
      else if (bar.c < lo && prev.c >= loPrev) side = 'short';
      if (!side) continue;
      // ATR of the last 14 buckets (simple average range).
      let rs = 0;
      const nA = Math.min(14, A.length);
      for (let q = A.length - nA; q < A.length; q++) rs += A[q].h - A[q].l;
      const atr = rs / nA;
      const dir = side === 'long' ? 1 : -1;
      if (p.trend !== 'any') {
        const start = Math.min(h0.i, l0.i);
        const mv = A[start].c - s.dayOpen!;
        let want = 0;
        if (p.trend === 'gap') want = Math.sign(ctx.meta[sym].gapPct);
        else if (p.trend === 'vwap') want = s.vol > 0 ? Math.sign(bar.c - s.pv / s.vol) : 0;
        else if (Math.abs(mv) >= p.minTrendAtr * atr) want = Math.sign(mv) * (p.trend === 'counter' ? -1 : 1);
        if (want !== dir) continue;
      }
      s.used.add(key);
      let stop: number;
      if (p.stopMode === 'pivot') stop = side === 'long' ? l1.px : h1.px;
      else if (p.stopMode === 'line') stop = side === 'long' ? lo : up;
      else stop = bar.c - dir * p.stopAtr * atr;
      const broken = side === 'long' ? up : lo;
      s.entries++;
      out.push({
        symbol: sym, side, stop,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit: p.limitFrac ? Math.round((bar.c - p.limitFrac * (bar.c - broken)) * 100) / 100 : undefined,
        limitTtl: p.limitFrac ? p.limitTtl : undefined,
        tag: `${side}-${p.stopMode}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    mode: ['triangle', 'control'],
    tags: ['liquid'], minGap: [3], maxSymbols: [10], barMinutes: [1], pivotK: [2], pivots: [2], lookback: [40],
    contraction: [0.5], trend: ['day'], minTrendAtr: [1], stopMode: ['line', 'atr'], stopAtr: [1.5],
    limitFrac: [0, 1], limitTtl: [5], targetR: [0], breakevenAtR: [0], trailR: [0], holdMinutes: [0], noStop: [true, false],
    startMinutes: [15, 45], cutoffMinutes: [300], maxPerSym: [2],
    'rule.riskPerTrade': [100, 500], 'rule.maxTrades': [3], 'rule.maxConcurrent': [2, 0],
  } as Record<string, unknown[]>,
};
