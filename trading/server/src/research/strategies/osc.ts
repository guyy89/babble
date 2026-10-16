// Oscillator family ("osc"): intraday mean-reversion / squeeze strategies on N-minute bars built from 1-minute bars.
//   variant 'rsi'   — RSI extreme reversal: RSI below rsiLo (above 100-rsiLo) on the previous N-bar, then it turns back
//                     (or crosses back over the threshold) → fade the extreme. Swing-extreme stop, R target / time exit.
//   variant 'bbrev' — Bollinger reversion: previous N-bar closed outside the band, latest closed back inside → fade toward
//                     the middle band (tgt = -1 → target at the middle band, else fixed R).
//   variant 'bbsqz' — Bollinger squeeze breakout: band width (of the previous bar) at its lowest of the last sqzLook bars,
//                     then a close outside the band → go with the break, stop at the middle band.
// No look-ahead: universe() uses meta + dailyBefore only; onMinute() folds only closed 1-minute bars, and an N-bar is
// finalised only at minute m where (m-09:30) % N == 0, i.e. once all of its 1-minute bars (t < m) have closed.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'rsi' | 'bbrev' | 'bbsqz';
  bar: number;            // N-minute signal bars
  tags: 'liquid' | 'index' | 'gap';
  minPrice: number;
  maxPrice: number;
  minAtrPct: number;      // min 14-day daily ATR as % of price (0 = off)
  rsiLen: number;
  rsiLo: number;          // long below this, short above 100-rsiLo
  rsiConfirm: 'turn' | 'cross';
  bbLen: number;
  bbMult: number;
  sqzLook: number;        // squeeze: width at its min over this many bars
  startMin: number;       // first entry this many minutes after the open
  lastEntry: number;      // last entry minute-of-day
  vwapSide: 'none' | 'with' | 'against';
  maxTrend: number;       // skip if |price - day open| > maxTrend * daily ATR (0 = off)
  swing: number;          // stop beyond the extreme of the last `swing` N-bars
  stopAtr: number;        // ... plus this many N-bar ATRs
  minRiskPct: number;     // skip if the stop is closer than this % of price (slippage ~0.1% round trip)
  riskMode: 'skip' | 'widen'; // ... or widen the stop to that distance
  tgt: number;            // target R; -1 = middle band (bbrev) / VWAP (rsi)
  be: number;             // breakeven at R (0 = off)
  trail: number;          // trail R (0 = off)
  hold: number;           // time exit after this many N-bars (0 = off)
  side: 'both' | 'long' | 'short';
  reentry: boolean;       // allow a second trade in the same symbol
}

interface NB { o: number; h: number; l: number; c: number }
interface S {
  seen: number;
  cur?: NB;               // N-bar being built
  bars: NB[];             // completed N-bars
  pv: number; vol: number;
  dayOpen?: number;
  // Wilder RSI
  ag: number; al: number; rsiN: number; rsi: number[];
  // Bollinger
  mid: number[]; up: number[]; dn: number[]; bw: number[];
  tr: number[];
}

const OPEN = 9 * 60 + 30;
const DAILY_ATR = new Map<string, number>();

function dailyAtr(ctx: DayContext, sym: string): number {
  const key = `${ctx.date}|${sym}`;
  const hit = DAILY_ATR.get(key);
  if (hit !== undefined) return hit;
  const d = ctx.dailyBefore(sym).slice(-15);
  let sum = 0, n = 0;
  for (let i = 1; i < d.length; i++) {
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c), Math.abs(d[i].l - d[i - 1].c));
    n++;
  }
  const v = n ? sum / n : NaN;
  DAILY_ATR.set(key, v);
  return v;
}

