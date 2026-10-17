// r2_dryup: volume dry-up pullback. N-minute buckets (aligned to 09:30) built from closed 1-minute bars.
//   Trend leg (long): within the last `look` completed buckets, the highest high H at bucket iH is preceded by a
//   lowest low Lo at bucket iL (iH - iL + 1 >= minLegBars buckets), leg size H - Lo >= legAtr x daily ATR(14).
//   Pullback: the 1..maxPb buckets after iH (none makes a new high, by construction), retracing between minRetr and
//   maxRetr of the leg, with mean pullback-bucket volume <= volRatio x mean leg-bucket volume (volRatio >= 9 = no
//   volume filter: the control). Optional VWAP side filter.
//   Trigger: the latest pullback bucket's high (low for shorts). A later 1-minute bar that breaks it ('touch': trades a
//   cent through, 'close': closes beyond) -> market entry at the next minute's open, or a LIMIT `limOff` x risk better.
//   Stop: 'pb' = beyond the pullback extreme + buffer; 'atr' = stopAtr x daily ATR from the reference price.
//   noStop: size from nsAtr x daily ATR, place no stop, exit at holdMinutes/target/close.
// No look-ahead: universe() uses only meta + dailyBefore; onMinute() folds only closed bars; a bucket [a, a+N) is
// evaluated only once ctx.minute >= a+N; a trigger is checked only on bars that closed after the setup was armed.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  tags: 'gap' | 'liquid' | 'all';
  minGap: number;
  maxSymbols: number;
  direction: 'both' | 'with-gap' | 'long';
  barMinutes: number;
  look: number;          // buckets searched for the leg (leg start .. leg end .. pullback)
  minLegBars: number;
  legAtr: number;        // min leg size in daily ATRs
  minRetr: number;
  maxRetr: number;
  maxPb: number;         // max pullback buckets
  volRatio: number;      // max mean(pb vol) / mean(leg vol); >= 9 = off
  vwap: boolean;         // long only above VWAP, short only below
  trig: 'touch' | 'close';
  startMin: number;      // earliest entry, minutes after 09:30
  endMin: number;        // latest entry
  entry: 'market' | 'limit';
  limOff: number;        // limit offset as a fraction of risk (better than reference)
  limitTtl: number;
  stopMode: 'pb' | 'atr';
  stopAtr: number;
  stopBufPct: number;
  minRiskPct: number;
  maxRiskPct: number;    // 0 = off
  targetR: number;       // 0 = none
  breakevenAtR: number;  // 0 = off
  trailR: number;        // 0 = off
  holdMinutes: number;   // 0 = off
  noStop: boolean;
  nsAtr: number;         // noStop sizing distance in daily ATRs
  maxPerSym: number;
}

interface Bk { h: number; l: number; c: number; v: number }
interface Arm { long: boolean; trig: number; pbExt: number; legScore: number }
interface S {
  seen: number; pv: number; vol: number;
  cur?: Bk; curIdx: number;
  done: Bk[];
  datr: number;
  arm?: Arm;
  fills: number;
  lastSignal: number;
}

const OPEN = 9 * 60 + 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

function dailyAtr(ctx: DayContext, sym: string): number {
  const d = ctx.dailyBefore(sym).slice(-15);
  if (d.length < 6) return NaN;
  let s = 0, n = 0;
  for (let i = 1; i < d.length; i++) {
    s += Math.max(d[i].h, d[i - 1].c) - Math.min(d[i].l, d[i - 1].c);
    n++;
  }
  return s / n;
}

function universe(ctx: DayContext, p: P): string[] {
  const ok = (t: string[]) => (p.tags === 'all' ? true : p.tags === 'gap' ? t.includes('gap') : t.includes('liquid') || t.includes('index'));
  const list = Object.values(ctx.meta)
    .filter((m) => ok(m.tags) && m.open >= 5)
    .filter((m) => !(p.tags === 'gap') || Math.abs(m.gapPct) >= p.minGap);
  list.sort((a, b) => (p.tags === 'gap' ? Math.abs(b.gapPct) - Math.abs(a.gapPct) : b.avgVolume * b.open - a.avgVolume * a.open));
  return list.slice(0, p.maxSymbols).map((m) => m.symbol);
}

/** Evaluate a dry-up pullback setup on the completed buckets; returns the armed setup or undefined. */
function setup(B: Bk[], p: P, datr: number, vwap: number, allowL: boolean, allowS: boolean): Arm | undefined {
  const j = B.length - 1;
  const w0 = Math.max(0, j - p.look);
  let best: Arm | undefined;
  for (const long of [true, false]) {
    if (long ? !allowL : !allowS) continue;
    // leg end: extreme in the window
    let iH = w0;
    for (let i = w0; i <= j; i++) if (long ? B[i].h > B[iH].h : B[i].l < B[iH].l) iH = i;
    const pb = j - iH;
    if (pb < 1 || pb > p.maxPb) continue;
    let iL = w0;
    for (let i = w0; i <= iH; i++) if (long ? B[i].l < B[iL].l : B[i].h > B[iL].h) iL = i;
    if (iH - iL + 1 < p.minLegBars) continue;
    const H = long ? B[iH].h : B[iH].l;
    const Lo = long ? B[iL].l : B[iL].h;
    const leg = Math.abs(H - Lo);
    if (!(leg >= p.legAtr * datr) || leg <= 0) continue;
    let pbExt = long ? Infinity : -Infinity;
    for (let i = iH + 1; i <= j; i++) pbExt = long ? Math.min(pbExt, B[i].l) : Math.max(pbExt, B[i].h);
    const retr = Math.abs(H - pbExt) / leg;
    if (retr < p.minRetr || retr > p.maxRetr) continue;
    if (p.volRatio < 9) {
      let lv = 0, ln = 0, pv = 0;
      for (let i = iL + 1; i <= iH; i++) { lv += B[i].v; ln++; }
      for (let i = iH + 1; i <= j; i++) pv += B[i].v;
      if (ln === 0 || lv <= 0) continue;
      if (pv / pb / (lv / ln) > p.volRatio) continue;
    }
    const c = B[j].c;
    if (p.vwap && (long ? c <= vwap : c >= vwap)) continue;
    const trig = long ? B[j].h : B[j].l;
    const score = leg / datr;
    if (!best || score > best.legScore) best = { long, trig, pbExt, legScore: score };
  }
  return best;
}

