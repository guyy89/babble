// r2_voldiv — price/volume divergence exhaustion: a stock pushes to a new session high (low) but the leg that made
// it carries markedly less volume (or a weaker up/down-volume balance) than the leg that made the previous high
// (low); fade it once price closes back inside (below the prior high / below the high bar's low).
//
// Bars are aggregated into `barMin`-minute buckets (aligned to 09:30). Swing legs (up side; the down side mirrors):
//   a LEG runs from the low where it started to its highest high. When a bucket makes a new session high after a
//   pullback of at least `minPb` × daily ATR from the previous high, the previous leg is finalised
//   (start..previous high) and a new leg starts at the pullback low.
//   Leg stats: rate = average volume per bucket; delta = (up-bucket vol − down-bucket vol) / total vol.
// Divergence (`div` = "mode:x"):
//   vol:x   — new leg rate ≤ x × previous leg rate;
//   delta:x — new leg delta ≤ previous leg delta − x (buying pressure weaker by x);
//   both:x  — vol:x and new delta < previous delta.
// The previous leg must have started at/after `legFrom` minutes after the open (avoids comparing against the open).
// A divergent new high arms a setup (re-evaluated on every further new high; a non-divergent extension cancels it).
// Trigger (`trig`) within `within` buckets of the latest high (the high bucket itself counts):
//   prior — a bucket closes back below the previous leg's high;  bar — closes below the high bucket's low.
// `vwapF`: none | ext — for a short the signal close must still be above session VWAP (long: below).
// Stop (`stop`): ext:k = beyond the extreme + k × ATR; atr:k = signal close ± k × daily ATR.
// Target (`tgt`): r:x | vwap:f (f × distance to VWAP in R, 0.5..6R, skipped below 0.5R) | none.
// Entry (`entry`): mkt | lim:o:ttl = LIMIT o × ATR better than the signal close.
// noStop: sized from signal close ± nsAtr × daily ATR (not the tight structural stop); exits only by target / time (`holdMin`) / flatten.
// Look-ahead: universe uses meta + dailyBefore only; onMinute folds in closed 1-minute bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  win: string; // "from-to" minutes after the open
  direction: 'both' | 'long' | 'short' | 'fade-gap';
  barMin: number;
  minPb: number;
  div: string;
  legFrom: number;
  trig: 'prior' | 'bar';
  within: number;
  vwapF: 'none' | 'ext';
  stop: string;
  tgt: string;
  entry: string;
  noStop: boolean;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
  nsAtr: number; // noStop: size from signal close ± nsAtr × daily ATR (not the tight structural stop)
}

interface Bk { o: number; h: number; l: number; c: number; v: number; m: number }
interface Leg { rate: number; delta: number; ext: number }
interface Side {
  ext: number; extIdx: number;       // session extreme (high for up side, low for down side) and its bucket
  back: number; backIdx: number;     // most adverse price since the extreme (pullback low for up side)
  legStart: number;                  // bucket index where the current leg began
  prev?: Leg;                        // finalised previous leg
  setup?: { idx: number; prior: number; ext: number; barLvl: number; score: number };
}
interface S {
  seen: number;
  atr: number;
  pv: number; vol: number; vwap: number;
  cur?: Bk; curKey: number;
  bks: Bk[];
  up: Side; dn: Side;
  fired?: { sig: Signal; score: number };
}

const OPEN = 9 * 60 + 30;
const cache = new Map<string, [string, number, number]>();
function spec(s: string): [string, number, number] {
  let v = cache.get(s);
  if (!v) { const [m, a, b] = s.split(':'); v = [m, Number(a ?? 0), Number(b ?? 0)]; cache.set(s, v); }
  return v;
}
const winCache = new Map<string, [number, number]>();
function win(s: string): [number, number] {
  let v = winCache.get(s);
  if (!v) { const [a, b] = s.split('-').map(Number); v = [a, b]; winCache.set(s, v); }
  return v;
}

const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const k = ctx.date + '|' + sym;
  let v = atrCache.get(k);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(k, v); }
  return v;
}
function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const newSide = (): Side => ({ ext: NaN, extIdx: -1, back: NaN, backIdx: -1, legStart: 0 });

/** Volume rate and signed-volume balance of buckets a..b (inclusive), oriented by dir (+1 up side, −1 down side). */
function legStats(bks: Bk[], a: number, b: number, dir: 1 | -1): { rate: number; delta: number } {
  let v = 0, d = 0;
  for (let i = a; i <= b; i++) {
    const x = bks[i];
    v += x.v;
    if (x.c > x.o) d += x.v; else if (x.c < x.o) d -= x.v;
  }
  return { rate: v / (b - a + 1), delta: v > 0 ? (dir * d) / v : 0 };
}

