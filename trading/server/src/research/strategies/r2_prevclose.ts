// r2_prevclose — overreaction reversion in LIQUID large caps and index ETFs.
//
// A liquid name (tag liquid/index) that has moved an unusually large amount from a reference price, measured in
// 14-day daily ATR (from dailyBefore, known at 09:30), is faded back toward the reference / VWAP.
//   ref:  pc   — yesterday's close;  open — today's open;  both — the smaller of the two stretches must qualify
//   k:    the day's extreme must be ≥ k ATR from the reference, and the signal close still ≥ 0.7·k ATR away
//   stall: "no follow-through" — at least `stall` closed bars since the day's extreme was set (0 = off)
//   confirm: the signal bar closes back toward the reference (red bar below the previous close for a short)
// Entry (`entry`):
//   mkt         — market at the next bar's open
//   lim:o:ttl   — LIMIT at the signal close shifted o ATR further into the stretch (sell higher / buy lower)
//   lvl:x:ttl   — resting LIMIT at the stretched level ref ± (k + x)·ATR, placed as soon as the close is ≥ k ATR
//                 away (no stall/confirm needed: the limit itself is the "stretched level" entry)
// Stop (`stop`): ext:a = beyond the day's extreme (or the limit, if further) + a ATR;  atr:a = entry ± a ATR.
// Target (`tgt`): ref:f = f × distance back to the reference (prevClose for ref=both);  vwap:f = f × distance to
//   session VWAP;  r:x = fixed R;  none. Price-based targets are converted to R (skip if < 0.3R; capped at 8R).
// noStop: size from the stop but exit only by target/time/flatten. holdMin: time exit after N minutes.
// maxSig: signals per symbol per day (a cancelled limit can be re-placed while < maxSig).
// Look-ahead: universe uses meta only; ATR from dailyBefore; onMinute folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'liq' | 'idx' | 'stocks' | 'liqnogap';
  ref: 'pc' | 'open' | 'both';
  k: number;
  stall: number;
  confirm: boolean;
  win: string;
  dir: 'both' | 'long' | 'short';
  entry: string;
  stop: string;
  tgt: string;
  noStop: boolean;
  holdMin: number;
  breakevenAtR: number;
  trailR: number;
  maxSig: number;
  /** Exit preset; overrides tgt/noStop/holdMin/breakevenAtR/trailR when set (see EXITS). */
  exit?: string;
}

interface S {
  seen: number;
  atr: number;
  pv: number; vol: number; vwap: number;
  hi: number; lo: number; hiIdx: number; loIdx: number;
  prev?: Bar; last?: Bar;
  n: number;
  sigs: number;
  wasOpen: boolean;
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

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 5) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}
const atrCache = new Map<string, number>();
function atrFor(ctx: DayContext, sym: string): number {
  const key = ctx.date + '|' + sym;
  let v = atrCache.get(key);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(key, v); }
  return v;
}

