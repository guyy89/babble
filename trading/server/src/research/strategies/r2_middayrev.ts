// r2_middayrev — midday reversal: fade a strong, extended morning move once momentum stalls in the quiet midday.
//
// Extension (`ext`, "<ref>:<x>"): the day's extreme (HOD for a short, LOD for a long) is at least x × 14-day daily
//   ATR away from the reference — ref = vwap (session VWAP now) or open (today's 09:30 open). At the signal bar the
//   close must still be ≥ `keep` × that threshold beyond the reference (not already reverted).
// Stall: the extreme must be at least `stale` minutes old (no new HOD/LOD), and the just-completed `barMin` bar must
//   trigger (`trig`): red = closes against the move and beyond the previous bar's close; lh = lower high (higher low)
//   than the previous bar plus a close against the move; brk = close beyond the low (high) of the previous 3 bars.
// Window (`win`): "a-b" minutes after 09:30 in which signals may fire (e.g. 120-210 = 11:30–13:00).
// Stop (`stop`): ext:k = beyond the day extreme + k ATR; atr:k = signal close ± k ATR.
// Target (`tgt`): vwap:f = f × distance to VWAP (in R, capped 0.5..6); r:x = fixed R; none.
// Entry (`entry`): mkt | lim:o:ttl = LIMIT at signal close shifted o ATR in our favour (sell higher / buy lower).
// Exits: holdMin (time exit, minutes after the signal; 0 = flatten), breakevenAtR, trailR, noStop.
// One trade per symbol per day. Look-ahead: universe uses meta + dailyBefore only; onMinute folds closed bars.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  direction: 'both' | 'long' | 'short' | 'with-gap';
  win: string;
  barMin: number;
  ext: string;
  keep: number;
  stale: number;
  trig: 'red' | 'lh' | 'brk';
  stop: string;
  tgt: string;
  entry: string;
  noStop: boolean;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
}

interface Bk { o: number; h: number; l: number; c: number }
interface S {
  seen: number;
  pv: number; vol: number; vwap: number;
  atr: number; open: number;
  hod: number; lod: number; hodM: number; lodM: number;
  cur?: Bk; curIdx: number;
  done: Bk[]; // completed buckets (last few)
}

const OPEN = 9 * 60 + 30;
const specCache = new Map<string, [string, number, number]>();
function spec(s: string): [string, number, number] {
  let v = specCache.get(s);
  if (!v) { const [m, a, b] = s.split(':'); v = [m, Number(a ?? 0), Number(b ?? 0)]; specCache.set(s, v); }
  return v;
}
const winCache = new Map<string, [number, number]>();
function win(s: string): [number, number] {
  let v = winCache.get(s);
  if (!v) { const [a, b] = s.split('-').map(Number); v = [a, b]; winCache.set(s, v); }
  return v;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}
// Cached per (date, symbol) across configurations; uses daily bars strictly before the date.
const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const k = ctx.date + '|' + sym;
  let v = atrCache.get(k);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(k, v); }
  return v;
}

function mk(p: P, minute: number, sym: string, close: number, atr: number, s: S, side: 'long' | 'short', tag: string): Signal | undefined {
  const [sMode, sX] = spec(p.stop);
  const [tMode, tX] = spec(p.tgt);
  const [eMode, eOff, eTtl] = spec(p.entry);
  const dir = side === 'long' ? 1 : -1;
  const ref = eMode === 'lim' ? close - dir * eOff * atr : close;
  const stop = sMode === 'ext' ? (side === 'long' ? s.lod - sX * atr : s.hod + sX * atr) : ref - dir * sX * atr;
  const risk = (ref - stop) * dir;
  if (!(risk > 0)) return undefined;
  let targetR: number | undefined;
  if (tMode === 'vwap') {
    const tr = (tX * (s.vwap - ref) * dir) / risk;
    if (tr < 0.5) return undefined;
    targetR = Math.min(tr, 6);
  } else if (tMode === 'r') targetR = tX;
  const exitMinute = p.holdMin ? minute + p.holdMin : undefined;
  if (p.noStop && !exitMinute && targetR === undefined) return undefined;
  const sig: Signal = {
    symbol: sym, side, stop, targetR, tag,
    breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute, noStop: p.noStop || undefined,
  };
  if (eMode === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = eTtl || 5; }
  return sig;
}

