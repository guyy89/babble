// r2_orb5: opening-range breakout with a SHORT range (first 3 / 5 / 10 minutes).
// Entry when a 1-minute (or barMinutes) signal bar closes beyond the range high/low, optionally:
//   - only in the gap direction, or only in the direction of the opening-range candle (open→close of the range);
//   - with VWAP confirmation; with breakout-bar volume confirmation;
//   - only on the top-N "in play" names by opening-range relative volume (computed from closed range bars).
// Entry at market (next bar open) or by LIMIT (at the breakout level = retest, or a bit under the signal close).
// Stops: far side of range / mid-range / ATR-based (fraction of 14-day daily ATR) / none (time exit only).
// Pattern copied from orb.ts: universe() uses only 09:30 info, onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  orMinutes: number;                 // opening range length: 3, 5, 10
  barMinutes: number;                // signal bar length (buckets aligned to 09:30)
  tags: 'gap' | 'liquid' | 'all';    // universe tags ('all' = gap + liquid)
  minGap: number;                    // |gap| % to qualify
  minPrice: number;
  maxPrice: number;
  topRvol: number;                   // keep only the N names with highest opening-range relative volume (0 = all)
  minRvol: number;                   // opening-range rel. volume (per-minute vol vs 20d avg per-minute) floor (0 = off)
  direction: 'both' | 'with-gap' | 'candle'; // candle = side of the opening-range candle (close vs open)
  vwapFilter: boolean;
  volMult: number;                   // breakout bucket vol/min >= volMult × avg vol/min since open (0 = off)
  maxRangeAtr: number;               // skip if range > this × daily ATR (0 = off)
  cutoffMinutes: number;             // no new signals after OPEN + this
  entry: 'market' | 'level' | 'close'; // limit at range level (retest) or at close × (1 ∓ limitBps)
  limitBps: number;
  limitTtl: number;
  stopMode: 'far' | 'mid' | 'atr' | 'atrpct' | 'none'; // atrpct: ATR as % of prior close, applied to today's price (gap-scaled)
  atrStop: number;                   // stop distance = atrStop × daily ATR from the entry reference (stopMode atr)
  targetR: number;                   // 0 = none
  breakevenAtR: number;              // 0 = off
  trailR: number;                    // 0 = off
  holdMinutes: number;               // time exit N minutes after the signal (0 = hold to flatten)
}

interface S {
  seen: number;
  hi: number; lo: number; orOpen?: number; orClose?: number; orVol: number;
  pv: number; vol: number;
  atr?: number;
  done: boolean;                     // already signalled today
}

