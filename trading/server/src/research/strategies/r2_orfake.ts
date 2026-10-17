// Opening-range fakeout: price breaks one side of the opening range, fails to hold (closes back inside within
// a few minutes), then trades back inside / through the middle / through the other side. Trade the failed break
// toward the opposite side (trapped breakout traders), stop beyond the fake-break extreme.
// State is updated incrementally from newly closed bars (aggregated into barMinutes buckets).
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  orMinutes: number;          // opening range length (5/15/30)
  barMinutes: number;         // decision bar size (1 or 5), buckets aligned to the open
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;             // |gap| % for 'gap' names
  maxSymbols: number;         // gap names, largest |gap| first
  minRangePct: number;        // OR range must be at least this % of price
  maxRangePct: number;        // ... and at most this
  breakType: 'wick' | 'close';// a break = a bar trading beyond (wick) or closing beyond (close) the OR edge
  breakBuf: number;           // break must exceed the edge by this fraction of the OR range
  failBars: number;           // break must close back inside within this many minutes of the break start
  trigger: 'inside' | 'mid' | 'opp';
  trigWindow: number;         // after the failure, the trigger must happen within this many minutes
  lastSignalMinute: number;   // NY minute-of-day
  direction: 'both' | 'long' | 'short' | 'fade-gap' | 'with-gap';
  stopMode: 'extreme' | 'half' | 'range';  // fake extreme (+buffer) | halfway to it | entry ± stopRangeMult × OR range
  stopBuf: number;            // buffer beyond the extreme, fraction of OR range
  stopRangeMult: number;
  noStop: boolean;
  targetMode: 'R' | 'opp';    // fixed R | the opposite OR edge (converted to R at signal time)
  targetR: number;            // 0 = none (for 'R')
  breakevenAtR: number;       // 0 = off
  trailR: number;             // 0 = off
  holdMinutes: number;        // 0 = hold until the flatten
  entry: 'market' | 'limitClose' | 'limitPb';  // market | limit at signal close | limit pbFrac × risk better
  pbFrac: number;
  limitTtl: number;
}

type Phase = 'idle' | 'brokeUp' | 'brokeDn' | 'failedUp' | 'failedDn' | 'done';
interface S {
  seen: number; hi: number; lo: number; ready: boolean;
  bO?: number; bDone?: boolean; bH: number; bL: number; bC?: number; bStart?: number;  // current bucket
  phase: Phase; breakStart: number; failAt: number; extreme: number;
  deadUp: boolean; deadDn: boolean;
  sig?: { side: 'long' | 'short'; close: number };
}

const OPEN = 9 * 60 + 30;

const strategy: Strategy<P> = {
  name: 'r2_orfake',
  universe(ctx: DayContext, p: P) {
    const ms = Object.values(ctx.meta);
    const gap = ms.filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct)).slice(0, p.maxSymbols).map((m) => m.symbol);
    const liq = ms.filter((m) => m.tags.includes('liquid') || m.tags.includes('index')).map((m) => m.symbol);
    if (p.tags === 'gap') return gap;
    if (p.tags === 'liquid') return liq;
    return [...new Set([...gap, ...liq])];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const orEnd = OPEN + p.orMinutes;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, hi: -Infinity, lo: Infinity, ready: false, bH: -Infinity, bL: Infinity, phase: 'idle', breakStart: 0, failAt: 0, extreme: 0, deadUp: false, deadDn: false }));
      s.sig = undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        if (bm < orEnd) { s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l); continue; }
        // aggregate into buckets aligned to orEnd
        const start = orEnd + Math.floor((bm - orEnd) / p.barMinutes) * p.barMinutes;
        if (s.bStart !== start) {
          if (s.bStart !== undefined && !s.bDone) { s.bDone = true; step(s, p, s.bStart + p.barMinutes); }  // bucket missing its last bar
          s.bStart = start; s.bO = b.o; s.bH = -Infinity; s.bL = Infinity; s.bDone = false;
        }
        s.bH = Math.max(s.bH, b.h); s.bL = Math.min(s.bL, b.l); s.bC = b.c;
      }
      // a bucket is complete once the minute after its last bar has started (all its bars are closed)
      if (s.bStart !== undefined && !s.bDone && ctx.minute >= s.bStart + p.barMinutes) { s.bDone = true; step(s, p, s.bStart + p.barMinutes); }
      // step() sets s.sig, which TS can't see after the reset above
      const sig = s.sig as S['sig'];
      if (!sig || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (ctx.minute > p.lastSignalMinute) continue;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const side = sig.side;
      if (p.direction === 'long' && side !== 'long') continue;
      if (p.direction === 'short' && side !== 'short') continue;
      if (p.direction === 'fade-gap' && (side === 'long') === gapUp) continue;
      if (p.direction === 'with-gap' && (side === 'long') !== gapUp) continue;
      const range = s.hi - s.lo;
      const c = sig.close;
      const dir = side === 'long' ? 1 : -1;
      let stop: number;
      const ext = s.extreme - dir * p.stopBuf * range;
      if (p.stopMode === 'extreme') stop = ext;
      else if (p.stopMode === 'half') stop = c - (c - ext) / 2;
      else stop = c - dir * p.stopRangeMult * range;
      let entryPx = c;
      let entryLimit: number | undefined;
      if (p.entry === 'limitClose') entryLimit = c;
      else if (p.entry === 'limitPb') entryLimit = c - dir * p.pbFrac * Math.abs(c - stop);
      if (entryLimit !== undefined) entryPx = entryLimit;
      const risk = (entryPx - stop) * dir;
      if (!(risk > 0)) continue;
      let targetR: number | undefined = p.targetR || undefined;
      if (p.targetMode === 'opp') {
        const tgt = side === 'long' ? s.hi : s.lo;
        const tr = ((tgt - entryPx) * dir) / risk;
        if (!(tr > 0.3)) continue;
        targetR = tr;
      }
      out.push({
        symbol: sym, side, stop, targetR, noStop: p.noStop || undefined,
        breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        tag: `${side}`,
      });
    }
    return out;
  },
};

