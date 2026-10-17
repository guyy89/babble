// r2_partialfill: partial gap fill, then continuation in the gap direction.
// Universe (09:30 info only): 'gap'-tagged names with minGap <= |gap| <= maxGap, price/volume floors, top maxSymbols
// by |gap|, optional direction filter. Trades are always WITH the gap.
// Retracement: the adverse extreme since the open (LOD for gap-ups, HOD for gap-downs). Fill fraction =
// (ref - extreme) / (ref - prevClose) with ref = today's open ('open') or the best price reached before the extreme
// ('peak'). The setup is alive while the fill stays <= maxFill and the extreme was made before OPEN + setupMin;
// a deeper fill, or a new extreme after the setup window, kills it for the day.
// Support (checked at the extreme bar): 'vwap' (the retrace held session VWAP: extreme not beyond it by more than supTol%), 'or' (extreme made after
// the opening range, within supTol% of the range low/high), 'round' (within supTol% of a $1 / $0.50 level),
// 'any' (one of them), 'none'.
// Entry modes:
//   market  — after >= confirmBars bars since the extreme, a bar closing beyond the highest high (gap-up) of the
//             bars since the extreme (incl. the extreme bar) → market at the next bar; optional VWAP-side filter;
//   pblimit — same trigger, but a LIMIT at extreme + limFrac × (trigger close − extreme), limitTtl minutes;
//   dip     — a resting LIMIT at the minFill retracement level, placed when the opening range completes if price
//             has not reached it yet, valid dipTtl minutes (no confirmation, no support check).
// Stops: 'ext' (beyond the extreme by bufAtr × daily ATR), 'atr' (atrStop × ATR from the entry reference),
// 'fail' (the maxFill level, i.e. the gap-failure level, plus buffer), 'none' (noStop, sized from the 'ext' stop
// — or the 'fail' stop for dip — exits by target/time/close only).
// Decisions use closed bars only; state is folded in incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  minGap: number;
  maxGap: number;
  maxSymbols: number;
  minPrice: number;
  minAvgVol: number;
  side: 'both' | 'long' | 'short';
  orMinutes: number;
  fillRef: 'open' | 'peak';
  minFill: number;
  maxFill: number;
  setupMin: number;       // extreme must be made before OPEN + setupMin
  cutoffMin: number;      // no new entries after OPEN + cutoffMin
  support: 'none' | 'vwap' | 'or' | 'round' | 'any';
  supTol: number;         // % of price
  confirmBars: number;
  vwapFilter: boolean;
  entry: 'market' | 'pblimit' | 'dip';
  limFrac: number;
  limitTtl: number;
  dipTtl: number;         // dip mode: minutes the resting limit stays
  stopMode: 'ext' | 'atr' | 'fail' | 'none';
  bufAtr: number;
  atrStop: number;
  targetR: number;        // 0 = none
  breakevenAtR: number;   // 0 = off
  trailR: number;         // 0 = off
  holdMinutes: number;    // 0 = hold to flatten
}

interface S {
  seen: number;
  dir: number;
  orHi: number; orLo: number;
  pv: number; vol: number;
  atr?: number;
  peak: number;           // best favourable price so far
  ext: number;            // adverse extreme so far
  extIdx: number;
  extMin: number;
  extVwap: number;
  extRef: number;         // fill reference at the time of the extreme
  fill: number;
  swing: number;          // best favourable price from the extreme bar up to and incl. the latest bar
  trigLevel: number;      // swing before the latest bar
  last?: Bar;
  done: boolean;
  dipPlaced: boolean;
}

const OPEN = 9 * 60 + 30;
const cent = (x: number) => Math.round(x * 100) / 100;

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

