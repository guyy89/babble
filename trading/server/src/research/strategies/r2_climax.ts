// r2_climax — climactic bar reversal: fade a bar with extreme range AND volume (relative to the stock's own
// recent bars) at the end of an extended move, once the reversal is confirmed; stop beyond the climax extreme.
//
// Bars are aggregated into `barMin`-minute buckets (aligned to 09:30). A completed bucket is a CLIMAX when
//   range ≥ rMult × avg range and volume ≥ vMult × avg volume of the previous `look` buckets (≥ 6 needed),
//   it moves with the trend (up-climax: close > open; down-climax: close < open),
//   the move into it is extended: climax extreme − lowest low (highest high) of the last `look` buckets ≥ ext × daily ATR,
//   and (if `hod`) its extreme is a new session high/low.
// Confirmation (`confirm`):
//   tail — the climax bucket itself closes in its reversing 40% (a rejection tail): enter at the next open;
//   mid  — within `within` buckets a bucket closes beyond the climax midpoint (against the climax);
//   body — within `within` buckets a bucket closes beyond the climax open (engulfs the climax body).
// A bucket trading beyond the climax extreme before confirmation cancels the setup.
// Stop (`stop`): ext:k = beyond the extreme since the climax + k × climax range; atr:k = signal close ± k × daily ATR.
// Target (`tgt`): r:x = fixed R; vwap:f = f × distance to session VWAP in R (0.5..6R, skipped below 0.5R); none.
// Entry (`entry`): mkt | lim:o:ttl = LIMIT o × climax range better than the signal close (sell higher / buy lower).
// noStop sizes from the stop but exits only by target / time (`holdMin`) / flatten.
// Look-ahead: universe uses meta + dailyBefore only; onMinute folds in closed 1-minute bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;
  win: string;
  direction: 'both' | 'long' | 'short' | 'fade-gap';
  barMin: number;
  look: number;
  clx: string; // "rMult:vMult"
  ext: number;
  hod: boolean;
  confirm: 'tail' | 'mid' | 'body';
  within: number;
  stop: string;
  tgt: string;
  entry: string;
  noStop: boolean;
  breakevenAtR: number;
  trailR: number;
  holdMin: number;
  xp?: string;        // exit preset (see XP), overrides stop/tgt/breakevenAtR/trailR/noStop/holdMin
  reentry?: boolean;  // allow another trade in a symbol after the previous one closed (default: one per day)
}