function finalize(s: S, b: NB, p: P) {
  const prev = s.bars.at(-1);
  s.bars.push(b);
  s.tr.push(prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l);
  // RSI (Wilder), seeded by simple averages over the first rsiLen changes.
  if (prev) {
    const ch = b.c - prev.c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    s.rsiN++;
    if (s.rsiN <= p.rsiLen) { s.ag += g / p.rsiLen; s.al += l / p.rsiLen; }
    else { s.ag = (s.ag * (p.rsiLen - 1) + g) / p.rsiLen; s.al = (s.al * (p.rsiLen - 1) + l) / p.rsiLen; }
    s.rsi.push(s.rsiN >= p.rsiLen ? (s.al === 0 ? 100 : 100 - 100 / (1 + s.ag / s.al)) : NaN);
  } else s.rsi.push(NaN);
  // Bollinger
  if (s.bars.length >= p.bbLen) {
    let m = 0;
    for (let i = s.bars.length - p.bbLen; i < s.bars.length; i++) m += s.bars[i].c;
    m /= p.bbLen;
    let v = 0;
    for (let i = s.bars.length - p.bbLen; i < s.bars.length; i++) v += (s.bars[i].c - m) ** 2;
    const sd = Math.sqrt(v / p.bbLen);
    s.mid.push(m); s.up.push(m + p.bbMult * sd); s.dn.push(m - p.bbMult * sd); s.bw.push((2 * p.bbMult * sd) / m);
  } else { s.mid.push(NaN); s.up.push(NaN); s.dn.push(NaN); s.bw.push(NaN); }
}

