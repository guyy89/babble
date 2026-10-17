// Prior-day high/low family (round 2).
// Key levels: yesterday's regular-session high (PDH) and low (PDL), from ctx.dailyBefore (known at 09:30).
// Bars are aggregated into `barMinutes` buckets aligned to 09:30; logic runs only on completed buckets.
//  mode 'break'  : continuation — a bucket closes through the level (previous bucket close was on the other
//                  side, or the open for the first bucket) by ≥ `minBreak` ATR → enter in the break direction.
//  mode 'reject' : reversal — a bucket trades through the level but closes back on the original side by
//                  ≥ `minBreak` ATR (failed probe / failed breakout) → fade it; stop beyond the probe extreme.
//  mode 'retest' : level was broken earlier (a prior bucket closed beyond it, or the day opened beyond it);
//                  price pulls back to within `tol` ATR of the level and the bucket closes back on the broken
//                  side → enter in the break direction. A close back through the level cancels the break.
// Filters: universe tags, |gap| band, direction vs gap, session-VWAP side, time window.
// Stops: 'bar' = signal bucket extreme (probe extreme for reject) ∓ stopAtr ATR; 'atr' = signal close ∓ stopAtr ATR.
// Entries: market, or LIMIT at the level ('lvl') or `limOff` ATR better than the signal close ('off').
// Distances are in units of the 14-day daily ATR (dailyBefore only). One entry per symbol per day.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'break' | 'reject' | 'retest';
  universe: 'gap' | 'liquid' | 'all';
  minGap: number;          // |gap| % lower bound (gap names only)
  maxGap: number;          // |gap| % upper bound (gap names only; 0 = none)
  barMinutes: number;
  minBreak: number;        // ATR: required close distance beyond (break) / back inside (reject) the level
  tol: number;             // retest: bucket extreme within tol ATR of the level
  direction: 'both' | 'with-gap' | 'against-gap' | 'long' | 'short';
  vwap: 'none' | 'with' | 'against';   // with: long only above VWAP, short only below
  startMin: number;        // minutes after 09:30 before entries allowed
  endMin: number;          // minutes after 09:30 after which no entries
  stopMode: 'bar' | 'atr';
  stopAtr: number;
  entry: 'market' | 'lvl' | 'off';
  limOff: number;          // ATR, for entry 'off'
  limitTtl: number;
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = off; time exit this many minutes after the signal
  noStop: boolean;
}

interface B { o: number; h: number; l: number; c: number }
interface S {
  init: boolean; ok: boolean;
  pdh: number; pdl: number; atr: number;
  seen: number; pv: number; vol: number;
  cur?: B; curIdx: number;
  prevC: number;               // close of the previous completed bucket (the day open before the first)
  brokeHi: boolean; brokeLo: boolean;   // retest state
}

const OPEN = 9 * 60 + 30;
const DAY = 86_400_000;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function inUniverse(m: DayContext['meta'][string], p: P): boolean {
  if (m.open < 5) return false;
  const g = Math.abs(m.gapPct);
  if (p.universe === 'liquid') return m.tags.includes('liquid') || m.tags.includes('index');
  const gapOk = m.tags.includes('gap') && g >= p.minGap && (!p.maxGap || g <= p.maxGap);
  if (p.universe === 'gap') return gapOk;
  return gapOk || m.tags.includes('liquid') || m.tags.includes('index');
}