const strategy: Strategy<P> = {
  name: 'r2_middayrev',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.tags.includes('index')) return false;
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    const [w0, w1] = win(p.win);
    if (rel > w1 + 1) return [];
    const [rMode, rX] = spec(p.ext);
    const cands: { sig: Signal; score: number }[] = [];
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms || rel < 30 || rel % 30 === 0) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, pv: 0, vol: 0, vwap: NaN, atr: atrFor(ctx, sym), open: NaN, hod: -Infinity, lod: Infinity, hodM: 0, lodM: 0, curIdx: -1, done: [] };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      let completed = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const m = ctx.minuteOf(b.t);
        if (Number.isNaN(s.open)) s.open = b.o;
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        s.vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        if (b.h > s.hod) { s.hod = b.h; s.hodM = m; }
        if (b.l < s.lod) { s.lod = b.l; s.lodM = m; }
        const idx = Math.floor((m - OPEN) / p.barMin);
        if (idx !== s.curIdx) {
          if (s.cur) { s.done.push(s.cur); if (s.done.length > 4) s.done.shift(); }
          s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curIdx = idx;
        } else { const c = s.cur!; c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; }
        // The bucket is complete when its last minute has closed.
        if ((m - OPEN + 1) % p.barMin === 0) { s.done.push(s.cur!); if (s.done.length > 4) s.done.shift(); s.cur = undefined; completed = true; }
      }
      if (!completed || rel < w0 || rel > w1) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || s.done.length < 4) continue;
      const b = s.done[s.done.length - 1], pr = s.done[s.done.length - 2];
      const ref = rMode === 'open' ? s.open : s.vwap;
      const unit = rX * s.atr;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allowShort = p.direction === 'both' || p.direction === 'short' || (p.direction === 'with-gap' && gapUp);
      const allowLong = p.direction === 'both' || p.direction === 'long' || (p.direction === 'with-gap' && !gapUp);
      const prev3 = s.done.slice(-4, -1);
      // Short: extended up-move that has stalled.
      if (allowShort && s.hod - ref >= unit && b.c - ref >= p.keep * unit && ctx.minute - 1 - s.hodM >= p.stale) {
        const ok = p.trig === 'red' ? b.c < b.o && b.c < pr.c
          : p.trig === 'lh' ? b.h < pr.h && b.c < pr.c
          : b.c < Math.min(...prev3.map((x) => x.l));
        if (ok) { const sig = mk(p, ctx.minute, sym, b.c, s.atr, s, 'short', 'mr-short'); if (sig) cands.push({ sig, score: (s.hod - ref) / s.atr }); }
        continue;
      }
      if (allowLong && ref - s.lod >= unit && ref - b.c >= p.keep * unit && ctx.minute - 1 - s.lodM >= p.stale) {
        const ok = p.trig === 'red' ? b.c > b.o && b.c > pr.c
          : p.trig === 'lh' ? b.l > pr.l && b.c > pr.c
          : b.c > Math.max(...prev3.map((x) => x.h));
        if (ok) { const sig = mk(p, ctx.minute, sym, b.c, s.atr, s, 'long', 'mr-long'); if (sig) cands.push({ sig, score: (ref - s.lod) / s.atr }); }
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// Design (M1–M2 only, scratch runAll): g0 288 cfgs (universe/window/extension/stall/trigger/target), g1 256 cfgs
//   (exits, stall age), g2 384 cfgs (direction, stop size, trailing, market vs limit). Shorts (fading extended
//   up-moves) carried nearly all of the M1–M2 profit; 90–210 min window, atr:0.2–0.3 stop, no target looked best.
// wf run 1 (192 cfgs): that area, risk 100, default account limits -> WF +35.3R, t 1.29, FAIL (t, top trade 27%).
// Further design on M1–M2 only (g3/g4: 64+16+256+576 cfgs): risk tier ~irrelevant (50 slightly worse, min commission);
//   maxTrades never binds, maxLosses/daily loss do; all limits OFF triples trades and stayed positive. vwap:1.1 >
//   vwap:0.8; atr:0.2 stop best; breakeven/trailing hurt; no target or wide target; 120-min time exit and noStop+120
//   min good; limit entries slightly worse than market. Not shaped by wf1 results.
// wf run 2: limits OFF, risk 100, that area incl. noStop/time exits and market vs limit.
//   -> WF +29.1R, 4/4 months positive, PF 1.35, 82 trades, stress +7.0R, t 1.18: FAIL (t only).
// wf run 3: risk tiers 50–500 × maxLosses 2/0 × maxConcurrent 2/0 (daily loss limit off, maxTrades off) × entry market
//   vs two limits, exits from the M1–M2 design (atr:0.2 stop, no target, 120-min time exit, stop vs noStop).
//   Grid chosen from the design-period results, not from the wf2 ranking.
//   -> WF +47.7R, 4/4 months positive (M5 only +1.9R), PF 1.38, 74 trades, stress +36.6R, t 1.72: FAIL (t, top trade
//   33%). Risk tier and maxLosses/maxConcurrent changed full-period R by ~1–2R. Stopped after 3 wf runs (more would
//   be tuning toward the walk-forward). Verdict: suggestive, not proven; right-tailed, noStop worst trade −10R.
export default {
  strategy,
  grid: {
    universe: ['all'], minGap: [3], direction: ['both'],
    win: ['90-210'], barMin: [5],
    ext: ['vwap:1.1'], keep: [0.5], stale: [15, 30], trig: ['lh', 'brk'],
    stop: ['atr:0.2'], tgt: ['none'], entry: ['mkt', 'lim:0.03:3', 'lim:0.1:10'],
    noStop: [false, true], breakevenAtR: [0], trailR: [0], holdMin: [120],
    'rule.riskPerTrade': [50, 100, 200, 500],
    'rule.dailyLossLimit': [0], 'rule.maxTrades': [0], 'rule.maxLosses': [2, 0], 'rule.maxConcurrent': [2, 0],
  },
};