const strategy: Strategy<P> = {
  name: 'osc',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes(p.tags) && m.open >= p.minPrice && m.open <= p.maxPrice)
      .filter((m) => {
        if (!p.minAtrPct) return true;
        const a = dailyAtr(ctx, m.symbol);
        return Number.isFinite(a) && (a / m.open) * 100 >= p.minAtrPct;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const cands: { sig: Signal; score: number }[] = [];
    const boundary = (ctx.minute - OPEN) % p.bar === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, bars: [], pv: 0, vol: 0, ag: 0, al: 0, rsiN: 0, rsi: [], mid: [], up: [], dn: [], bw: [], tr: [] }));
      let fresh = false;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        if (s.dayOpen === undefined) s.dayOpen = b.o;
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (!s.cur) s.cur = { o: b.o, h: b.h, l: b.l, c: b.c };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      // All 1-minute bars of the N-bar [minute-N, minute) have closed → finalise it.
      if (boundary && s.cur) { finalize(s, s.cur, p); s.cur = undefined; fresh = true; }
      if (!fresh) continue;
      if (ctx.minute < OPEN + p.startMin || ctx.minute > p.lastEntry) continue;
      if (ctx.open.has(sym) || (!p.reentry && ctx.traded.has(sym))) continue;

      const n = s.bars.length;
      if (n < 3) continue;
      const last = s.bars[n - 1];
      const close = last.c;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      let side: 'long' | 'short' | undefined;
      let score = 0;
      let tgtPx: number | undefined;
      let stopPx: number | undefined;

      if (p.variant === 'rsi') {
        const r1 = s.rsi[n - 1], r0 = s.rsi[n - 2];
        if (!Number.isFinite(r1) || !Number.isFinite(r0)) continue;
        const hi = 100 - p.rsiLo;
        if (p.rsiConfirm === 'turn') {
          if (r0 < p.rsiLo && r1 > r0 && last.c > last.o) side = 'long';
          else if (r0 > hi && r1 < r0 && last.c < last.o) side = 'short';
        } else {
          if (r0 < p.rsiLo && r1 >= p.rsiLo) side = 'long';
          else if (r0 > hi && r1 <= hi) side = 'short';
        }
        score = side === 'long' ? p.rsiLo - r0 : r0 - hi;
        tgtPx = vwap;
      } else if (p.variant === 'bbrev') {
        const prev = s.bars[n - 2];
        const dn0 = s.dn[n - 2], up0 = s.up[n - 2], dn1 = s.dn[n - 1], up1 = s.up[n - 1];
        if (!Number.isFinite(dn0) || !Number.isFinite(dn1)) continue;
        if (prev.c < dn0 && close > dn1) side = 'long';
        else if (prev.c > up0 && close < up1) side = 'short';
        score = side === 'long' ? (dn0 - prev.c) / prev.c : (prev.c - up0) / prev.c;
        tgtPx = s.mid[n - 1];
      } else {
        // squeeze: width of the bar before the break is the lowest of the last sqzLook bars
        const w = s.bw;
        if (n < p.sqzLook + 1 || !Number.isFinite(w[n - 1 - p.sqzLook])) continue;
        let minW = Infinity;
        for (let i = n - 1 - p.sqzLook; i < n - 1; i++) minW = Math.min(minW, w[i]);
        if (w[n - 2] > minW * 1.0000001) continue;
        if (close > s.up[n - 1]) side = 'long';
        else if (close < s.dn[n - 1]) side = 'short';
        score = 1 / w[n - 2];
        stopPx = s.mid[n - 1];
      }
      if (!side) continue;
      if (p.side !== 'both' && p.side !== side) continue;
      if (p.vwapSide === 'with' && (side === 'long' ? close < vwap : close > vwap)) continue;
      if (p.vwapSide === 'against' && (side === 'long' ? close > vwap : close < vwap)) continue;
      if (p.maxTrend > 0) {
        const datr = dailyAtr(ctx, sym);
        if (!Number.isFinite(datr) || Math.abs(close - s.dayOpen!) > p.maxTrend * datr) continue;
      }

      // Stop: swing extreme of the last `swing` N-bars ± stopAtr × N-bar ATR (squeeze: middle band ± buffer).
      const k = Math.min(14, s.tr.length);
      let atr = 0;
      for (let i = s.tr.length - k; i < s.tr.length; i++) atr += s.tr[i];
      atr /= k;
      const sw = s.bars.slice(-p.swing);
      let stop: number;
      if (stopPx !== undefined) stop = side === 'long' ? stopPx - p.stopAtr * atr : stopPx + p.stopAtr * atr;
      else stop = side === 'long' ? Math.min(...sw.map((b) => b.l)) - p.stopAtr * atr : Math.max(...sw.map((b) => b.h)) + p.stopAtr * atr;
      if (p.riskMode === 'widen') stop = side === 'long' ? Math.min(stop, close * (1 - p.minRiskPct / 100)) : Math.max(stop, close * (1 + p.minRiskPct / 100));
      const risk = side === 'long' ? close - stop : stop - close;
      if (!(risk > 0) || (risk / close) * 100 < p.minRiskPct * 0.999) continue;
      let targetR: number | undefined = p.tgt > 0 ? p.tgt : undefined;
      if (p.tgt < 0 && tgtPx !== undefined) {
        const rew = side === 'long' ? tgtPx - close : close - tgtPx;
        targetR = rew / risk;
        if (!(targetR >= 0.5)) continue;   // not enough room to the mean
      }
      cands.push({
        score,
        sig: {
          symbol: sym, side, stop, targetR,
          breakevenAtR: p.be || undefined, trailR: p.trail || undefined,
          exitMinute: p.hold ? ctx.minute + p.hold * p.bar : undefined,
          tag: `${p.variant}-${side}`,
        },
      });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
// Best in-sample config (validated once out-of-sample 2026-10-16: FAILED, OOS net -753, pf 0.76).
    variant: ['rsi'], bar: [15], tags: ['gap'], minPrice: [20], maxPrice: [2000], minAtrPct: [0.5],
    rsiLen: [14], rsiLo: [20], rsiConfirm: ['turn'], bbLen: [20], bbMult: [2], sqzLook: [8],
    startMin: [30], lastEntry: [15 * 60 + 15], vwapSide: ['none'], maxTrend: [0],
    swing: [3], stopAtr: [0.25], minRiskPct: [1], riskMode: ['widen'], tgt: [-1], be: [0], trail: [0], hold: [0], side: ['both'], reentry: [true],
  },
  rules: { maxTrades: 5, maxLosses: 3 },
};
