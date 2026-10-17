// r2_openrev — opening reversal: the first `win` minutes make a strong directional move that then fails.
//
// Opening move (measured on the bars of the first `win` minutes): the larger of the up-excursion (window high −
// day open) and the down-excursion (day open − window low) is the move direction; it must be ≥ `move`
// ("atr:x" = x × 14-day daily ATR from dailyBefore, "pct:x" = x % of the open). At the end of the window the move
// must still be intact: the window's last close is on the move side of the reclaim level.
// Reclaim level (`lvl`): open = day open, vwap = session VWAP, mid = midpoint of the window range.
// Trigger: the first closed bar after the window (up to `maxMin` minutes after 09:30) that closes beyond the level
// against the move → trade the reversal (an up-move that fails → short; a down-move that fails → long).
// Filters: `gapDir` any | with (opening move in the gap direction) | against; `side` both | long | short.
// Stop (`stop`): ext:k = beyond the day's extreme so far in the move direction + k × ATR; atr:k = ref ± k × ATR.
// Target (`tgt`): r:x = fixed R; opp = the opposite end of the window range (converted to R, needs ≥ 0.5R);
// none. Exits: breakevenAtR, trailR, holdMin (time exit after entry), noStop (needs holdMin or a target).
// Entry (`entry`): mkt | lim:o:ttl = LIMIT at the signal close shifted o × ATR in our favour, cancelled after ttl.
// One trade per symbol per day. Look-ahead: universe uses meta + dailyBefore only; onMinute folds in closed bars
// incrementally (ctx.bars contains only bars that closed before the decision minute).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  minPrice: number;
  maxPrice: number;
  win: number;
  move: string;
  lvl: 'open' | 'vwap' | 'mid';
  maxMin: number;
  gapDir: 'any' | 'with' | 'against';
  side: 'both' | 'long' | 'short';
  stop: string;
  tgt: string;
  entry: string;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
  noStop: boolean;
  /** Optional named bundle of the core parameters (overrides them), so a grid can cross a few cores with rules. */
  preset?: string;
}

// Cores chosen from the design period 2026-04-16..2026-06-15 only (never a walk-forward test month).
const PRESETS: Record<string, Partial<P>> = {
  A: { win: 5, move: 'atr:0.7', lvl: 'mid', side: 'both', stop: 'atr:0.3', tgt: 'none', trailR: 0 },
  B: { win: 10, move: 'atr:0.8', lvl: 'mid', side: 'short', stop: 'atr:0.3', tgt: 'r:2', trailR: 1.5 },
  C: { win: 5, move: 'atr:0.8', lvl: 'open', side: 'short', stop: 'atr:0.3', tgt: 'none', trailR: 0 },
  D: { win: 5, move: 'atr:0.3', lvl: 'open', side: 'both', stop: 'ext:0.02', tgt: 'r:1', trailR: 0 },
};
const resolved = new WeakMap<object, P>();
function res(p: P): P {
  let r = resolved.get(p);
  if (!r) { r = p.preset && PRESETS[p.preset] ? { ...p, ...PRESETS[p.preset] } : p; resolved.set(p, r); }
  return r;
}

interface S {
  seen: number;
  atr: number;
  open: number;
  pv: number; vol: number;
  hi: number; lo: number;          // day extremes so far
  wHi: number; wLo: number;        // window extremes
  dir: number;                     // +1 up-move armed, -1 down-move armed, 0 not armed
  moveSize: number;
  done: boolean;
  last?: Bar;
}

const OPEN = 9 * 60 + 30;
const specCache = new Map<string, [string, number, number]>();
function spec(s: string): [string, number, number] {
  let v = specCache.get(s);
  if (!v) {
    const [m, a, b] = s.split(':');
    v = [m, Number(a ?? 0), Number(b ?? 0)];
    specCache.set(s, v);
  }
  return v;
}

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
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