function mk(p: P, minute: number, sym: string, close: number, vwap: number, atr: number, dir: 1 | -1, ext: number, score: number): Signal | undefined {
  // dir = direction of the exhausted move; we trade against it.
  const side = dir === 1 ? 'short' : 'long';
  const sd = side === 'long' ? 1 : -1;
  if (p.vwapF === 'ext' && (sd === -1 ? !(close > vwap) : !(close < vwap))) return undefined;
  const [sMode, sX] = spec(p.stop);
  const [tMode, tX] = spec(p.tgt);
  const [eMode, eOff, eTtl] = spec(p.entry);
  const ref = eMode === 'lim' ? close - sd * eOff * atr : close;
  const stop = p.noStop ? ref - sd * (p.nsAtr || 0.5) * atr : sMode === 'ext' ? ext - sd * sX * atr : ref - sd * sX * atr;
  const risk = (ref - stop) * sd;
  if (!(risk > 0)) return undefined;
  let targetR: number | undefined;
  if (tMode === 'vwap') {
    const d = (vwap - ref) * sd;
    const tr = (tX * d) / risk;
    if (!(tr >= 0.5)) return undefined;
    targetR = Math.min(tr, 6);
  } else if (tMode === 'r') targetR = tX;
  const exitMinute = p.holdMin ? minute + p.holdMin : undefined;
  const sig: Signal = {
    symbol: sym, side, stop, targetR, tag: side,
    breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute, noStop: p.noStop || undefined,
  };
  if (eMode === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = eTtl || 5; }
  return sig;
}

/** Update one side's swing/leg state with bucket b (index idx); may set s.fired. */
function sideStep(p: P, s: S, sd: Side, dir: 1 | -1, b: Bk, idx: number, minute: number, sym: string, inWin: boolean, allowed: boolean) {
  const hiOf = (x: Bk) => (dir === 1 ? x.h : x.l);
  const loOf = (x: Bk) => (dir === 1 ? x.l : x.h);
  const beyond = (a: number, ref: number) => (dir === 1 ? a > ref : a < ref);
  const [dMode, dX] = spec(p.div);
  if (!Number.isFinite(sd.ext)) {
    sd.ext = hiOf(b); sd.extIdx = idx; sd.legStart = idx; sd.back = NaN; sd.backIdx = -1;
    return;
  }
  if (beyond(hiOf(b), sd.ext)) {
    // New extreme. Was there a real pullback since the last one? Then finalise the previous leg.
    if (sd.backIdx > sd.extIdx && (dir === 1 ? sd.ext - sd.back : sd.back - sd.ext) >= p.minPb * s.atr) {
      const st = legStats(s.bks, sd.legStart, sd.extIdx, dir);
      const startMin = s.bks[sd.legStart].m - OPEN;
      sd.prev = startMin >= p.legFrom ? { rate: st.rate, delta: st.delta, ext: sd.ext } : undefined;
      sd.legStart = sd.backIdx;
      sd.setup = undefined;
    }
    sd.ext = hiOf(b); sd.extIdx = idx; sd.back = NaN; sd.backIdx = -1;
    if (sd.prev) {
      const cur = legStats(s.bks, sd.legStart, idx, dir);
      let ok = false;
      if (dMode === 'vol') ok = cur.rate <= dX * sd.prev.rate;
      else if (dMode === 'delta') ok = cur.delta <= sd.prev.delta - dX;
      else ok = cur.rate <= dX * sd.prev.rate && cur.delta < sd.prev.delta;
      sd.setup = ok ? { idx, prior: sd.prev.ext, ext: sd.ext, barLvl: loOf(b), score: sd.prev.rate / Math.max(1, cur.rate) } : undefined;
    }
  } else if (!Number.isFinite(sd.back) || beyond(sd.back, loOf(b))) {
    sd.back = loOf(b); sd.backIdx = idx;
  }
  // Trigger.
  const su = sd.setup;
  if (!su) return;
  if (idx - su.idx > p.within) { sd.setup = undefined; return; }
  const lvl = p.trig === 'prior' ? su.prior : su.barLvl;
  const back = dir === 1 ? b.c < lvl : b.c > lvl;
  if (back && (p.trig === 'prior' || idx > su.idx)) {
    sd.setup = undefined;
    sd.prev = undefined; // one shot per pair of legs
    if (inWin && allowed && !s.fired) {
      const sig = mk(p, minute, sym, b.c, s.vwap, s.atr, dir, sd.ext, su.score);
      if (sig) s.fired = { sig, score: su.score };
    }
  }
}

