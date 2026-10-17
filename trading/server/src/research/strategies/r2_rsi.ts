// r2_rsi: RSI extremes on N-minute bars (aligned to 09:30) built from closed 1-minute bars.
//   sig 'rev-turn'  — mean reversion: RSI of the previous N-bar beyond the extreme (< lo / > 100-lo), the latest N-bar
//                     turns (RSI up and a green bar for longs; mirror for shorts) → fade the extreme.
//   sig 'rev-cross' — mean reversion: RSI crosses back inside the threshold (prev < lo, now ≥ lo) → fade.
//   sig 'rev-now'   — mean reversion without confirmation: the latest N-bar's RSI is beyond the extreme → fade.
//   sig 'mom-cross' — momentum (opposite use): RSI crosses INTO the extreme zone (prev ≤ 100-lo, now > 100-lo) → go with it.
//   sig 'mom-turn'  — momentum continuation: RSI already in the strength zone and the latest N-bar extends (RSI up, green).
// Stops: swing extreme of the last `swing` N-bars ± stopAtr × N-bar ATR, or a pure ATR distance; widened to minRiskPct.
// Entry at market or with a LIMIT limitOff × N-bar ATR better than the signal close (limitTtl minutes).
// No look-ahead: universe() uses meta only; onMinute() folds only closed 1-minute bars; an N-bar is finalised at the
// minute m with (m - 09:30) % N == 0, when all its 1-minute bars (t < m) have closed. State is incremental.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  sig: 'rev-turn' | 'rev-cross' | 'rev-now' | 'mom-cross' | 'mom-turn';
  bar: number;              // N-minute bars
  rsiLen: number;
  lo: number;               // lower threshold; upper = 100 - lo
  tags: 'liqidx' | 'liquid' | 'index' | 'gap' | 'all';
  minPrice: number;
  startMin: number;         // first signal at least this many minutes after the open
  lastEntry: number;        // last signal minute-of-day
  vwapSide: 'none' | 'with' | 'against';   // close vs VWAP relative to the trade direction
  stopMode: 'swing' | 'atr';
  swing: number;            // N-bars for the swing extreme
  stopAtr: number;          // swing: buffer in N-bar ATRs; atr: distance in N-bar ATRs
  minRiskPct: number;       // widen the stop to at least this % of price
  noStop: boolean;
  tgt: number;              // target R; 0 = none; -1 = VWAP for reversion (skip if < 0.5R away), none for momentum
  be: number;               // breakeven at R (0 = off)
  trail: number;            // trail R (0 = off)
  hold: number;             // time exit after this many N-bars (0 = off)
  side: 'both' | 'long' | 'short';
  entry: string;            // 'market' | 'limit' (uses limitOff/limitTtl) | 'limit:<off>:<ttl>'
  exit?: string;            // optional bundle: 'base' | 'be<R>' | 'trail<R>' | 'atr<k>' (ATR stop) | 'h<bars>' (time exit) | 'nostop-h<bars>'
  core?: string;            // optional bundle 'sig:bar:rsiLen:lo:tgt' overriding those keys
  limitOff: number;         // limit this many N-bar ATRs better than the signal close
  limitTtl: number;
  reentry: boolean;
}

interface NB { o: number; h: number; l: number; c: number }
interface S {
  seen: number;
  cur?: NB; curK: number;
  bars: NB[];
  pv: number; vol: number;
  ag: number; al: number; rsiN: number; rsi: number[];
  atr: number; atrN: number;
}

const OPEN = 9 * 60 + 30;
const RESOLVED = new WeakMap<object, P>();
/** Expand the optional string bundles (core, entry) once per parameter object. */
function eff(p0: P): P {
  let p = RESOLVED.get(p0);
  if (p) return p;
  p = { ...p0 };
  if (p.core) {
    const [sig, bar, len, lo, tgt] = p.core.split(':');
    Object.assign(p, { sig, bar: +bar, rsiLen: +len, lo: +lo, tgt: +tgt });
  }
  if (p.entry.startsWith('limit:')) {
    const [, off, ttl] = p.entry.split(':');
    Object.assign(p, { entry: 'limit', limitOff: +off, limitTtl: +ttl });
  }
  const ex = p.exit ?? 'base';
  let m: RegExpMatchArray | null;
  if ((m = ex.match(/^be([\d.]+)$/))) p.be = +m[1];
  else if ((m = ex.match(/^trail([\d.]+)$/))) p.trail = +m[1];
  else if ((m = ex.match(/^atr([\d.]+)$/))) { p.stopMode = 'atr'; p.stopAtr = +m[1]; }
  else if ((m = ex.match(/^h(\d+)$/))) p.hold = +m[1];
  else if ((m = ex.match(/^nostop-h(\d+)$/))) { p.noStop = true; p.hold = +m[1]; }
  else if (ex !== 'base') throw new Error('bad exit ' + ex);
  RESOLVED.set(p0, p);
  return p;
}

