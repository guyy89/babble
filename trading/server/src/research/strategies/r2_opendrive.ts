// r2_opendrive: opening drive. When the first 1/3/5-minute candle of the session is strong — a large body
// relative to its own range AND relative to the stock's 14-day daily ATR, closing near its extreme — follow it.
//   - Signal is evaluated once, at 09:30 + candleMin, from the closed 1-minute bars of the opening candle only.
//   - Direction filter: both / only with the gap / only against the gap / long only / short only.
//   - Entry at market (next bar open) or by LIMIT at a pullback of `retrace` × candle range from its close.
//   - Stop: other end of the candle ('extreme'), candle midpoint ('mid'), stopAtr × ATR from the candle close
//     ('atr'), or none (sized from the extreme stop, exits only by target/time/close).
//   - Exits: fixed target R, breakeven, trailing, time exit `exitMin` minutes after the open, or the close.
// No look-ahead: universe() uses ctx.meta + dailyBefore only; onMinute() uses closed bars only (minute < signal minute).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  candleMin: number;                 // opening candle length: 1, 3, 5
  uni: 'gap' | 'liquid' | 'all';     // universe tags (all = gap + liquid; index ETFs excluded)
  minPrice: number;
  minBodyFrac: number;               // |close-open| / (high-low) ≥ this
  minBodyAtr: number;                // |close-open| ≥ this × daily ATR(14)
  closeNear: number;                 // close within closeNear × range of the candle's extreme in the body direction
  minRvol: number;                   // candle volume per minute / (20d avg volume / 390) ≥ this (0 = off)
  dir: 'both' | 'with-gap' | 'against-gap' | 'long' | 'short';
  maxSignals: number;                // strongest N candidates (by body/ATR) per day (0 = all)
  entry: 'market' | 'limit';
  retrace: number;                   // limit = close ∓ retrace × candle range
  limitTtl: number;
  stopMode: 'extreme' | 'mid' | 'atr' | 'none';
  stopAtr: number;                   // stopMode atr: distance = stopAtr × ATR from the candle close
  targetR: number;                   // 0 = none
  breakevenAtR: number;              // 0 = off
  trailR: number;                    // 0 = off
  exitMin: number;                   // time exit at 09:30 + exitMin (0 = harness flatten)
  // Bundles (override the individual params when not 'none'), so a grid can vary them jointly:
  mgmt: 'none' | 'hold' | 't2' | 't3' | 'trail1' | 'trail2' | 'be1' | 'be1t3';
  entryPlan: 'none' | 'market' | 'lim25_5' | 'lim25_15' | 'lim50_15';
  // CONTROL (baseline): ignore the candle-strength filters and go LONG every universe name at the same minute,
  // with a stop half the opening-candle range below the candle close (same sizing/exits). Measures pure drift.
  control: boolean;
  variant: string;                   // named bundle of strategy params (see VARIANTS), '' = none
}

const VARIANTS: Record<string, Partial<P>> = {
  long1mid: { candleMin: 1, dir: 'long', stopMode: 'mid', mgmt: 'hold', entryPlan: 'market' },
  long1midBe: { candleMin: 1, dir: 'long', stopMode: 'mid', mgmt: 'be1', entryPlan: 'market' },
  both1mid: { candleMin: 1, dir: 'both', stopMode: 'mid', mgmt: 'hold', entryPlan: 'market' },
  anti1mid: { candleMin: 1, dir: 'against-gap', stopMode: 'mid', mgmt: 'hold', entryPlan: 'market' },
  long3atrBe: { candleMin: 3, dir: 'long', stopMode: 'atr', mgmt: 'be1', entryPlan: 'market' },
  control1: { candleMin: 1, dir: 'long', stopMode: 'mid', mgmt: 'hold', entryPlan: 'market', control: true },
};

