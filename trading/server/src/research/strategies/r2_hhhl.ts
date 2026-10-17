// Market-structure (HH/HL) breakout.
// 1-minute bars are aggregated into `barMin`-minute bars aligned to 09:30. A swing high (low) is a bar whose high
// (low) is above (below) the `k` bars on each side; it is only known once those k right-hand bars have CLOSED
// (no look-ahead). Long setup: the last swing low came after the last swing high and is higher than the previous
// swing low (higher low); with req='hhhl' the last swing high must also be higher than the previous one. Entry
// when an N-minute bar closes above that last swing high (fresh cross: previous bar closed at/below it) while the
// higher low has not been broken since. Stop below the higher low (or at the mid of the swing range). Mirror for
// shorts (lower high after a lower low, close below the last swing low).
// State is updated incrementally from newly closed 1-minute bars only; decisions use bars with t < ctx.minute.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;          // gap universe: |gap| % threshold
  barMin: number;          // aggregation (1..5)
  k: number;               // fractal half-width
  req: 'hhhl' | 'hl';      // structure requirement
  direction: 'both' | 'long' | 'short' | 'with-gap';
  vwapFilter: boolean;     // long only above session VWAP, short only below
  startMin: number;        // no entries before 09:30 + startMin
  endMin: number;          // no entries after 09:30 + endMin
  stopMode: 'swing' | 'mid';
  stopBufPct: number;      // extra buffer beyond the swing, % of price
  minRiskPct: number;      // skip if stop distance < this % of price
  maxRiskPct: number;      // skip if stop distance > this % of price
  entry: 'market' | 'close' | 'retest' | 'half'; // LIMIT at signal close / at the broken swing level / half-way to stop
  limitTtl: number;
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = off; time exit after this many minutes
  noStop: boolean;         // size from the stop but exit only by target/time
  maxPerSym: number;       // signals per symbol per day
}

interface Swing { px: number; idx: number }
interface S {
  seen: number;
  pv: number; vol: number;
  bId: number; bh: number; bl: number; bc: number; has: boolean; // N-minute bar being built
  hs: number[]; ls: number[]; cs: number[]; n: number;           // last completed N-minute bars
  highs: Swing[]; lows: Swing[];
  lowSinceL: number;   // lowest low since the last swing low (its right-hand bars included)
  highSinceH: number;  // highest high since the last swing high
  usedH: number; usedL: number;
  sigs: number;
}
type Cand = { symbol: string; side: 'long' | 'short'; stop: number; lvl: number; px: number };

const OPEN = 9 * 60 + 30;

/** Close the N-minute bar being built, update swings, and return a breakout candidate on that bar (or null). */
function finalize(st: S, p: P, sym: string): Cand | null {
  if (!st.has) return null;
  const K = p.k;
  st.hs.push(st.bh); st.ls.push(st.bl); st.cs.push(st.bc);
  if (st.hs.length > 2 * K + 2) { st.hs.shift(); st.ls.shift(); st.cs.shift(); }
  const i = st.n++;
  st.has = false;
  st.lowSinceL = Math.min(st.lowSinceL, st.bl);
  st.highSinceH = Math.max(st.highSinceH, st.bh);
  // fractal at bar i-K, confirmed by this (closed) bar
  const L = st.hs.length;
  if (L >= 2 * K + 1) {
    const c = L - 1 - K;
    let isH = true, isL = true;
    for (let j = c - K; j <= c + K; j++) {
      if (j === c) continue;
      if (j < c ? st.hs[j] >= st.hs[c] : st.hs[j] > st.hs[c]) isH = false;
      if (j < c ? st.ls[j] <= st.ls[c] : st.ls[j] < st.ls[c]) isL = false;
    }
    if (isH) {
      st.highs.push({ px: st.hs[c], idx: i - K });
      if (st.highs.length > 3) st.highs.shift();
      st.highSinceH = Math.max(...st.hs.slice(c + 1));
    }
    if (isL) {
      st.lows.push({ px: st.ls[c], idx: i - K });
      if (st.lows.length > 3) st.lows.shift();
      st.lowSinceL = Math.min(...st.ls.slice(c + 1));
    }
  }
  if (st.highs.length < 2 || st.lows.length < 2 || L < 2) return null;
  const H0 = st.highs[st.highs.length - 2], H1 = st.highs[st.highs.length - 1];
  const L0 = st.lows[st.lows.length - 2], L1 = st.lows[st.lows.length - 1];
  const close = st.bc, prevClose = st.cs[L - 2];
  const vwap = st.vol > 0 ? st.pv / st.vol : close;
  // long: higher low printed after the last swing high, not broken since, fresh close above that swing high
  if (L1.idx > H1.idx && L1.px > L0.px && (p.req === 'hl' || H1.px > H0.px) && st.lowSinceL >= L1.px
    && close > H1.px && prevClose <= H1.px && st.usedH !== H1.idx && (!p.vwapFilter || close > vwap)) {
    st.usedH = H1.idx;
    const stop = p.stopMode === 'mid' ? (H1.px + L1.px) / 2 : L1.px - (close * p.stopBufPct) / 100;
    return { symbol: sym, side: 'long', stop, lvl: H1.px, px: close };
  }
  // short: lower high printed after the last swing low, not broken since, fresh close below that swing low
  if (H1.idx > L1.idx && H1.px < H0.px && (p.req === 'hl' || L1.px < L0.px) && st.highSinceH <= H1.px
    && close < L1.px && prevClose >= L1.px && st.usedL !== L1.idx && (!p.vwapFilter || close < vwap)) {
    st.usedL = L1.idx;
    const stop = p.stopMode === 'mid' ? (H1.px + L1.px) / 2 : H1.px + (close * p.stopBufPct) / 100;
    return { symbol: sym, side: 'short', stop, lvl: L1.px, px: close };
  }
  return null;
}

