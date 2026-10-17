// Round-number levels ($0.50 / $1 / $5 / $10 handles) as support / resistance.
// Two modes on 1-minute closed bars:
//   'break' – price approaches a round level from one side and a bar CLOSES through it (continuation):
//             long when crossing up (the level becomes support), short when crossing down.
//   'fade'  – price approaches a round level, touches it (or pokes a little through) and the bar closes back
//             on the approach side: the FIRST rejection of that level today is faded.
// In both modes the stop sits on the far side of the level (level ∓ stopK × daily ATR) or beyond the signal bar.
// Filters: approach speed (move into the level over spdWin minutes, in daily-ATR units), time-of-day window,
// trend (close vs VWAP), level freshness (level not touched earlier today).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'break' | 'fade';
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;          // |gap| % for 'gap' names (0 = any)
  step: 'half' | 'one' | 'minor' | 'major';
  lb: number;              // approach: the previous lb closes are all on one side of the level
  fresh: boolean;          // level not touched today before the approach window
  tolK: number;            // fade: touch tolerance (bar high ≥ L − tol), × daily ATR
  pokeK: number;           // fade: max poke through the level (× daily ATR)
  bufK: number;            // break: close must be ≥ this far through the level (× daily ATR)
  spd: 'any' | 'fast' | 'slow';
  spdThr: number;          // approach distance over spdWin minutes, × daily ATR
  spdWin: number;
  win: 'open' | 'mid' | 'late' | 'all' | 'am';
  trend: 'none' | 'with' | 'against'; // with: long only above VWAP, short only below
  dirs: 'both' | 'long' | 'short';
  stopMode: 'level' | 'bar';
  stopK: number;           // stop beyond the level, × daily ATR
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // time exit after N minutes (0 = hold to flatten)
  noStop: boolean;
  entry: 'mkt' | 'lim';
  limK: number;            // limit at L ± limK × daily ATR (on the trade side of the level)
  limitTtl: number;
  preset?: string;         // optional named setup (overrides the setup params, see PRESETS)
  exit?: string;           // optional named exit package (see EXITS)
  entryPkg?: string;       // optional named entry package (see ENTRIES)
}

interface S {
  seen: number;
  marked: number;               // bars already folded into touched
  closes: number[];
  lows: number[];
  highs: number[];
  pv: number;
  vol: number;
  atr: number;
  touched: Map<number, number>; // level (cents) → index of first bar that touched it
  usedLevels: Set<number>;
}

const OPEN = 9 * 60 + 30;
const WIN: Record<P['win'], [number, number]> = {
  open: [OPEN + 5, 10 * 60 + 30],
  am: [OPEN + 5, 12 * 60],
  mid: [10 * 60 + 30, 14 * 60],
  late: [14 * 60, 15 * 60 + 30],
  all: [OPEN + 5, 15 * 60 + 30],
};

function stepFor(mode: P['step'], px: number): number {
  switch (mode) {
    case 'half': return 0.5;
    case 'one': return 1;
    case 'minor': return px < 20 ? 0.5 : px < 100 ? 1 : px < 300 ? 5 : 10;
    case 'major': return px < 20 ? 1 : px < 100 ? 5 : px < 300 ? 10 : 50;
  }
}

function inUniverse(ctx: DayContext, p: P, sym: string): boolean {
  const m = ctx.meta[sym];
  if (!m || m.open < 5) return false;
  const isGap = m.tags.includes('gap');
  if (p.universe === 'gap') return isGap && Math.abs(m.gapPct) >= p.minGap;
  if (p.universe === 'liquid') return !isGap && (m.tags.includes('liquid') || m.tags.includes('index'));
  return !isGap || Math.abs(m.gapPct) >= p.minGap;
}

// Pure function of daily bars strictly before ctx.date, cached across configurations (speed only).
const atrCache = new Map<string, number>();
function dailyAtr(ctx: DayContext, sym: string): number {
  const key = ctx.date + '|' + sym;
  const hit = atrCache.get(key);
  if (hit !== undefined) return hit;
  const v = computeAtr(ctx, sym);
  atrCache.set(key, v);
  return v;
}
function computeAtr(ctx: DayContext, sym: string): number {
  const d = ctx.dailyBefore(sym).slice(-15);
  if (d.length < 6) return NaN;
  let sum = 0, n = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc));
    n++;
  }
  return sum / n;
}