function finalize(s: S, b: NB, p: P) {
  const prev = s.bars.at(-1);
  s.bars.push(b);
  const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l;
  s.atrN++;
  s.atr = s.atrN <= 14 ? s.atr + (tr - s.atr) / s.atrN : (s.atr * 13 + tr) / 14;
  if (prev) {
    const ch = b.c - prev.c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    s.rsiN++;
    if (s.rsiN <= p.rsiLen) { s.ag += g / p.rsiLen; s.al += l / p.rsiLen; }
    else { s.ag = (s.ag * (p.rsiLen - 1) + g) / p.rsiLen; s.al = (s.al * (p.rsiLen - 1) + l) / p.rsiLen; }
    s.rsi.push(s.rsiN >= p.rsiLen ? (s.al === 0 ? (s.ag === 0 ? 50 : 100) : 100 - 100 / (1 + s.ag / s.al)) : NaN);
  } else s.rsi.push(NaN);
}

const has = (tags: string[], t: P['tags']) =>
  t === 'all' ? true : t === 'liqidx' ? tags.includes('liquid') || tags.includes('index') : tags.includes(t);

const strategy: Strategy<P> = {
  name: 'r2_rsi',
  universe(ctx: DayContext, p0: P) {
    const p = eff(p0);
    return Object.values(ctx.meta).filter((m) => has(m.tags, p.tags) && m.open >= p.minPrice).map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p0: P): Signal[] {
    const p = eff(p0);
    const cands: { sig: Signal; score: number }[] = [];
    const rel = ctx.minute - OPEN;
    const boundary = rel % p.bar === 0;
    const doneK = rel / p.bar - 1; // bucket that has just completed (when on a boundary)
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, curK: -1, bars: [], pv: 0, vol: 0, ag: 0, al: 0, rsiN: 0, rsi: [], atr: 0, atrN: 0 }));
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const k = Math.floor((ctx.minuteOf(b.t) - OPEN) / p.bar);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (s.cur && s.curK !== k) { finalize(s, s.cur, p); s.cur = undefined; }
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curK = k; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      if (!boundary) continue;
      if (!(s.cur && s.curK === doneK)) continue; // no fresh completed N-bar
      finalize(s, s.cur, p);
      s.cur = undefined;

      if (rel < p.startMin || ctx.minute > p.lastEntry) continue;
      if (ctx.open.has(sym) || (!p.reentry && ctx.traded.has(sym))) continue;
      const n = s.bars.length;
      if (n < 3) continue;
      const r1 = s.rsi[n - 1], r0 = s.rsi[n - 2];
      if (!Number.isFinite(r1)) continue;
      const last = s.bars[n - 1];
      const close = last.c;
      const hi = 100 - p.lo;
      let side: 'long' | 'short' | undefined;
      let score = 0;
      const rev = p.sig.startsWith('rev');
      if (p.sig === 'rev-now') {
        if (r1 < p.lo) side = 'long'; else if (r1 > hi) side = 'short';
        score = side === 'long' ? p.lo - r1 : r1 - hi;
      } else {
        if (!Number.isFinite(r0)) continue;
        if (p.sig === 'rev-turn') {
          if (r0 < p.lo && r1 > r0 && last.c > last.o) side = 'long';
          else if (r0 > hi && r1 < r0 && last.c < last.o) side = 'short';
          score = side === 'long' ? p.lo - r0 : r0 - hi;
        } else if (p.sig === 'rev-cross') {
          if (r0 < p.lo && r1 >= p.lo) side = 'long';
          else if (r0 > hi && r1 <= hi) side = 'short';
          score = side === 'long' ? p.lo - r0 : r0 - hi;
        } else if (p.sig === 'mom-cross') {
          if (r0 <= hi && r1 > hi) side = 'long';
          else if (r0 >= p.lo && r1 < p.lo) side = 'short';
          score = side === 'long' ? r1 - hi : p.lo - r1;
        } else {
          if (r0 > hi && r1 > r0 && last.c > last.o) side = 'long';
          else if (r0 < p.lo && r1 < r0 && last.c < last.o) side = 'short';
          score = side === 'long' ? r1 - hi : p.lo - r1;
        }
      }
      if (!side) continue;
      if (p.side !== 'both' && p.side !== side) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      if (p.vwapSide === 'with' && (side === 'long' ? close < vwap : close > vwap)) continue;
      if (p.vwapSide === 'against' && (side === 'long' ? close > vwap : close < vwap)) continue;

      const atr = s.atr;
      if (!(atr > 0)) continue;
      const long = side === 'long';
      const ref = p.entry === 'limit' ? (long ? close - p.limitOff * atr : close + p.limitOff * atr) : close;
      let stop: number;
      if (p.stopMode === 'swing') {
        const sw = s.bars.slice(-p.swing);
        stop = long ? Math.min(...sw.map((b) => b.l)) - p.stopAtr * atr : Math.max(...sw.map((b) => b.h)) + p.stopAtr * atr;
      } else stop = long ? ref - p.stopAtr * atr : ref + p.stopAtr * atr;
      stop = long ? Math.min(stop, ref * (1 - p.minRiskPct / 100)) : Math.max(stop, ref * (1 + p.minRiskPct / 100));
      const risk = long ? ref - stop : stop - ref;
      if (!(risk > 0)) continue;
      let targetR: number | undefined = p.tgt > 0 ? p.tgt : undefined;
      if (p.tgt < 0 && rev) {
        const rew = long ? vwap - ref : ref - vwap;
        if (!(rew / risk >= 0.5)) continue; // not enough room back to the mean
        targetR = rew / risk;
      }
      cands.push({
        score,
        sig: {
          symbol: sym, side, stop, targetR,
          breakevenAtR: p.be || undefined, trailR: p.trail || undefined,
          exitMinute: p.hold ? ctx.minute + p.hold * p.bar : undefined,
          noStop: p.noStop || undefined,
          entryLimit: p.entry === 'limit' ? Math.round(ref * 100) / 100 : undefined,
          limitTtl: p.entry === 'limit' ? p.limitTtl : undefined,
          tag: `${p.sig}-${side}`,
        },
      });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

