// r2_failedbo: failed breakout ("trapped breakout traders").
// A key level is broken (opening-range high/low, prior-day high/low, or an established high/low of day) and
// within `maxBars` signal buckets a bucket CLOSES back inside the level; we trade the reversal back through
// the range (failed upside break → short, failed downside break → long), stop beyond the false-break extreme.
// Signal buckets are barMinutes long, aligned to 09:30, and evaluated only once complete.
// No look-ahead: universe() uses only meta; onMinute() folds closed 1-minute bars incrementally, and uses
// ctx.dailyBefore (days strictly before today) for ATR14 and prior-day high/low.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  levels: 'or' | 'pd' | 'hod' | 'all';
  orMinutes: number;          // opening range length (for 'or')
  hodAgeMin: number;          // 'hod': the broken high/low must have stood this many minutes
  barMinutes: number;         // signal bucket length (1 | 5)
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;             // |gap| % (0 = any)
  maxSymbols: number;
  direction: 'both' | 'with-gap' | 'against-gap'; // with-gap: long a failed low-break on a gap-up, etc.
  needCloseBeyond: boolean;   // the break must include a bucket CLOSE beyond the level (else a wick is enough)
  maxBars: number;            // the re-entry close must come within this many buckets of the first break bucket
  minBreakAtr: number;        // the extreme must exceed the level by ≥ this × ATR14
  maxBreakAtr: number;        // ... and by ≤ this × ATR14 (0 = off)
  reentryAtr: number;         // re-entry close must be inside the level by ≥ this × ATR14
  startMinute: number;        // first NY minute for a signal
  cutoffMinute: number;       // last NY minute for a signal
  stopMode: 'extreme' | 'atr';
  stopBufAtr: number;         // 'extreme': stop = extreme ± this × ATR14
  stopAtr: number;            // 'atr': stop = signal close ± this × ATR14
  noStop: boolean;
  targetR: number;            // 0 = none
  breakevenAtR: number;       // 0 = off
  trailR: number;             // 0 = off
  holdMinutes: number;        // time exit after the signal (0 = flatten)
  entry: 'market' | 'limitClose' | 'limitLevel';
  limitTtl: number;
  maxPerSymbol: number;       // signals per symbol per day
}

interface Brk { level: number; start: number; extreme: number; closedBeyond: boolean; kind: string }
interface Lvl { up?: number; dn?: number; upDone: boolean; dnDone: boolean; upBrk?: Brk; dnBrk?: Brk }

interface S {
  seen: number;
  atr?: number;
  pdh?: number; pdl?: number;
  orHi: number; orLo: number;
  hod: number; hodIdx: number; lod: number; lodIdx: number;
  hodBrk?: Brk; lodBrk?: Brk;
  orL: Lvl; pdL: Lvl;
  bIdx: number; bStart?: number; bo?: number; bh?: number; bl?: number; bc?: number;
  prevClose?: number;          // close of the previous completed bucket
  signals: number;
  sig?: { side: 'long' | 'short'; level: number; extreme: number; close: number; kind: string };
}

const OPEN = 9 * 60 + 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

function atr14(daily: Bar[]): number | undefined {
  if (daily.length < 15) return undefined;
  const d = daily.slice(-15);
  let sum = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    sum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc));
  }
  return sum / 14;
}

/**
 * Advance an upside-break state machine with one completed bucket. Returns a signal when the break fails.
 * `level` is the level in force before this bucket; prevClose must have been inside for a new break to start.
 */
function stepUp(brk: Brk | undefined, level: number, kind: string, b: { h: number; c: number }, idx: number, prevClose: number | undefined, p: P, atr: number):
  { brk?: Brk; fire?: Brk; done?: boolean } {
  if (!brk) {
    if (prevClose === undefined || prevClose > level) return {};
    if (!(b.h > level)) return {};
    brk = { level, start: idx, extreme: b.h, closedBeyond: b.c > level, kind };
  } else {
    brk.extreme = Math.max(brk.extreme, b.h);
    if (b.c > brk.level) brk.closedBeyond = true;
  }
  if (p.maxBreakAtr && brk.extreme - brk.level > p.maxBreakAtr * atr) return { done: true }; // a real move, not a false break
  if (idx - brk.start >= p.maxBars) return { done: true };
  const ext = brk.extreme - brk.level;
  if (b.c < brk.level - p.reentryAtr * atr && ext >= p.minBreakAtr * atr && (brk.closedBeyond || !p.needCloseBeyond)) {
    // A wick-only break bucket that closes back inside cannot have closedBeyond.
    return { fire: brk, done: true };
  }
  return { brk };
}