interface Bk { o: number; h: number; l: number; c: number; v: number }
interface Clx { dir: 1 | -1; idx: number; o: number; h: number; l: number; ext: number; range: number; score: number }
interface S {
  seen: number;
  atr: number;
  pv: number; vol: number; vwap: number;
  cur?: Bk; curKey: number;
  bks: Bk[];
  sesHi: number; sesLo: number;
  clx?: Clx;
  fired?: { sig: Signal; score: number }; // signal produced by the bucket that just completed
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

// Exit presets (param `xp`, '' = use the individual exit params). Bundles exits so a grid does not cross them all.
const XP: Record<string, Partial<P>> = {
  base: { stop: 'ext:0.1', tgt: 'r:3', breakevenAtR: 0, trailR: 0, noStop: false, holdMin: 0 },
  be1: { stop: 'ext:0.1', tgt: 'r:3', breakevenAtR: 1, trailR: 0, noStop: false, holdMin: 0 },
  wide: { stop: 'ext:0.4', tgt: 'r:3', breakevenAtR: 0, trailR: 0, noStop: false, holdMin: 0 },
  atr: { stop: 'atr:0.15', tgt: 'r:3', breakevenAtR: 0, trailR: 0, noStop: false, holdMin: 0 },
  trail: { stop: 'ext:0.1', tgt: 'none', breakevenAtR: 0, trailR: 1.5, noStop: false, holdMin: 0 },
  time30: { stop: 'ext:0.1', tgt: 'r:3', breakevenAtR: 0, trailR: 0, noStop: false, holdMin: 30 },
  nostop60: { stop: 'ext:0.1', tgt: 'r:3', breakevenAtR: 0, trailR: 0, noStop: true, holdMin: 60 },
};

function mk(p0: P, minute: number, sym: string, close: number, vwap: number, atr: number, c: Clx, tag: string): Signal | undefined {
  const p: P = p0.xp ? { ...p0, ...XP[p0.xp] } : p0;
  const side = c.dir === 1 ? 'short' : 'long';
  const dir = side === 'long' ? 1 : -1;
  const [sMode, sX] = spec(p.stop);
  const [tMode, tX] = spec(p.tgt);
  const [eMode, eOff, eTtl] = spec(p.entry);
  const ref = eMode === 'lim' ? close - dir * eOff * c.range : close;
  const stop = sMode === 'ext' ? c.ext - dir * sX * c.range : ref - dir * sX * atr;
  const risk = (ref - stop) * dir;
  if (!(risk > 0)) return undefined;
  let targetR: number | undefined;
  if (tMode === 'vwap') {
    const d = (vwap - ref) * dir;
    const tr = (tX * d) / risk;
    if (!(tr >= 0.5)) return undefined;
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

/** Process one completed bucket: maintain the climax setup and return a signal if it confirms now. */
function onBucket(p: P, s: S, b: Bk, minute: number, sym: string, ctx: MinuteContext): void {
  s.fired = undefined;
  const bks = s.bks;
  const idx = bks.length;
  const [w0, w1] = win(p.win);
  const rel = minute - OPEN;
  const inWin = rel >= w0 && rel <= w1;
  const gapUp = ctx.meta[sym].gapPct > 0;
  const allow = (dir: 1 | -1) => {
    // dir = climax direction; we trade against it.
    if (p.direction === 'both') return true;
    if (p.direction === 'short') return dir === 1;
    if (p.direction === 'long') return dir === -1;
    return gapUp ? dir === 1 : dir === -1; // fade-gap: fade up-climaxes on gap-ups, down-climaxes on gap-downs
  };

  // 1. Existing setup: invalidation / confirmation.
  const c = s.clx;
  if (c && p.confirm !== 'tail') {
    if (idx - c.idx > p.within || (c.dir === 1 ? b.h > c.ext : b.l < c.ext)) s.clx = undefined;
    else {
      const lvl = p.confirm === 'mid' ? (c.h + c.l) / 2 : c.o;
      if (c.dir === 1 ? b.c < lvl : b.c > lvl) {
        s.clx = undefined;
        if (inWin) {
          const sig = mk(p, minute, sym, b.c, s.vwap, s.atr, c, c.dir === 1 ? 'clx-short' : 'clx-long');
          if (sig) s.fired = { sig, score: c.score };
        }
      }
    }
  }

  // 2. Is this bucket a climax?
  const n = Math.min(p.look, bks.length);
  if (n >= 6) {
    let rs = 0, vs = 0, lo = Infinity, hi = -Infinity;
    for (let i = bks.length - n; i < bks.length; i++) {
      const x = bks[i];
      rs += x.h - x.l; vs += x.v;
      if (x.l < lo) lo = x.l;
      if (x.h > hi) hi = x.h;
    }
    const [rM, vM] = spec(p.clx).slice(1) as [number, number];
    const range = b.h - b.l;
    const rr = range / (rs / n), vr = b.v / (vs / n);
    if (range > 0 && rr >= rM && vr >= vM) {
      const up = b.c > b.o, dn = b.c < b.o;
      const extUp = Math.max(b.h, hi) - Math.min(lo, b.l) >= p.ext * s.atr && b.h >= hi;
      const extDn = Math.max(b.h, hi) - Math.min(lo, b.l) >= p.ext * s.atr && b.l <= lo;
      let dir: 1 | -1 | 0 = 0;
      if (up && extUp && (!p.hod || b.h >= s.sesHi)) dir = 1;
      else if (dn && extDn && (!p.hod || b.l <= s.sesLo)) dir = -1;
      if (dir && allow(dir)) {
        const cl: Clx = { dir, idx, o: b.o, h: b.h, l: b.l, ext: dir === 1 ? b.h : b.l, range, score: Math.min(rr, 10) * Math.min(vr, 20) };
        if (p.confirm === 'tail') {
          const pos = (b.c - b.l) / range; // 0 = closed at low
          if ((dir === 1 ? pos <= 0.4 : pos >= 0.6) && inWin && !s.fired) {
            const sig = mk(p, minute, sym, b.c, s.vwap, s.atr, cl, dir === 1 ? 'clx-short' : 'clx-long');
            if (sig) s.fired = { sig, score: cl.score };
          }
        } else if (!s.fired) s.clx = cl;
      }
    }
  }
  // Note: with the up-climax requirement close > open, a tail climax closes in the lower 40% but above its open.
  bks.push(b);
  if (b.h > s.sesHi) s.sesHi = b.h;
  if (b.l < s.sesLo) s.sesLo = b.l;
}

const strategy: Strategy<P> = {
  name: 'r2_climax',
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
    const rel = ctx.minute - OPEN;
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms || rel < 30 || rel % 30 === 0) { syms = Object.keys(ctx.meta).filter((x) => ctx.bars(x).length > 0); ctx.state.set('__syms', syms); }
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: atrFor(ctx, sym), pv: 0, vol: 0, vwap: NaN, curKey: -1, bks: [], sesHi: -Infinity, sesLo: Infinity };
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
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; s.curKey = key; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; s.cur.v += b.v; }
        // Bucket complete exactly at this bar's end (aligned to 09:30): close it now so the signal is not delayed.
        if (bm + 1 === OPEN + (key + 1) * p.barMin) { onBucket(p, s, s.cur, bm + 1, sym, ctx); fired = s.fired; s.cur = undefined; }
      }
      if (!fired || (!p.reentry && ctx.traded.has(sym)) || ctx.open.has(sym)) continue;
      // Only act on a bucket that completed with the bar that closed just before this minute (no stale signals).
      const last = bars.at(-1);
      if (!last || ctx.minuteOf(last.t) !== ctx.minute - 1) continue;
      out.push(fired);
    }
    return out.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// wf run 1 (288 configs: direction both/fade-gap, barMin 1/5, clx 2:3/3:4, ext 0.4/0.8, confirm tail/mid/body,