// Exit presets (wf run 3+): one key per exit style so the grid doesn't multiply redundant combinations.
const EXITS: Record<string, Partial<P>> = {
  r2: { tgt: 'r:2', noStop: false, holdMin: 0, breakevenAtR: 0, trailR: 0 },
  r3: { tgt: 'r:3', noStop: false, holdMin: 0, breakevenAtR: 0, trailR: 0 },
  ref1: { tgt: 'ref:1', noStop: false, holdMin: 0, breakevenAtR: 0, trailR: 0 },
  be1r2: { tgt: 'r:2', noStop: false, holdMin: 0, breakevenAtR: 1, trailR: 0 },
  trail1: { tgt: 'none', noStop: false, holdMin: 0, breakevenAtR: 0, trailR: 1 },
  time60: { tgt: 'none', noStop: false, holdMin: 60, breakevenAtR: 0, trailR: 0 },
  nostop60: { tgt: 'none', noStop: true, holdMin: 60, breakevenAtR: 0, trailR: 0 },
  nostopRef: { tgt: 'ref:1', noStop: true, holdMin: 0, breakevenAtR: 0, trailR: 0 },
};
const effCache = new WeakMap<P, P>();
function eff(p: P): P {
  let q = effCache.get(p);
  if (!q) { q = p.exit ? { ...p, ...EXITS[p.exit] } : p; if (p.exit && !EXITS[p.exit]) throw new Error('unknown exit ' + p.exit); effCache.set(p, q); }
  return q;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

const strategy: Strategy<P> = {
  name: 'r2_prevclose',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        const liq = m.tags.includes('liquid') || m.tags.includes('index');
        if (!liq || !(m.open > 0) || !(m.prevClose > 0)) return false;
        if (p.uni === 'idx') return m.tags.includes('index') || ['IWM', 'IVV', 'SMH', 'DIA', 'VOO'].includes(m.symbol);
        if (p.uni === 'stocks') return !m.tags.includes('index') && !['IWM', 'IVV', 'SMH', 'DIA', 'VOO'].includes(m.symbol);
        if (p.uni === 'liqnogap') return !m.tags.includes('gap');
        return true;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p0: P): Signal[] {
    const p = eff(p0);
    const rel = ctx.minute - OPEN;
    const [w0, w1] = win(p.win);
    const [eMode, eX, eTtl] = spec(p.entry);
    const [sMode, sX] = spec(p.stop);
    const [tMode, tX] = spec(p.tgt);
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms || rel < 30 || rel % 30 === 0) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: atrFor(ctx, sym), pv: 0, vol: 0, vwap: NaN, hi: -Infinity, lo: Infinity, hiIdx: -1, loIdx: -1, n: 0, sigs: 0, wasOpen: false };
        ctx.state.set(sym, s);
      }
      if (!(s.atr > 0)) { s.seen = bars.length; continue; }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        s.vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        if (b.h > s.hi) { s.hi = b.h; s.hiIdx = s.n; }
        if (b.l < s.lo) { s.lo = b.l; s.loIdx = s.n; }
        s.prev = s.last; s.last = b; s.n++;
      }
      // Count orders that actually reached the book (pending limit or position), not signals the harness dropped.
      const isOpen = ctx.open.has(sym);
      if (isOpen && !s.wasOpen) s.sigs++;
      s.wasOpen = isOpen;
      if (ctx.traded.has(sym) && s.sigs === 0) s.sigs = 1;
      if (rel < w0 || rel > w1) continue;
      if (isOpen || s.sigs >= p.maxSig || !s.last || !s.prev) continue;
      const meta = ctx.meta[sym];
      const atr = s.atr, b = s.last, pr = s.prev;
      // Stretch of the close / of the day's extreme above (up) and below (dn) the reference, in ATR.
      const refUp = p.ref === 'pc' ? meta.prevClose : p.ref === 'open' ? meta.open : Math.max(meta.prevClose, meta.open);
      const refDn = p.ref === 'pc' ? meta.prevClose : p.ref === 'open' ? meta.open : Math.min(meta.prevClose, meta.open);
      const tgtRef = p.ref === 'open' ? meta.open : meta.prevClose;
      const upExt = (s.hi - refUp) / atr, dnExt = (refDn - s.lo) / atr;
      const upC = (b.c - refUp) / atr, dnC = (refDn - b.c) / atr;

      let side: 'long' | 'short' | undefined;
      let score = 0;
      if (eMode === 'lvl') {
        if (p.dir !== 'long' && upC >= p.k) { side = 'short'; score = upC; }
        else if (p.dir !== 'short' && dnC >= p.k) { side = 'long'; score = dnC; }
      } else {
        const stallUp = p.stall <= 0 || s.n - 1 - s.hiIdx >= p.stall;
        const stallDn = p.stall <= 0 || s.n - 1 - s.loIdx >= p.stall;
        if (p.dir !== 'long' && upExt >= p.k && upC >= 0.7 * p.k && stallUp && (!p.confirm || (b.c < pr.c && b.c < b.o))) { side = 'short'; score = upC; }
        else if (p.dir !== 'short' && dnExt >= p.k && dnC >= 0.7 * p.k && stallDn && (!p.confirm || (b.c > pr.c && b.c > b.o))) { side = 'long'; score = dnC; }
      }
      if (!side) continue;
      const dir = side === 'long' ? 1 : -1;
      // Entry reference price.
      let entryRef = b.c;
      if (eMode === 'lim') entryRef = b.c - dir * eX * atr;
      else if (eMode === 'lvl') entryRef = side === 'short' ? refUp + (p.k + eX) * atr : refDn - (p.k + eX) * atr;
      entryRef = r2(entryRef);
      let stop: number;
      if (sMode === 'ext') stop = side === 'short' ? Math.max(s.hi, entryRef) + sX * atr : Math.min(s.lo, entryRef) - sX * atr;
      else stop = entryRef - dir * sX * atr;
      const risk = (entryRef - stop) * dir;
      if (!(risk > 0)) continue;
      let targetR: number | undefined;
      if (tMode === 'ref' || tMode === 'vwap') {
        const lvl = tMode === 'ref' ? tgtRef : s.vwap;
        const d = (lvl - entryRef) * dir;
        if (!(d > 0)) continue;
        const tr = (tX * d) / risk;
        if (tr < 0.3) continue;
        targetR = Math.min(tr, 8);
      } else if (tMode === 'r') targetR = tX;
      const exitMinute = p.holdMin ? ctx.minute + p.holdMin : undefined;
      if (p.noStop && !exitMinute && targetR === undefined) continue;
      const sig: Signal = {
        symbol: sym, side, stop, targetR, tag: `${side}-${p.ref}`,
        breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute, noStop: p.noStop || undefined,
      };
      if (eMode !== 'mkt') { sig.entryLimit = entryRef; sig.limitTtl = eTtl || 5; }
      cands.push({ sig, score });
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// wf run 1 (288 cfgs, WF -13.9R FAIL): pc > open, k 1.2 > 0.8, long-only and limit/level entries led full-period.
// wf run 2 (432 cfgs, WF -14.8R FAIL): monthly picks unstable; full-period leaders +13..+22R (k 1.0-1.4, win 5-120,
//   lvl/lim entries, r:2) — consistent with best-of-many noise.
// wf run 3 (192 cfgs, WF -2.7R, 47 trades, FAIL). Full-period leaders (k 1.4, lvl:0:60, 5-120, +24..+30R) depend on one
//   SPCX trade (+16.6R on 2026-08-05); ex-top-5 trades they are negative; shorts lose; k 1.2/1.6 neighbours much weaker.
// wf run 4 (192 cfgs, WF +5.5R, 39 trades, t 0.62, FAIL: 2/4 months, <60 trades, top trade >25%). Ex-top-5 -4.4R.
//   Risk tier and maxTrades/maxConcurrent barely change R; level-limit + time60 long-only leads full-period (+30R).
// wf run 5 (288 cfgs, WF +4.3R, 39 trades, t 0.49, FAIL: <60 trades, t<2, top trade >25%). Ex-top-5 -5.2R. Without
//   gap-tagged names (liqnogap) the best config falls from +27R to +8R; idx/open/both never in the top 20; daily loss
//   limit identical on/off. VERDICT: no robust edge — results hinge on a few outsized trades (SPCX 2026-08-05, INTC).
// wf run 5: does it generalise? universe (all liquid / liquid without gap-tagged names / index ETFs), reference
//   (prevClose / open / both), stretch 1.0 vs 1.4, daily loss limit default (3R) vs none.
export default {
  strategy,
  grid: {
    uni: ['liq', 'liqnogap', 'idx'],
    ref: ['pc', 'open', 'both'],
    k: [1.0, 1.4],
    stall: [0],
    confirm: [true],
    win: ['5-120'],
    dir: ['both', 'long'],
    entry: ['lim:0.1:10', 'lvl:0:60'],
    stop: ['atr:0.5'],
    tgt: ['none'], noStop: [false], holdMin: [0], breakevenAtR: [0], trailR: [0],
    exit: ['r2', 'time60'],
    maxSig: [1],
    'rule.riskPerTrade': [100],
    'rule.dailyLossLimit': [300, 0],
  },
};