const strategy: Strategy<P> = {
  name: 'r2_prevday',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta).filter((m) => inUniverse(m, p)).map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const rel = ctx.minute - OPEN;
    const evalNow = rel >= p.barMinutes && rel % p.barMinutes === 0;
    const wantIdx = rel / p.barMinutes - 1;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { init: true, ok: false, pdh: NaN, pdl: NaN, atr: NaN, seen: 0, pv: 0, vol: 0, curIdx: -1, prevC: ctx.meta[sym].open, brokeHi: false, brokeLo: false };
        const d = ctx.dailyBefore(sym);
        const last = d.at(-1);
        const openUtc = bars[0].t; // only used to sanity-check that the daily bar is recent
        if (last && openUtc - last.t < 6 * DAY) {
          s.pdh = last.h; s.pdl = last.l; s.atr = dailyAtr(d);
          s.ok = Number.isFinite(s.atr) && s.atr > 0 && s.pdh > s.pdl;
        }
        const o = ctx.meta[sym].open;
        s.brokeHi = s.ok && o > s.pdh; // opened beyond the level = already broken (retest mode)
        s.brokeLo = s.ok && o < s.pdl;
        ctx.state.set(sym, s);
      }
      if (!s.ok) continue;
      // Fold newly closed 1m bars: VWAP + current bucket.
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const idx = Math.floor((ctx.minuteOf(b.t) - OPEN) / p.barMinutes);
        if (!s.cur || idx !== s.curIdx) {
          if (s.cur) s.prevC = s.cur.c; // bucket skipped evaluation (gap in data): still advance
          s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curIdx = idx;
        } else {
          s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c;
        }
      }
      if (!evalNow || !s.cur || s.curIdx !== wantIdx) continue;
      // The bucket wantIdx is complete (all its bars closed before ctx.minute).
      const k = s.cur; const pc = s.prevC; const A = s.atr;
      const { pdh, pdl } = s;
      s.prevC = k.c; s.cur = undefined;
      const vw = s.vol > 0 ? s.pv / s.vol : k.c;

      let side: 'long' | 'short' | undefined;
      let anchor = NaN; let level = NaN;
      if (p.mode === 'break') {
        if (pc <= pdh && k.c > pdh + p.minBreak * A) { side = 'long'; anchor = k.l; level = pdh; }
        else if (pc >= pdl && k.c < pdl - p.minBreak * A) { side = 'short'; anchor = k.h; level = pdl; }
      } else if (p.mode === 'reject') {
        if (k.h > pdh && k.c < pdh - p.minBreak * A) { side = 'short'; anchor = k.h; level = pdh; }
        else if (k.l < pdl && k.c > pdl + p.minBreak * A) { side = 'long'; anchor = k.l; level = pdl; }
      } else {
        // retest: check before updating the broken flags with this bucket
        if (s.brokeHi && k.l <= pdh + p.tol * A && k.c > pdh) { side = 'long'; anchor = Math.min(k.l, pdh); level = pdh; }
        else if (s.brokeLo && k.h >= pdl - p.tol * A && k.c < pdl) { side = 'short'; anchor = Math.max(k.h, pdl); level = pdl; }
        if (k.c > pdh + p.minBreak * A) s.brokeHi = true; else if (k.c < pdh) s.brokeHi = false;
        if (k.c < pdl - p.minBreak * A) s.brokeLo = true; else if (k.c > pdl) s.brokeLo = false;
      }
      if (!side) continue;
      if (rel < p.startMin || rel > p.endMin) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      const g = ctx.meta[sym].gapPct;
      if (p.direction === 'long' && side !== 'long') continue;
      if (p.direction === 'short' && side !== 'short') continue;
      if (p.direction === 'with-gap' && (side === 'long') !== (g > 0)) continue;
      if (p.direction === 'against-gap' && (side === 'long') !== (g < 0)) continue;
      if (p.vwap === 'with' && (side === 'long' ? k.c <= vw : k.c >= vw)) continue;
      if (p.vwap === 'against' && (side === 'long' ? k.c >= vw : k.c <= vw)) continue;

      const long = side === 'long';
      const stop = p.stopMode === 'bar'
        ? (long ? anchor - p.stopAtr * A : anchor + p.stopAtr * A)
        : (long ? k.c - p.stopAtr * A : k.c + p.stopAtr * A);
      const sig: Signal = {
        symbol: sym, side, stop: Math.round(stop * 100) / 100,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMin ? ctx.minute + p.holdMin : undefined,
        noStop: p.noStop || undefined,
        tag: `${p.mode}-${side}`,
      };
      if (p.entry !== 'market') {
        let lim = p.entry === 'lvl' ? level : long ? k.c - p.limOff * A : k.c + p.limOff * A;
        // a limit is only "better" than the signal price; if the level is on the wrong side, use the close
        if (long ? lim > k.c : lim < k.c) lim = k.c;
        lim = Math.round(lim * 100) / 100;
        if (long ? stop >= lim : stop <= lim) continue;
        sig.entryLimit = lim; sig.limitTtl = p.limitTtl;
      } else if (long ? stop >= k.c : stop <= k.c) continue;
      out.push(sig);
    }
    return out;
  },
};

export default {
  strategy,
  // run 1 (288 cfgs): mode×universe×barMinutes×vwap×startMin×stopMode×targetR → WF +3.9R FAIL; liquid/atr-stop best.
  // run 2 (192 cfgs): entry/limit TTL/stop/target/BE/trail on liquid → WF -57R (t -2.6) FAIL.
  // run 3 (256 cfgs): risk tiers × maxTrades/maxLosses/maxConcurrent on/off × universe × mode × stop/no-stop → WF -8.8R FAIL.
  // run 4 (192 cfgs) → WF -38.2R (t -2.1) FAIL. Gap names — mode × direction vs gap × max gap × morning-only vs all day × stop type × target × daily loss limit 3R vs off
  //        (risk tier $200 fixed: the $50/$100 tiers lost more to commissions in run 3 — shaped by earlier full-period results).
  grid: {
    mode: ['break', 'reject', 'retest'],
    universe: ['gap'],
    minGap: [2], maxGap: [0, 8],
    barMinutes: [5],
    minBreak: [0.02],
    tol: [0.05],
    direction: ['with-gap', 'against-gap'],
    vwap: ['with'],
    startMin: [5],
    endMin: [90, 330],
    stopMode: ['bar', 'atr'],
    stopAtr: [0.25],
    entry: ['market'], limOff: [0.05], limitTtl: [10],
    targetR: [0, 2],
    breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false],
    'rule.riskPerTrade': [200],
    'rule.dailyLossLimit': [600, 0],
  },
};