//   stop ext:0.1/0.5, tgt r:1.5/r:3/vwap:1, market, risk 100): WF −16.5R, 31 trades. Full-period best region:
//   1-min bars, clx 2:3, ext 0.8, tight stop, 3R target (only ~+12R on 79 trades at best).
// wf run 2 — SHAPED by run-1 full-period ranking (which includes the later test months; selection bias noted):
//   universe gap vs all, thresholds/extension around that region, hod on/off, market vs limit entry.
// wf run 2 (256 configs): WF −1.6R, 34 trades, t −0.18. Full-period best +34R / 46 trades (1-min, clx 2:3, ext 1.2,
//   hod off, confirm mid, ext:0.1 stop, 3R, market). 'all' = 'gap' (liquid names never reach ext ≥ 0.8 ATR); limit entries
//   and tail confirmation never rank near the top.
// wf run 3 — SHAPED by run-2 full-period ranking: fix the trigger near that region and vary exits (presets), risk tiers
//   and the max-trades limit (on/off). Market entries.
// wf run 3 (224 configs): WF +0.5R on only 14 test trades (t 0.09). Risk tier and maxTrades 3/0 change nothing
//   (≤ 46 trades in 6 months, limits never bind); 'base' (ext:0.1 stop, 3R) and 'atr' exits rank top; BE/trail/time/
//   no-stop exits are worse. The binding problem is trade count, so:
// wf run 4 — SHAPED by runs 1–3: loosen the trigger (extension, thresholds, re-entries) to raise trade count, test a
//   small limit pullback vs market, and the max-losses rule on/off.
// wf run 4 (96 configs): WF +6.2R, 53 trades, PF 1.12, t 0.43 (FAIL: PF, trades, t, concentration). Full period:
//   extension is the key filter — ext 0.6: −16R/238 trades; ext 0.9: +34R/134; ext 1.2: +35R/61. Limit (0.1×range pullback)
//   is below market; maxLosses 2/0 identical.
// wf run 5 (FINAL) — SHAPED by runs 1–4 (incl. full-period results that overlap the test months): extension 0.9–1.5,
//   two thresholds, market vs limit, two exits, risk tiers 100/500, maxConcurrent 2 vs 0 (no limit).
export default {
  strategy,
  grid: {
    universe: ['gap'], minGap: [3], win: ['10-360'],
    direction: ['both'],
    barMin: [1], look: [20],
    clx: ['c:2:3', 'c:1.8:2.5'],
    ext: [0.9, 1.05, 1.2, 1.5],
    hod: [false],
    confirm: ['mid'],
    within: [3],
    stop: ['ext:0.1'], tgt: ['r:3'],
    entry: ['mkt', 'lim:0.1:2'],
    noStop: [false], breakevenAtR: [0], trailR: [0], holdMin: [0],
    xp: ['base', 'atr'],
    reentry: [true],
    'rule.riskPerTrade': [100, 500],
    'rule.maxConcurrent': [2, 0],
  },
};