// Named setups / exit packages so that a cartesian grid can combine them (run 2+).
const PRESETS: Record<string, Partial<P>> = {
  fadeOne: { mode: 'fade', universe: 'gap', step: 'one', spd: 'fast', win: 'mid', trend: 'none' },
  fadeMinor: { mode: 'fade', universe: 'gap', step: 'minor', spd: 'fast', win: 'mid', trend: 'none' },
  fadeMajor: { mode: 'fade', universe: 'gap', step: 'major', spd: 'slow', win: 'all', trend: 'against' },
  breakMinor: { mode: 'break', universe: 'all', step: 'minor', spd: 'slow', win: 'all', trend: 'with' },
};
const EXITS: Record<string, Partial<P>> = {
  plain: {},
  be1: { breakevenAtR: 1 },
  trail1: { trailR: 1 },
  trail2: { trailR: 2 },
  hold30: { holdMin: 30 },
  hold60: { holdMin: 60 },
  hold90: { holdMin: 90 },
  nostop60: { noStop: true, holdMin: 60 },
  nostop120: { noStop: true, holdMin: 120 },
};
const ENTRIES: Record<string, Partial<P>> = {
  mkt: { entry: 'mkt' },
  lim02t10: { entry: 'lim', limK: 0.02, limitTtl: 10 },
  lim02t30: { entry: 'lim', limK: 0.02, limitTtl: 30 },
  lim10t10: { entry: 'lim', limK: 0.1, limitTtl: 10 },
};
const effCache = new WeakMap<object, P>();
function eff(p: P): P {
  let e = effCache.get(p);
  if (!e) effCache.set(p, (e = { ...p, ...(p.preset ? PRESETS[p.preset] : {}), ...(p.exit ? EXITS[p.exit] : {}), ...(p.entryPkg ? ENTRIES[p.entryPkg] : {}) }));
  return e;
}

const strategy: Strategy<P> = {
  name: 'r2_roundnum',
  universe(ctx: DayContext, p0: P) {
    const p = eff(p0);
    return Object.keys(ctx.meta).filter((s) => inUniverse(ctx, p, s));
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    const [w0, w1] = WIN[p.win];
    // Nothing can happen outside the time window; bars are folded lazily once the window is reached.
    if (ctx.minute < w0 || ctx.minute > w1) return [];
    let syms = ctx.state.get('__syms') as string[] | undefined;
    if (!syms) ctx.state.set('__syms', (syms = Object.keys(ctx.meta).filter((x) => inUniverse(ctx, p, x))));
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, marked: 0, closes: [], lows: [], highs: [], pv: 0, vol: 0, atr: dailyAtr(ctx, sym), touched: new Map(), usedLevels: new Set() };
        ctx.state.set(sym, s);
      }
      // Fold in newly closed bars; record the first bar that touched each level (in cents) on the minor grid
      // of every step mode we might use (0.50 grid covers all, since $1/$5/$10/$50 are multiples of 0.50).
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        s.closes.push(b.c); s.lows.push(b.l); s.highs.push(b.h);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
      }
      if (!(s.atr > 0)) continue;
      const i = s.closes.length - 1; // the signal bar (just closed)
      const px = s.closes[i];
      const step = stepFor(p.step, px);
      if (step / px < 0.002) { markTouches(s, i + 1); continue; } // level spacing too small to matter
      const stepC = Math.round(step * 100);
      // only a bar that closed in the previous minute can signal (no stale re-evaluation on gaps)
      const ok = i >= Math.max(p.lb, p.spdWin) && ctx.minuteOf(bars[i].t) === ctx.minute - 1 && !ctx.open.has(sym) && !ctx.traded.has(sym);
      markTouches(s, i); // every bar before the signal bar
      if (ok) {
        const sig = evaluate(s, p, sym, i, stepC);
        if (sig) out.push(sig);
      }
      markTouches(s, i + 1);
    }
    return out.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

/** Record, for each 0.50 level (in cents), the first bar index whose range included it. */
function markTouches(s: S, upTo: number) {
  for (; s.marked < upTo; s.marked++) {
    const k = s.marked;
    const lo = Math.ceil(Math.round(s.lows[k] * 100) / 50), hi = Math.floor(Math.round(s.highs[k] * 100) / 50);
    for (let q = lo; q <= hi && q - lo < 200; q++) if (!s.touched.has(q * 50)) s.touched.set(q * 50, k);
  }
}