const strategy: Strategy<P> = {
  name: 'r2_partialfill',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap && Math.abs(m.gapPct) <= p.maxGap)
      .filter((m) => m.open >= p.minPrice && m.avgVolume >= p.minAvgVol && Math.abs(m.open - m.prevClose) > 0)
      .filter((m) => p.side === 'both' || (p.side === 'long' ? m.gapPct > 0 : m.gapPct < 0))
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    if (ctx.minute > OPEN + p.cutoffMin) return out;   // nothing to do afterwards; state no longer needed
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      const meta = ctx.meta[sym];
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const dir = meta.gapPct > 0 ? 1 : -1;
        s = {
          seen: 0, dir, orHi: -Infinity, orLo: Infinity, pv: 0, vol: 0, atr: atr14(ctx.dailyBefore(sym)),
          peak: meta.open, ext: meta.open, extIdx: -1, extMin: OPEN, extVwap: meta.open, extRef: meta.open, fill: 0,
          swing: NaN, trigLevel: NaN, done: false, dipPlaced: false,
        };
        ctx.state.set(sym, s);
      }
      const dir = s.dir;
      const better = (a: number, b: number) => (dir > 0 ? Math.max(a, b) : Math.min(a, b)); // favourable
      const worse = (a: number, b: number) => (dir > 0 ? a < b : a > b);                    // a adverse of b
      const prevSeen = s.seen;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const vwap = s.vol > 0 ? s.pv / s.vol : b.c;
        if (bm < OPEN + p.orMinutes) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
        const fav = dir > 0 ? b.h : b.l;
        const adv = dir > 0 ? b.l : b.h;
        s.peak = better(s.peak, fav);
        if (s.extIdx < 0 || worse(adv, s.ext)) {
          s.ext = adv; s.extIdx = s.seen; s.extMin = bm; s.extVwap = vwap;
          s.extRef = p.fillRef === 'open' ? meta.open : s.peak;
          const denom = (s.extRef - meta.prevClose) * dir;
          s.fill = denom > 0 ? ((s.extRef - adv) * dir) / denom : Infinity;
          if (s.fill > p.maxFill) s.done = true;                         // gap failed
          if (bm >= OPEN + p.setupMin && s.fill > 0) s.done = true;      // support broke after the setup window
          s.trigLevel = NaN;
          s.swing = fav;
        } else {
          s.trigLevel = s.swing;
          s.swing = better(s.swing, fav);
        }
        s.last = b;
      }
      if (s.done || s.seen === prevSeen) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym)) { s.done = true; continue; }
      const last = s.last!;
      const beyond = (x: number, y: number) => (dir > 0 ? x > y : x < y);
      const long = dir > 0;
      const gap = Math.abs(meta.open - meta.prevClose);
      const atr = s.atr;
      const buf = atr ? p.bufAtr * atr : 0.01;

      if (p.entry === 'dip') {
        if (s.dipPlaced || ctx.minute < OPEN + p.orMinutes) continue;
        s.dipPlaced = true;
        s.done = true;
        const ref0 = p.fillRef === 'open' ? meta.open : s.peak;
        const level = cent(ref0 - dir * p.minFill * gap);
        if (!beyond(last.c, level) || s.fill >= p.minFill) continue;   // already reached: no resting order
        const failStop = ref0 - dir * p.maxFill * gap - dir * buf;
        let stop: number;
        if (p.stopMode === 'atr') { if (!atr) continue; stop = level - dir * p.atrStop * atr; }
        else stop = failStop;                                           // 'fail', 'ext', 'none'
        if (!beyond(level, stop)) continue;
        out.push({
          symbol: sym, side: long ? 'long' : 'short', stop,
          targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
          exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
          entryLimit: level, limitTtl: p.dipTtl, noStop: p.stopMode === 'none' || undefined,
          tag: `${long ? 'long' : 'short'}-dip`,
        });
        continue;
      }

      // Confirmed resumption after a partial fill.
      if (s.fill < p.minFill || s.extMin >= OPEN + p.setupMin) continue;
      if (s.seen - 1 - s.extIdx < p.confirmBars || !Number.isFinite(s.trigLevel)) continue;
      const close = last.c;
      if (!beyond(close, s.trigLevel)) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      if (p.vwapFilter && !beyond(close, vwap)) continue;
      if (p.support !== 'none') {
        const tol = (p.supTol / 100) * s.ext;
        const nearVwap = (s.ext - s.extVwap) * dir >= -tol;   // retrace held VWAP (gap-up: low >= VWAP − tol)
        const orLevel = long ? s.orLo : s.orHi;
        const nearOr = s.extMin >= OPEN + p.orMinutes && Number.isFinite(orLevel) && Math.abs(orLevel - s.ext) <= tol;
        const step = s.ext < 10 ? 0.5 : 1;
        const nearRound = Math.abs(s.ext - Math.round(s.ext / step) * step) <= tol;
        const ok = p.support === 'vwap' ? nearVwap : p.support === 'or' ? nearOr : p.support === 'round' ? nearRound : nearVwap || nearOr || nearRound;
        if (!ok) continue;
      }
      let ref = close;
      let entryLimit: number | undefined;
      if (p.entry === 'pblimit') {
        entryLimit = cent(s.ext + p.limFrac * (close - s.ext));
        ref = entryLimit;
      }
      let stop: number;
      if (p.stopMode === 'atr') { if (!atr) continue; stop = ref - dir * p.atrStop * atr; }
      else if (p.stopMode === 'fail') stop = s.extRef - dir * p.maxFill * gap - dir * buf;
      else stop = s.ext - dir * buf;                                    // 'ext' and 'none'
      if (!beyond(ref, stop)) continue;
      s.done = true;
      out.push({
        symbol: sym, side: long ? 'long' : 'short', stop,
        targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        noStop: p.stopMode === 'none' || undefined,
        tag: `${long ? 'long' : 'short'}-${p.entry}-${p.support}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    minGap: [3, 6], maxGap: [30], maxSymbols: [10], minPrice: [5], minAvgVol: [500_000], side: ['long'],
    orMinutes: [5], fillRef: ['open'], minFill: [0.25, 0.4], maxFill: [0.6, 0.9], setupMin: [60], cutoffMin: [90],
    support: ['none'], supTol: [0.4], confirmBars: [2], vwapFilter: [true],
    entry: ['market', 'pblimit'], limFrac: [0.5], limitTtl: [10], dipTtl: [50],
    stopMode: ['atr', 'ext'], bufAtr: [0.03], atrStop: [0.4], targetR: [0], breakevenAtR: [0], trailR: [0, 1.5], holdMinutes: [0, 60],
    'rule.riskPerTrade': [100],
  },
};