const strategy: Strategy<P> = {
  name: 'r2_openrev',
  universe(ctx: DayContext, p0: P) {
    const p = res(p0);
    return Object.values(ctx.meta)
      .filter((m) => {
        if (m.open < p.minPrice || m.open > p.maxPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return !m.tags.includes('index');
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p0: P): Signal[] {
    const p = res(p0);
    const rel = ctx.minute - OPEN;
    // Before the window has closed nothing can fire; after the deadline nothing will. Bars are folded in lazily
    // (incrementally from s.seen) starting with the first evaluated minute.
    if (rel <= p.win || rel > p.maxMin + 1) return [];
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    const [mMode, mX] = spec(p.move);
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: atrFor(ctx, sym), open: NaN, pv: 0, vol: 0, hi: -Infinity, lo: Infinity, wHi: -Infinity, wLo: Infinity, dir: 0, moveSize: 0, done: false };
        ctx.state.set(sym, s);
      }
      if (s.done) { s.seen = bars.length; continue; }
      if (!(s.atr > 0)) { s.done = true; continue; }
      let fresh = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        if (s.seen === 0) {
          if (bm !== OPEN) { s.done = true; break; } // need the true opening bar
          s.open = b.o;
        }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        if (bm < OPEN + p.win) {
          s.wHi = Math.max(s.wHi, b.h); s.wLo = Math.min(s.wLo, b.l);
          if (bm === OPEN + p.win - 1) {
            // Window complete: classify the opening move and require it to be intact.
            const up = s.wHi - s.open, dn = s.open - s.wLo;
            const dir = up >= dn ? 1 : -1;
            const size = Math.max(up, dn);
            const thr = mMode === 'atr' ? mX * s.atr : (mX / 100) * s.open;
            const gapUp = ctx.meta[sym].gapPct > 0;
            const gapOk = p.gapDir === 'any' || (p.gapDir === 'with' ? (dir > 0) === gapUp : (dir > 0) !== gapUp);
            const tradeSide = dir > 0 ? 'short' : 'long';
            const sideOk = p.side === 'both' || p.side === tradeSide;
            const level = levelOf(p.lvl, s, s.open);
            const intact = dir > 0 ? b.c > level : b.c < level;
            if (size >= thr && gapOk && sideOk && intact) { s.dir = dir; s.moveSize = size; } else s.done = true;
          }
        }
        s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l);
        s.last = b;
        fresh = bm >= OPEN + p.win;
      }
      if (s.done || !s.dir || !fresh || !s.last) continue;
      const lastMin = ctx.minuteOf(s.last.t);
      if (lastMin - OPEN >= p.maxMin) { s.done = true; continue; }
      if (ctx.traded.has(sym) || ctx.open.has(sym)) { s.done = true; continue; }
      const c = s.last.c;
      const level = levelOf(p.lvl, s, s.open);
      const failed = s.dir > 0 ? c < level : c > level;
      if (!failed) continue;
      s.done = true; // one shot per symbol: the first reclaim
      const sig = mk(p, ctx.minute, sym, c, s);
      if (sig) cands.push({ sig, score: s.moveSize / s.atr });
    }
    return cands.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

function levelOf(lvl: P['lvl'], s: S, open: number): number {
  if (lvl === 'vwap') return s.vol > 0 ? s.pv / s.vol : open;
  if (lvl === 'mid') return (s.wHi + s.wLo) / 2;
  return open;
}

function mk(p: P, minute: number, sym: string, close: number, s: S): Signal | undefined {
  const side: 'long' | 'short' = s.dir > 0 ? 'short' : 'long';
  const dir = side === 'long' ? 1 : -1;
  const [sMode, sX] = spec(p.stop);
  const [tMode, tX] = spec(p.tgt);
  const [eMode, eOff, eTtl] = spec(p.entry);
  const ref = eMode === 'lim' ? close - dir * eOff * s.atr : close;
  let stop: number;
  if (sMode === 'ext') stop = side === 'long' ? s.lo - sX * s.atr : s.hi + sX * s.atr;
  else stop = ref - dir * sX * s.atr;
  const risk = (ref - stop) * dir;
  if (!(risk > 0)) return undefined;
  let targetR: number | undefined;
  if (tMode === 'r') targetR = tX;
  else if (tMode === 'opp') {
    const tgt = side === 'long' ? s.wHi : s.wLo;
    const tr = ((tgt - ref) * dir) / risk;
    if (tr < 0.5) return undefined;
    targetR = Math.min(tr, 6);
  }
  const exitMinute = p.holdMin ? minute + p.holdMin : undefined;
  if (p.noStop && !exitMinute && targetR === undefined) return undefined;
  const sig: Signal = {
    symbol: sym, side, stop, targetR, tag: side,
    breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute, noStop: p.noStop || undefined,
  };
  if (eMode === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = eTtl || 5; }
  return sig;
}

export default {
  strategy,
  // WF run 4: no stop (size from the nominal stop) with time exits, on the four design-period cores, gap vs all names.
  grid: {
    universe: ['gap', 'all'], minGap: [3], minPrice: [5], maxPrice: [150],
    win: [5], move: ['atr:0.5'], lvl: ['open'], maxMin: [60], gapDir: ['any'], side: ['both'],
    stop: ['atr:0.3'], tgt: ['none'], entry: ['mkt'], breakevenAtR: [0], trailR: [0], holdMin: [15, 45, 90], noStop: [true],
    preset: ['A', 'B', 'C', 'D'], 'rule.riskPerTrade': [50],
  },
};