const BASE = {
  minPrice: [5], startMin: [30], lastEntry: [15 * 60 + 15], vwapSide: ['none'],
  stopMode: ['swing'], swing: [3], stopAtr: [0.25], minRiskPct: [0.3], noStop: [false],
  be: [0], trail: [0], side: ['both'], entry: ['market'], limitOff: [0], limitTtl: [5], reentry: [true],
};

export default {
  strategy,
  // Run 1 grid (576): sig x4, bar [2,5,10], rsiLen [6,14], lo [15,25], tags [liqidx,gap], tgt [1,2,-1], hold [0,6], risk 100.
  // Run 2 (shaped by run 1's full-period ranking: 5-min bars, short RSI, liquid+index looked least bad).
  //   (576): sig x4, bar [3,5], rsiLen [4,6,9], lo [10,15,20], tags liqidx, swing [2,4], tgt [2,-1], vwapSide [none,against].
  // Run 3: execution and account rules on three cores picked from runs 1-2's full-period ranking (two reversion,
  // one momentum): market vs limit entries, daily loss limit / max trades / max concurrent on and off.
  //   (120): core x3, entry [market, limit:0:3, limit:0:10, limit:0.3:5, limit:0.3:15], risk 100,
  //   dailyLossLimit [300,0] (dollars; default = 3 x risk), maxTrades [3,0], maxConcurrent [2,0].
  // Run 4: exits and risk tiers (default limits) on the reversion core (shaped by runs 1-3's full-period ranking).
  //   (240): core [rev-cross:5:6:15:{1,2,4,0}, rev-cross:5:9:20:-1], exit [base,be1,trail1,atr1.5,h6,nostop-h6],
  //   entry [market, limit:0:3], risk [50,100,200,500].
  // Run 5: robustness of the rev-cross neighbourhood (is the best area a plateau or a spike?).
  grid: {
    ...BASE,
    sig: ['rev-cross'],
    bar: [4, 5, 6],
    rsiLen: [5, 6, 7, 8],
    lo: [12, 15, 18, 21],
    tgt: [2, -1],
    tags: ['liqidx'],
    swing: [2],
    entry: ['limit:0:3'],
    'rule.riskPerTrade': [200],
  },
};