function onBucket(p: P, s: S, b: Bk, minute: number, sym: string, ctx: MinuteContext): void {
  s.fired = undefined;
  const idx = s.bks.length;
  s.bks.push(b);
  const [w0, w1] = win(p.win);
  const rel = minute - OPEN;
  const inWin = rel >= w0 && rel <= w1;
  const gapUp = ctx.meta[sym].gapPct > 0;
  const allow = (dir: 1 | -1) => {
    if (p.direction === 'both') return true;
    if (p.direction === 'short') return dir === 1;
    if (p.direction === 'long') return dir === -1;
    return gapUp ? dir === 1 : dir === -1;
  };
  sideStep(p, s, s.up, 1, b, idx, minute, sym, inWin, allow(1));
  sideStep(p, s, s.dn, -1, b, idx, minute, sym, inWin, allow(-1));
}

const strategy: Strategy<P> = {
  name: 'r2_voldiv',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return !m.tags.includes('index');
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    let syms = ctx.state.get('__syms') as string[] | undefined;
    const rel = ctx.minute - OPEN;
    if (!syms || rel < 30 || rel % 30 === 0) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: atrFor(ctx, sym), pv: 0, vol: 0, vwap: NaN, curKey: -1, bks: [], up: newSide(), dn: newSide() };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      let fired: { sig: Signal; score: number } | undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        s.vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        const key = Math.floor((bm - OPEN) / p.barMin);
        if (s.cur && key !== s.curKey) { onBucket(p, s, s.cur, OPEN + (s.curKey + 1) * p.barMin, sym, ctx); fired = s.fired; s.cur = undefined; }
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, m: OPEN + key * p.barMin }; s.curKey = key; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; s.cur.v += b.v; }
        if (bm + 1 === OPEN + (key + 1) * p.barMin) { onBucket(p, s, s.cur, bm + 1, sym, ctx); fired = s.fired; s.cur = undefined; }
      }
      if (!fired || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      const last = bars.at(-1);
      if (!last || ctx.minuteOf(last.t) !== ctx.minute - 1) continue;
      out.push(fired);
    }
    return out.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// Design (exploration on 2026-04-16..2026-06-15 only, scratch runAll, no limits): 10-min buckets, 'bar' trigger,
//   vol:0.75 divergence, tight ext stop and market entries were best; gap-only universe, 'prior' trigger, 2-min bars,
//   legFrom 30, limit entries and noStop/hold-60 variants were worse. Edge in the design window ~+0.1R/trade, mostly M1/longs.
// wf run 1: core variants (universe, bucket, threshold, exits, entry type, maxTrades 3 vs unlimited), risk 100.
//   Result: WF +1.3R, t 0.09, PF 0.99, 210 trades, stress −12.1R → FAIL. maxTrades 3 vs 0 identical (maxLosses/maxConcurrent bind).
// wf run 2 (planned from the design window, not from run-1 test months): risk tiers × limits × entry type × noStop
//   (noStop sized from 0.5 × daily ATR, held to target/flatten), universe all, 10-min buckets, vol:0.75.
//   Result: WF −10.4R, t −0.6, PF 0.87, 216 trades, stress −18.3R → FAIL. Full-period best +23R/333 trades (0.07R/trade).
// wf run 3 (pre-planned remaining dimension; small): daily loss limit OFF + maxTrades unlimited, universe all vs liquid,
//   vol vs delta divergence, 2R vs 3R, risk 100 vs 500. Not tuned toward run-1/2 test months.
//   Result: WF −10.9R, t −0.65, PF 0.90, 226 trades, stress −28.0R → FAIL; liquid-only clearly negative (−17..−42R).
// Verdict: no edge. Stopped after 3 wf runs.
export default {
  strategy,
  grid: {
    universe: ['all', 'liquid'], minGap: [3], win: ['30-330'], direction: ['both'],
    barMin: [10], minPb: [0.1], div: ['vol:0.75', 'delta:0.2'], legFrom: [0], trig: ['bar'], within: [3], vwapF: ['none'],
    stop: ['ext:0.05'], tgt: ['r:2', 'r:3'], entry: ['mkt'],
    noStop: [false], nsAtr: [0.5], breakevenAtR: [0], trailR: [2], holdMin: [0],
    'rule.riskPerTrade': [100, 500], 'rule.dailyLossLimit': [0], 'rule.maxTrades': [0],
  },
};