/** Mirror for downside breaks (negate prices). */
function stepDn(brk: Brk | undefined, level: number, kind: string, b: { l: number; c: number }, idx: number, prevClose: number | undefined, p: P, atr: number) {
  const neg = brk ? { ...brk, level: -brk.level, extreme: -brk.extreme } : undefined;
  const r = stepUp(neg, -level, kind, { h: -b.l, c: -b.c }, idx, prevClose === undefined ? undefined : -prevClose, p, atr);
  const un = (x?: Brk) => (x ? { ...x, level: -x.level, extreme: -x.extreme } : undefined);
  return { brk: un(r.brk), fire: un(r.fire), done: r.done };
}

function finalize(s: S, p: P) {
  if (s.bStart === undefined) return;
  const b = { o: s.bo!, h: s.bh!, l: s.bl!, c: s.bc! };
  const idx = s.bIdx;
  const bEnd = s.bStart + p.barMinutes; // minute at which this bucket is known
  const atr = s.atr!;
  const fires: { side: 'long' | 'short'; brk: Brk }[] = [];
  const orEnd = OPEN + p.orMinutes;

  const runLvl = (L: Lvl, kind: string, active: boolean) => {
    if (!active) return;
    if (L.up !== undefined && !L.upDone) {
      const r = stepUp(L.upBrk, L.up, kind, b, idx, s.prevClose, p, atr);
      L.upBrk = r.brk;
      if (r.done) { L.upDone = true; L.upBrk = undefined; }
      if (r.fire) fires.push({ side: 'short', brk: r.fire });
    }
    if (L.dn !== undefined && !L.dnDone) {
      const r = stepDn(L.dnBrk, L.dn, kind, b, idx, s.prevClose, p, atr);
      L.dnBrk = r.brk;
      if (r.done) { L.dnDone = true; L.dnBrk = undefined; }
      if (r.fire) fires.push({ side: 'long', brk: r.fire });
    }
  };

  // Opening range: levels fixed once the range is complete; breaks evaluated on buckets starting after it.
  if (p.levels === 'or' || p.levels === 'all') {
    if (s.bStart >= orEnd && s.orL.up === undefined && Number.isFinite(s.orHi)) { s.orL.up = s.orHi; s.orL.dn = s.orLo; }
    runLvl(s.orL, 'or', s.bStart >= orEnd);
  }
  if (p.levels === 'pd' || p.levels === 'all') runLvl(s.pdL, 'pd', true);
  if (p.levels === 'hod' || p.levels === 'all') {
    // High of day that has stood ≥ hodAgeMin minutes; one event at a time; each failure/success re-arms.
    if (s.hodBrk || (Number.isFinite(s.hod) && (idx - s.hodIdx) * p.barMinutes >= p.hodAgeMin)) {
      const r = stepUp(s.hodBrk, s.hodBrk ? s.hodBrk.level : s.hod, 'hod', b, idx, s.prevClose, p, atr);
      s.hodBrk = r.done ? undefined : r.brk;
      if (r.fire) fires.push({ side: 'short', brk: r.fire });
    }
    if (s.lodBrk || (Number.isFinite(s.lod) && (idx - s.lodIdx) * p.barMinutes >= p.hodAgeMin)) {
      const r = stepDn(s.lodBrk, s.lodBrk ? s.lodBrk.level : s.lod, 'lod', b, idx, s.prevClose, p, atr);
      s.lodBrk = r.done ? undefined : r.brk;
      if (r.fire) fires.push({ side: 'long', brk: r.fire });
    }
  }
  // Update day extremes after evaluating (the level must predate the bucket).
  if (b.h > s.hod) { s.hod = b.h; s.hodIdx = idx; }
  if (b.l < s.lod) { s.lod = b.l; s.lodIdx = idx; }
  if (s.bStart < orEnd) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
  s.prevClose = b.c;

  if (fires.length && bEnd >= p.startMinute) {
    // If several levels fail on the same bucket, the first (or > pd > hod) is used.
    const f = fires[0];
    s.sig = { side: f.side, level: f.brk.level, extreme: f.brk.extreme, close: b.c, kind: f.brk.kind };
  }
  s.bStart = undefined;
}