/** Advance the fakeout state machine on one completed bucket (closing at minute `m`). */
function step(s: S, p: P, m: number) {
  if (s.phase === 'done') return;
  const range = s.hi - s.lo;
  const mid = (s.hi + s.lo) / 2;
  const h = s.bH, l = s.bL, c = s.bC!;
  if (!s.ready) {
    s.ready = true;
    const pct = (range / mid) * 100;
    if (!(range > 0) || pct < p.minRangePct || pct > p.maxRangePct) { s.phase = 'done'; return; }
  }
  const upLvl = s.hi + p.breakBuf * range, dnLvl = s.lo - p.breakBuf * range;
  if (s.phase === 'idle') {
    const up = !s.deadUp && (p.breakType === 'wick' ? h > upLvl : c > upLvl);
    const dn = !s.deadDn && (p.breakType === 'wick' ? l < dnLvl : c < dnLvl);
    if (up && dn) return;  // outside bar both ways: ambiguous
    if (up) { s.phase = 'brokeUp'; s.breakStart = m - p.barMinutes; s.extreme = h; }
    else if (dn) { s.phase = 'brokeDn'; s.breakStart = m - p.barMinutes; s.extreme = l; }
    else return;
    // a wick break that already closed back inside in the same bucket counts as an immediate failure
    if (s.phase === 'brokeUp' && c < s.hi) { s.phase = 'failedUp'; s.failAt = m; }
    else if (s.phase === 'brokeDn' && c > s.lo) { s.phase = 'failedDn'; s.failAt = m; }
    else return;
  } else if (s.phase === 'brokeUp' || s.phase === 'brokeDn') {
    const upSide = s.phase === 'brokeUp';
    s.extreme = upSide ? Math.max(s.extreme, h) : Math.min(s.extreme, l);
    const back = upSide ? c < s.hi : c > s.lo;
    if (back && m - s.breakStart <= p.failBars) { s.phase = upSide ? 'failedUp' : 'failedDn'; s.failAt = m; }
    else if (m - s.breakStart >= p.failBars) {
      // the break held: this side is no longer a fakeout candidate
      if (upSide) s.deadUp = true; else s.deadDn = true;
      s.phase = 'idle';
      return;
    } else return;
  } else {
    // already failed: price must not exceed the fake extreme; trigger within the window
    const upSide = s.phase === 'failedUp';
    if (upSide ? h > s.extreme : l < s.extreme) {
      s.deadUp ||= upSide; s.deadDn ||= !upSide; s.phase = 'idle'; return;
    }
    if (m - s.failAt > p.trigWindow) { s.deadUp ||= upSide; s.deadDn ||= !upSide; s.phase = 'idle'; return; }
  }
  // check trigger on this bucket (phase is failedUp / failedDn)
  const upSide = s.phase === 'failedUp';
  const lvl = p.trigger === 'inside' ? (upSide ? s.hi : s.lo) : p.trigger === 'mid' ? mid : upSide ? s.lo : s.hi;
  const hit = upSide ? c < lvl : c > lvl;
  if (hit) {
    s.sig = { side: upSide ? 'short' : 'long', close: c };
    s.phase = 'done';
  }
}

export default {
  strategy,
  grid: {
    // wf run 1 (512 configs) varied: orMinutes [15,30], breakType [close,wick], failBars [15,30], trigger [mid,inside],
    //   stopMode [half,extreme], targetR [2,3], entry [market,limitClose], rule.riskPerTrade [50,500], rule.maxTrades [3,0].
    // wf run 2: the design-best family (close break → mid trigger, half stop) with the remaining dimensions:
    //   no-stop/time exits, pullback-limit entries, risk tiers 100/200, maxConcurrent on/off.
    orMinutes: [15, 30], barMinutes: [1], tags: ['liquid'], minGap: [2], maxSymbols: [10], minRangePct: [0.5], maxRangePct: [15],
    breakType: ['close'], breakBuf: [0], failBars: [15, 30], trigger: ['mid'], trigWindow: [30], lastSignalMinute: [13 * 60],
    direction: ['both'], stopMode: ['half'], stopBuf: [0.05], stopRangeMult: [0.5], noStop: [false, true],
    targetMode: ['R'], targetR: [0, 3], breakevenAtR: [0], trailR: [0], holdMinutes: [0, 60],
    entry: ['market', 'limitClose', 'limitPb'], pbFrac: [0.25], limitTtl: [10],
    'rule.riskPerTrade': [100, 200], 'rule.maxConcurrent': [2, 0],
  },
};