const strategy: Strategy<P> = {
  name: 'r2_dryup',
  universe,
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    const N = p.barMinutes;
    const since = ctx.minute - OPEN;
    const boundary = since % N === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, pv: 0, vol: 0, curIdx: -1, done: [], datr: dailyAtr(ctx, sym), fills: 0, lastSignal: -1 };
        ctx.state.set(sym, s);
      }
      if (!(s.datr > 0)) continue;
      let fire: { long: boolean; ref: number; pbExt: number; score: number } | undefined;
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        // trigger / invalidation on 1-minute bars closed after arming
        if (s.arm && !fire) {
          const a = s.arm;
          const hit = p.trig === 'touch' ? (a.long ? b.h >= a.trig + 0.01 - 1e-9 : b.l <= a.trig - 0.01 + 1e-9) : a.long ? b.c > a.trig : b.c < a.trig;
          const broken = a.long ? b.l < a.pbExt : b.h > a.pbExt;
          if (broken) s.arm = undefined; // pullback extended beyond its extreme: setup void
          else if (hit) { fire = { long: a.long, ref: b.c, pbExt: a.pbExt, score: a.legScore }; s.arm = undefined; }
        }
        const idx = Math.floor((bm - OPEN) / N);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        if (s.cur && idx !== s.curIdx) { s.done.push(s.cur); s.cur = undefined; }
        if (!s.cur) { s.cur = { h: b.h, l: b.l, c: b.c, v: b.v }; s.curIdx = idx; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; s.cur.v += b.v; }
      }
      // A bucket just completed: (re)evaluate the setup with its high/low as the new trigger.
      if (boundary && s.cur && s.curIdx <= since / N - 1) {
        s.done.push(s.cur); s.cur = undefined;
        if (!fire) {
          const vwap = s.vol > 0 ? s.pv / s.vol : s.done[s.done.length - 1].c;
          const gapUp = ctx.meta[sym].gapPct > 0;
          const allowL = p.direction !== 'with-gap' || gapUp;
          const allowS = p.direction === 'both' || (p.direction === 'with-gap' && !gapUp);
          s.arm = s.done.length >= 3 ? setup(s.done, p, s.datr, vwap, allowL, allowS) : undefined;
        } else s.arm = undefined;
      }
      if (!fire) continue;
      if (since < p.startMin || since > p.endMin) continue;
      if (ctx.open.has(sym) || s.fills >= p.maxPerSym) continue;
      const L = fire.long;
      const ref = fire.ref;
      let stop: number;
      if (p.noStop) stop = L ? ref - p.nsAtr * s.datr : ref + p.nsAtr * s.datr;
      else {
        const buf = (ref * p.stopBufPct) / 100;
        stop = p.stopMode === 'atr' ? (L ? ref - p.stopAtr * s.datr : ref + p.stopAtr * s.datr) : L ? fire.pbExt - buf : fire.pbExt + buf;
        const minD = (ref * p.minRiskPct) / 100;
        stop = L ? Math.min(stop, ref - minD) : Math.max(stop, ref + minD);
      }
      const dist = L ? ref - stop : stop - ref;
      if (!(dist > 0)) continue;
      if (!p.noStop && p.maxRiskPct > 0 && (dist / ref) * 100 > p.maxRiskPct) continue;
      const sig: Signal = {
        symbol: sym, side: L ? 'long' : 'short', stop: r2(stop), tag: L ? 'long' : 'short',
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined, noStop: p.noStop || undefined,
      };
      if (p.entry === 'limit') {
        sig.entryLimit = r2(L ? ref - p.limOff * dist : ref + p.limOff * dist);
        sig.limitTtl = p.limitTtl;
      }
      s.fills++; // counts attempts (a limit that never fills still uses the slot)
      out.push({ sig, score: fire.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((o) => o.sig);
  },
};

export default {
  strategy,
  grid: {
    tags: ['liquid'],
    minGap: [3],
    maxSymbols: [20],
    direction: ['both', 'with-gap'],
    barMinutes: [3, 5],
    look: [12],
    minLegBars: [3],
    legAtr: [0.3],
    minRetr: [0.2],
    maxRetr: [0.6],
    maxPb: [3],
    volRatio: [0.5, 0.6],
    vwap: [false],
    trig: ['touch', 'close'],
    startMin: [15],
    endMin: [330],
    entry: ['market'],
    limOff: [0],
    limitTtl: [5],
    stopMode: ['pb', 'atr'],
    stopAtr: [0.3],
    stopBufPct: [0.03],
    minRiskPct: [0.2],
    maxRiskPct: [3],
    targetR: [0, 1.5, 3],
    breakevenAtR: [0, 1],
    trailR: [0, 1.5],
    holdMinutes: [0],
    noStop: [false],
    nsAtr: [0.25],
    maxPerSym: [2],
    'rule.riskPerTrade': [100],
    'rule.maxTrades': [3],
    'rule.maxLosses': [2],
    'rule.maxConcurrent': [2],
  },
} as { strategy: Strategy<P>; grid: Record<string, unknown[]> };