const strategy: Strategy<P> = {
  name: 'r2_failedbo',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && m.open >= 5)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const daily = ctx.dailyBefore(sym);
        const last = daily.at(-1);
        s = {
          seen: 0, atr: atr14(daily), pdh: last?.h, pdl: last?.l,
          orHi: -Infinity, orLo: Infinity, hod: -Infinity, hodIdx: 0, lod: Infinity, lodIdx: 0,
          orL: { upDone: false, dnDone: false }, pdL: { up: last?.h, dn: last?.l, upDone: false, dnDone: false },
          bIdx: -1, signals: 0,
        };
        ctx.state.set(sym, s);
      }
      if (!s.atr) continue;
      s.sig = undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const start = OPEN + Math.floor((bm - OPEN) / p.barMinutes) * p.barMinutes;
        if (s.bStart !== undefined && start !== s.bStart) finalize(s, p);
        if (s.bStart === undefined) { s.bStart = start; s.bIdx = (start - OPEN) / p.barMinutes; s.bo = b.o; s.bh = b.h; s.bl = b.l; s.bc = b.c; }
        else { s.bh = Math.max(s.bh!, b.h); s.bl = Math.min(s.bl!, b.l); s.bc = b.c; }
      }
      if (s.bStart !== undefined && ctx.minute >= s.bStart + p.barMinutes) finalize(s, p);
      const sig = s.sig as S['sig']; // set by finalize() during this call
      if (!sig || ctx.minute > p.cutoffMinute || ctx.minute < p.startMinute) continue;
      if (ctx.open.has(sym) || s.signals >= p.maxPerSymbol) continue;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const long = sig.side === 'long';
      if (p.direction === 'with-gap' && long !== gapUp) continue;
      if (p.direction === 'against-gap' && long === gapUp) continue;
      let stop: number;
      if (p.stopMode === 'atr') stop = long ? sig.close - p.stopAtr * s.atr : sig.close + p.stopAtr * s.atr;
      else stop = long ? sig.extreme - p.stopBufAtr * s.atr : sig.extreme + p.stopBufAtr * s.atr;
      stop = r2(stop);
      let entryLimit: number | undefined;
      if (p.entry === 'limitClose') entryLimit = r2(sig.close);
      else if (p.entry === 'limitLevel') entryLimit = r2(sig.level);
      if (entryLimit !== undefined && (long ? entryLimit <= stop : entryLimit >= stop)) continue;
      if (long ? sig.close <= stop : sig.close >= stop) continue;
      s.signals++;
      out.push({
        symbol: sym, side: sig.side, stop,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        noStop: p.noStop || undefined,
        entryLimit,
        limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        tag: `${sig.side}-${sig.kind}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    levels: ['or', 'hod', 'all'],
    orMinutes: [15],
    hodAgeMin: [30],
    barMinutes: [5],
    tags: ['liquid', 'all'],
    minGap: [0],
    maxSymbols: [12],
    direction: ['both'],
    needCloseBeyond: [false],
    maxBars: [6],
    minBreakAtr: [0.02],
    maxBreakAtr: [0.3],
    reentryAtr: [0],
    startMinute: [OPEN + 5],
    cutoffMinute: [11 * 60],
    stopMode: ['atr'],
    stopBufAtr: [0.02],
    stopAtr: [0.1, 0.2],
    noStop: [false],
    targetR: [0, 1],
    breakevenAtR: [0],
    trailR: [0],
    holdMinutes: [0],
    entry: ['market', 'limitClose'],
    limitTtl: [10],
    maxPerSymbol: [2],
    'rule.riskPerTrade': [50, 100, 200, 500],
  } as Record<string, unknown[]>,
};