const strategy: Strategy<P> = {
  name: 'r2_hhhl',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid') || m.tags.includes('index');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms) ctx.state.set('__syms', (syms = Object.keys(ctx.meta)));
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = {
          seen: 0, pv: 0, vol: 0, bId: -1, bh: -Infinity, bl: Infinity, bc: 0, has: false,
          hs: [], ls: [], cs: [], n: 0, highs: [], lows: [], lowSinceL: Infinity, highSinceH: -Infinity,
          usedH: -1, usedL: -1, sigs: 0,
        };
        ctx.state.set(sym, s);
      }
      let cand: Cand | null = null;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const id = Math.floor((bm - OPEN) / p.barMin);
        if (s.has && id !== s.bId) cand = finalize(s, p, sym);
        if (!s.has) { s.bId = id; s.bh = b.h; s.bl = b.l; s.has = true; }
        s.bh = Math.max(s.bh, b.h); s.bl = Math.min(s.bl, b.l); s.bc = b.c;
        if ((bm - OPEN + 1) % p.barMin === 0) cand = finalize(s, p, sym);
      }
      if (!cand) continue;
      if (rel < p.startMin || rel > p.endMin) continue;
      if (ctx.open.has(sym)) continue;
      if (p.maxPerSym <= 1 ? ctx.traded.has(sym) : s.sigs >= p.maxPerSym) continue;
      const g = ctx.meta[sym].gapPct;
      if (p.direction === 'long' && cand.side !== 'long') continue;
      if (p.direction === 'short' && cand.side !== 'short') continue;
      if (p.direction === 'with-gap' && (cand.side === 'long') !== (g > 0)) continue;
      const long = cand.side === 'long';
      const px = cand.px;
      let entryRef = px;
      let entryLimit: number | undefined;
      if (p.entry === 'close') entryLimit = px;
      else if (p.entry === 'retest') entryLimit = cand.lvl;
      else if (p.entry === 'half') entryLimit = px - (px - cand.stop) / 2;
      if (entryLimit !== undefined) { entryLimit = Math.round(entryLimit * 100) / 100; entryRef = entryLimit; }
      const riskPct = ((long ? entryRef - cand.stop : cand.stop - entryRef) / px) * 100;
      if (!(riskPct >= p.minRiskPct) || riskPct > p.maxRiskPct) continue;
      const sig: Signal = {
        symbol: sym, side: cand.side, stop: cand.stop, tag: cand.side,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined,
        noStop: p.noStop || undefined,
      };
      if (entryLimit !== undefined) { sig.entryLimit = entryLimit; sig.limitTtl = p.limitTtl; }
      s.sigs++;
      out.push({ sig, score: Math.abs(g) });
    }
    return out.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

export default {
  strategy,
  grid: {
    // run 5 (shaped by run 4, which found hold-to-close without a stop dominant): robustness of the no-stop
    // variant across bar size, fractal width, structure rule, universe, direction and VWAP filter, vs a real stop.
    universe: ['liquid', 'gap'], minGap: [3], barMin: [1, 2, 5], k: [1, 2], req: ['hhhl', 'hl'],
    direction: ['with-gap', 'both'], vwapFilter: [true, false], startMin: [15], endMin: [300],
    stopMode: ['mid'], stopBufPct: [0.05], minRiskPct: [0.2], maxRiskPct: [2],
    entry: ['market', 'retest'], limitTtl: [15],
    targetR: [0], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [true, false], maxPerSym: [1],
    'rule.riskPerTrade': [500],
  },
};