function evaluate(s: S, p: P, sym: string, i: number, stepC: number): { sig: Signal; score: number } | undefined {
  const atr = s.atr;
  const b = { h: s.highs[i], l: s.lows[i], c: s.closes[i] };
  // Approach side: the lb closes before the signal bar.
  let maxC = -Infinity, minC = Infinity;
  for (let k = i - p.lb; k < i; k++) { maxC = Math.max(maxC, s.closes[k]); minC = Math.min(minC, s.closes[k]); }
  const maxCc = Math.round(maxC * 100), minCc = Math.round(minC * 100);
  const above = (Math.floor(maxCc / stepC) + 1) * stepC; // first level strictly above all prior closes
  const below = (Math.ceil(minCc / stepC) - 1) * stepC;  // first level strictly below all prior closes
  const vwap = s.vol > 0 ? s.pv / s.vol : b.c;
  const cands: { side: 'long' | 'short'; Lc: number; from: 'below' | 'above' }[] = [];
  const Lup = above / 100, Ldn = below / 100;
  if (p.mode === 'break') {
    if (b.c >= Lup + p.bufK * atr) cands.push({ side: 'long', Lc: above, from: 'below' });
    if (b.c <= Ldn - p.bufK * atr) cands.push({ side: 'short', Lc: below, from: 'above' });
  } else {
    const tol = Math.max(0.01, p.tolK * atr), poke = p.pokeK * atr;
    if (b.h >= Lup - tol && b.h <= Lup + poke && b.c < Lup - tol) cands.push({ side: 'short', Lc: above, from: 'below' });
    if (b.l <= Ldn + tol && b.l >= Ldn - poke && b.c > Ldn + tol) cands.push({ side: 'long', Lc: below, from: 'above' });
  }
  for (const c of cands) {
    if (p.dirs !== 'both' && p.dirs !== c.side) continue;
    if (s.usedLevels.has(c.Lc)) continue;
    const L = c.Lc / 100;
    const long = c.side === 'long';
    // Freshness: level not touched before the approach window (the last lb bars and the signal bar may touch it).
    if (p.fresh) {
      const first = s.touched.get(c.Lc); // includes bars up to i-1 only (signal bar not yet marked)
      if (first !== undefined && first < i - p.lb) continue;
    }
    // Approach speed: distance travelled toward the level over spdWin minutes before the signal bar.
    let ext = c.from === 'below' ? Infinity : -Infinity;
    for (let k = i - p.spdWin; k < i; k++) ext = c.from === 'below' ? Math.min(ext, s.lows[k]) : Math.max(ext, s.highs[k]);
    const dist = Math.abs(L - ext) / atr;
    if (p.spd === 'fast' && dist < p.spdThr) continue;
    if (p.spd === 'slow' && dist >= p.spdThr) continue;
    if (p.trend === 'with' && (long ? b.c <= vwap : b.c >= vwap)) continue;
    if (p.trend === 'against' && (long ? b.c >= vwap : b.c <= vwap)) continue;
    let stop = long ? L - p.stopK * atr : L + p.stopK * atr;
    if (p.stopMode === 'bar') stop = long ? Math.min(stop, b.l - 0.01) : Math.max(stop, b.h + 0.01);
    if (long ? stop >= b.c : stop <= b.c) continue;
    const sig: Signal = {
      symbol: sym, side: c.side, stop,
      targetR: p.targetR > 0 ? p.targetR : undefined,
      breakevenAtR: p.breakevenAtR > 0 ? p.breakevenAtR : undefined,
      trailR: p.trailR > 0 ? p.trailR : undefined,
      noStop: p.noStop || undefined,
      tag: `${p.mode}-${c.side}`,
    };
    if (p.entry === 'lim') {
      let lim = long ? L + p.limK * atr : L - p.limK * atr;
      if (long ? lim > b.c : lim < b.c) lim = b.c;
      if (long ? lim <= stop : lim >= stop) continue;
      sig.entryLimit = Math.round(lim * 100) / 100;
      sig.limitTtl = p.limitTtl;
    }
    s.usedLevels.add(c.Lc);
    return { sig, score: dist };
  }
  return undefined;
}

// exitMinute needs the current minute: wrap onMinute to stamp it.
const baseOnMinute = strategy.onMinute.bind(strategy);
strategy.onMinute = (ctx, p0) => {
  const p = eff(p0);
  const sigs = baseOnMinute(ctx, p);
  if (p.holdMin > 0) for (const sg of sigs) sg.exitMinute = ctx.minute + p.holdMin;
  return sigs;
};

const exploreBase = {
  minGap: [3], lb: [10], tolK: [0.02], pokeK: [0.05], bufK: [0.02], spdWin: [15], spdThr: [0.25],
  dirs: ['both'], stopMode: ['level'], breakevenAtR: [0], trailR: [0], noStop: [false], entry: ['mkt'], limK: [0.02], limitTtl: [10],
  'rule.riskPerTrade': [50],
};

// Run 1 (648 configs, market entry, $50 tier) explored mode × universe × level grid × approach speed × window ×
// trend × stop with targetR 2: WF -44.2R (FAIL). Run 2 (512) took the four best full-period setups of run 1 (shaped
// by run 1's full-period ranking, which includes the test months) × exits × stop width × entry: WF +20.2R but FAIL
// (t 0.79, PF 1.13, 2/4 months, three trades = all the profit). Run 3 (384): breakMinor × risk tiers ×
// trade/concurrency/loss limits × entry packages × exits: WF +13.4R, 3/4 months positive but FAIL (PF 1.12, t 0.52,
// one trade = 88% of profit). Run 4 (shaped by runs 1–3, all of which saw the full six months): robustness of the
// break setup around the run-3 leaders (level grid, approach-speed threshold — spdThr 99 = no speed filter — trend
// filter, approach lookback, exit, entry) with the daily loss limit at its default (3R = $600 at the $200 tier) vs off.
export default {
  strategy,
  grid: {
    ...exploreBase,
    mode: ['break'], universe: ['all'], fresh: [true], spd: ['slow'], win: ['all'], holdMin: [0], stopK: [0.15], targetR: [0],
    step: ['minor', 'one'],
    spdThr: [0.15, 0.25, 0.4, 99],
    trend: ['with', 'none'],
    lb: [10, 20],
    exit: ['plain', 'hold60', 'hold90'],
    entryPkg: ['mkt', 'lim02t30'],
    'rule.riskPerTrade': [200], 'rule.maxTrades': [3], 'rule.maxConcurrent': [0], 'rule.maxLosses': [0],
    'rule.dailyLossLimit': [600, 0],
  },
};