const MGMT: Record<string, { targetR: number; breakevenAtR: number; trailR: number }> = {
  hold: { targetR: 0, breakevenAtR: 0, trailR: 0 }, t2: { targetR: 2, breakevenAtR: 0, trailR: 0 }, t3: { targetR: 3, breakevenAtR: 0, trailR: 0 },
  trail1: { targetR: 0, breakevenAtR: 0, trailR: 1 }, trail2: { targetR: 0, breakevenAtR: 0, trailR: 2 },
  be1: { targetR: 0, breakevenAtR: 1, trailR: 0 }, be1t3: { targetR: 3, breakevenAtR: 1, trailR: 0 },
};
const ENTRY: Record<string, { entry: 'market' | 'limit'; retrace: number; limitTtl: number }> = {
  market: { entry: 'market', retrace: 0, limitTtl: 0 }, lim25_5: { entry: 'limit', retrace: 0.25, limitTtl: 5 },
  lim25_15: { entry: 'limit', retrace: 0.25, limitTtl: 15 }, lim50_15: { entry: 'limit', retrace: 0.5, limitTtl: 15 },
};

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
  name: 'r2_opendrive',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => !m.tags.includes('index'))
      .filter((m) => (p.uni === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.uni)))
      .filter((m) => m.open >= p.minPrice)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, pIn: P): Signal[] {
    const p0: P = pIn.variant ? { ...pIn, ...VARIANTS[pIn.variant] } : pIn;
    // One decision per day, the minute the opening candle has fully closed.
    if (ctx.minute !== OPEN + p0.candleMin) return [];
    const p: P = { ...p0, ...(p0.mgmt && p0.mgmt !== 'none' ? MGMT[p0.mgmt] : {}), ...(p0.entryPlan && p0.entryPlan !== 'none' ? ENTRY[p0.entryPlan] : {}) };
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length || ctx.open.has(sym) || ctx.traded.has(sym)) continue;
      // The opening candle: the closed bars of minutes [09:30, 09:30 + candleMin). Must start at 09:30.
      const cb = bars.filter((b) => ctx.minuteOf(b.t) < OPEN + p.candleMin);
      if (!cb.length || ctx.minuteOf(cb[0].t) !== OPEN) continue;
      const o = cb[0].o, c = cb[cb.length - 1].c;
      let h = -Infinity, l = Infinity, v = 0;
      for (const b of cb) { h = Math.max(h, b.h); l = Math.min(l, b.l); v += b.v; }
      const range = h - l, body = c - o;
      if (!(range > 0) || body === 0) continue;
      const atr = atr14(ctx.dailyBefore(sym));
      if (!atr || !(atr > 0)) continue;
      if (p.control) {
        const stop = c - 0.5 * range;
        cands.push({ sig: { symbol: sym, side: 'long', stop, targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute: p.exitMin ? OPEN + p.exitMin : undefined, tag: 'control' }, score: Math.abs(body) / atr });
        continue;
      }
      if (Math.abs(body) / range < p.minBodyFrac) continue;
      if (Math.abs(body) < p.minBodyAtr * atr) continue;
      const long = body > 0;
      if ((long ? h - c : c - l) > p.closeNear * range) continue;
      if (p.minRvol > 0) {
        const perMin = ctx.meta[sym].avgVolume / 390;
        if (!(perMin > 0) || v / p.candleMin / perMin < p.minRvol) continue;
      }
      const gapUp = ctx.meta[sym].gapPct > 0;
      if (p.dir === 'long' && !long) continue;
      if (p.dir === 'short' && long) continue;
      if (p.dir === 'with-gap' && long !== gapUp) continue;
      if (p.dir === 'against-gap' && long === gapUp) continue;
      const mid = (h + l) / 2;
      let stop: number;
      if (p.stopMode === 'mid') stop = mid;
      else if (p.stopMode === 'atr') stop = long ? c - p.stopAtr * atr : c + p.stopAtr * atr;
      else stop = long ? l : h; // 'extreme' and 'none' (none: sizing reference only)
      const sig: Signal = {
        symbol: sym, side: long ? 'long' : 'short', stop,
        targetR: p.targetR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        trailR: p.trailR || undefined,
        exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
        noStop: p.stopMode === 'none' || undefined,
        tag: long ? 'long' : 'short',
      };
      if (p.entry === 'limit') {
        const lim = long ? c - p.retrace * range : c + p.retrace * range;
        // A limit at/through the stop would be a zero-risk order: skip.
        if (long ? lim <= stop : lim >= stop) continue;
        sig.entryLimit = Math.round(lim * 100) / 100;
        sig.limitTtl = p.limitTtl;
      }
      cands.push({ sig, score: Math.abs(body) / atr });
    }
    cands.sort((a, b) => b.score - a.score);
    return (p.maxSignals > 0 ? cands.slice(0, p.maxSignals) : cands).map((x) => x.sig);
  },
};

const base = {
  candleMin: [5], uni: ['all'], minPrice: [5], minBodyFrac: [0.6], minBodyAtr: [0.15], closeNear: [0.25], minRvol: [0], dir: ['both'],
  maxSignals: [0], entry: ['market'], retrace: [0.25], limitTtl: [10], stopMode: ['extreme'], stopAtr: [0.2], targetR: [2], breakevenAtR: [0], trailR: [0], exitMin: [0],
  mgmt: ['none'], entryPlan: ['none'], control: [false], variant: [''],
  'rule.riskPerTrade': [100],
};

export default {
  strategy,
  grid: {
    ...base,
    // run 1 (288): candleMin [1,3,5] × uni [gap,liquid] × minBodyAtr [0.1,0.25] × dir [both,with-gap,against-gap]
    //   × stopMode [extreme,mid] × targetR [0,2] × exitMin [30,0]; market entry, default limits, $100 risk.
    // run 2 (288): liquid only; candleMin [1,3] × minBodyAtr 0.1 × dir [both,long,against-gap] × stopMode [mid,extreme,atr0.3,none]
    //   × mgmt [hold,t3,trail2,be1] × entryPlan [market,lim25_5,lim50_15].
    // run 3 (192): variants [long1mid,long1midBe,both1mid,anti1mid,long3atrBe,control1] × risk [50,100,200,500]
    //   × maxTrades [3,0] × maxConcurrent [2,0] × maxLosses [2,0] (daily loss limit default 3× risk).
    // run 4 (216, SHAPED BY runs 1–3): neighbourhood of the long-only 1-minute drive on liquid names, daily loss
    //   limit OFF: liquid, long, mid stop, mgmt [hold,be1] × candleMin [1,2] × minBodyAtr [0.05,0.1,0.15] × minBodyFrac [0.5,0.6,0.75]
    //   × closeNear [0.25,0.5] × entryPlan [market,lim25_5,lim25_15]. (DLL off changed nothing vs run 3.)
    // run 5 (108, SHAPED BY runs 1–4): does the long-only drive generalise beyond liquid names / 1-minute candles?
    uni: ['liquid', 'gap', 'all'], dir: ['long'], candleMin: [1, 2, 3, 5], minBodyAtr: [0.1], minBodyFrac: [0.6], closeNear: [0.25],
    stopMode: ['mid', 'extreme', 'atr'], stopAtr: [0.2], exitMin: [0], mgmt: ['hold', 't3', 'trail2'], entryPlan: ['market'],
  },
};