const OPEN = 9 * 60 + 30;

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
  name: 'r2_orb5',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.tags === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.tags)))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && m.open >= p.minPrice && m.open <= p.maxPrice)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: Signal[] = [];
    const rangeEnd = OPEN + p.orMinutes;
    // Inside the range nothing can be decided (bars are folded lazily at rangeEnd); after the cutoff no new
    // signals are allowed, so there is nothing left to do for the day.
    if (ctx.minute < rangeEnd || ctx.minute > OPEN + p.cutoffMinutes) return out;
    const syms = Object.keys(ctx.meta).filter((s) => ctx.bars(s).length > 0);
    // Fold newly closed bars for every watched symbol.
    for (const sym of syms) {
      const bars = ctx.bars(sym);
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, hi: -Infinity, lo: Infinity, orVol: 0, pv: 0, vol: 0, done: false, atr: atr14(ctx.dailyBefore(sym)) };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < rangeEnd) {
          s.hi = Math.max(s.hi, b.h); s.lo = Math.min(s.lo, b.l);
          if (s.orOpen === undefined) s.orOpen = b.o;
          s.orClose = b.c; s.orVol += b.v;
        }
      }
    }
    // Once, at the first minute after the range: rank by opening-range relative volume.
    let allowed = ctx.state.get('__allowed') as Set<string> | undefined;
    if (!allowed) {
      const ranked = syms
        .map((sym) => {
          const s = ctx.state.get(sym) as S;
          const perMin = ctx.meta[sym].avgVolume / 390;
          return { sym, rvol: perMin > 0 ? s.orVol / p.orMinutes / perMin : 0 };
        })
        .filter((x) => !p.minRvol || x.rvol >= p.minRvol)
        .sort((a, b) => b.rvol - a.rvol);
      allowed = new Set((p.topRvol ? ranked.slice(0, p.topRvol) : ranked).map((x) => x.sym));
      ctx.state.set('__allowed', allowed);
    }

    const evalNow = ctx.minute >= rangeEnd + p.barMinutes && (ctx.minute - OPEN) % p.barMinutes === 0
      && ctx.minute <= OPEN + p.cutoffMinutes;
    if (!evalNow) return out;
    const bucketStart = ctx.minute - p.barMinutes;

    for (const sym of allowed) {
      const s = ctx.state.get(sym) as S;
      if (s.done || ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.hi)) continue;
      const bars = ctx.bars(sym);
      const last = bars[bars.length - 1];
      if (ctx.minuteOf(last.t) < bucketStart) continue; // no fresh bar in the signal bucket
      const close = last.c;
      // Signal-bucket volume (tail of closed bars).
      let bucketVol = 0;
      for (let i = bars.length - 1; i >= 0 && ctx.minuteOf(bars[i].t) >= bucketStart; i--) bucketVol += bars[i].v;
      const range = s.hi - s.lo;
      if (!(range > 0)) continue;
      if (p.maxRangeAtr && s.atr && range > p.maxRangeAtr * s.atr) continue;
      if ((p.stopMode === 'atr' || p.stopMode === 'atrpct' || p.maxRangeAtr) && !s.atr) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const candleUp = (s.orClose ?? 0) > (s.orOpen ?? 0);
      const candleDown = (s.orClose ?? 0) < (s.orOpen ?? 0);
      const dirOk = (long: boolean) =>
        p.direction === 'both' || (p.direction === 'with-gap' ? gapUp === long : long ? candleUp : candleDown);
      let side: 'long' | 'short' | undefined;
      if (close > s.hi && (!p.vwapFilter || close > vwap) && dirOk(true)) side = 'long';
      else if (close < s.lo && (!p.vwapFilter || close < vwap) && dirOk(false)) side = 'short';
      if (!side) continue;
      if (p.volMult) {
        const minutesBefore = bucketStart - OPEN;
        const before = s.vol - bucketVol;
        if (minutesBefore <= 0 || bucketVol / p.barMinutes < p.volMult * (before / minutesBefore)) continue;
      }
      const long = side === 'long';
      const dir = long ? 1 : -1;
      let entryLimit: number | undefined;
      if (p.entry === 'level') entryLimit = long ? s.hi : s.lo;
      else if (p.entry === 'close') entryLimit = Math.round(close * (1 - dir * p.limitBps / 10_000) * 100) / 100;
      const ref = entryLimit ?? close;
      let stop: number;
      if (p.stopMode === 'mid') stop = (s.hi + s.lo) / 2;
      else if (p.stopMode === 'atr') stop = ref - dir * p.atrStop * s.atr!;
      else if (p.stopMode === 'atrpct') stop = ref - dir * p.atrStop * (s.atr! / ctx.meta[sym].prevClose) * ref;
      else stop = long ? s.lo : s.hi; // far (also the sizing stop for 'none')
      if ((long && stop >= ref) || (!long && stop <= ref)) continue;
      s.done = true;
      out.push({
        symbol: sym, side, stop,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
        entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
        noStop: p.stopMode === 'none' || undefined,
        tag: `${side}-${p.entry}`,
      });
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    // Final run (declared: shaped by runs 1-4): the canonical "stocks in play" 5-minute ORB — top-N by opening
    // relative volume, 0.1×ATR stop, hold to the close — across risk tiers and trade-count limits.
    orMinutes: [5], barMinutes: [1], tags: ['all'], minGap: [0], minPrice: [5], maxPrice: [1000],
    topRvol: [10, 20], minRvol: [0, 1], direction: ['both', 'candle'], vwapFilter: [false], volMult: [0],
    maxRangeAtr: [0], cutoffMinutes: [30], entry: ['market', 'close'], limitBps: [10], limitTtl: [10],
    stopMode: ['atr'], atrStop: [0.1], targetR: [0], breakevenAtR: [0], trailR: [0], holdMinutes: [0],
    'rule.riskPerTrade': [50, 100, 200, 500], 'rule.maxTrades': [3, 0],
  },
};
