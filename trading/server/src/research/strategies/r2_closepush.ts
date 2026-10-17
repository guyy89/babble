// End-of-day push / closing-imbalance drift (r2_closepush).
// At one late decision minute (e.g. 15:15–15:35 NY, seeing only bars closed before it) every watched stock is
// scored on its intraday trend:
//   trend     = (close − ref) / daily ATR, ref = session open ('open') or previous close ('prev', includes the gap)
//   location  = (close − day low) / (day high − day low): near the high for longs, near the low for shorts
//   vwap      = close on the trend side of the session VWAP (optional)
//   rel SPY   = stock % move from ref − SPY % move over the same span, in the trend direction ≥ minRel (optional)
// mode 'push' trades WITH the day's direction into the close (MOC flows); mode 'fade' trades against it.
// The strongest maxPicks names by |trend| are taken. Entry at market (next bar open) or LIMIT limOff × ATR better
// than the decision close (ttl limitTtl). Stop stopAtr × ATR from the decision close (or noStop: exit only by
// target/flatten). Exit: targetR, else the forced flatten (rule.flattenMinute, 15:55).
// No look-ahead: universe() uses meta + dailyBefore; onMinute() folds closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'all';
  minPrice: number;
  decide: number;          // NY minute-of-day of the (single) decision
  mode: 'push' | 'fade';
  direction: 'long' | 'short' | 'both';
  ref: 'open' | 'prev';
  minTrend: number;        // |trend| in daily ATR
  minLoc: number;          // 0..1, location in the day's range on the trend side (0 = off)
  vwap: boolean;
  minRel: number;          // % outperformance vs SPY in the trend direction; <0 = off
  maxPicks: number;
  entry: 'market' | 'limit';
  limOff: number;          // ATR
  limitTtl: number;
  stopAtr: number;
  noStop: boolean;
  targetR: number;         // 0 = none
  beAtR: number;           // breakeven trigger in R, 0 = off
  trailR: number;          // trailing stop distance in R, 0 = off
}

interface S { seen: number; atr: number; open: number; pv: number; vol: number; hi: number; lo: number; last: number; lastMin: number }

const SPY = 'SPY';

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function fold(ctx: MinuteContext, sym: string): S | undefined {
  const bars = ctx.bars(sym);
  if (!bars.length) return undefined;
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, pv: 0, vol: 0, hi: -Infinity, lo: Infinity, last: NaN, lastMin: -1 };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const b = bars[s.seen];
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    s.hi = Math.max(s.hi, b.h);
    s.lo = Math.min(s.lo, b.l);
    s.last = b.c;
    s.lastMin = ctx.minuteOf(b.t);
  }
  return s;
}

const strategy: Strategy<P> = {
  name: 'r2_closepush',
  universe(ctx: DayContext, p: P) {
    const syms = Object.values(ctx.meta)
      .filter((m) => {
        if (m.tags.includes('index')) return false;
        if (m.open < p.minPrice) return false;
        if (p.universe === 'gap') return m.tags.includes('gap');
        if (p.universe === 'liquid') return m.tags.includes('liquid');
        return true;
      })
      .map((m) => m.symbol);
    if (ctx.meta[SPY]) syms.push(SPY); // benchmark only, never traded
    return syms;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute !== p.decide) return [];
    const spy = fold(ctx, SPY);
    const spyMeta = ctx.meta[SPY];
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      if (sym === SPY || ctx.meta[sym].tags.includes('index')) continue;
      const s = fold(ctx, sym);
      if (!s || s.lastMin !== ctx.minute - 1) continue; // need the latest bar
      if (ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      if (!(s.atr > 0) || !(s.hi > s.lo)) continue;
      const close = s.last;
      const refPx = p.ref === 'open' ? s.open : ctx.meta[sym].prevClose;
      if (!(refPx > 0)) continue;
      const trend = (close - refPx) / s.atr;
      const dir: 1 | -1 = trend >= 0 ? 1 : -1;
      if (Math.abs(trend) < p.minTrend) continue;
      if (p.minLoc > 0) {
        const loc = (close - s.lo) / (s.hi - s.lo);
        if ((dir === 1 ? loc : 1 - loc) < p.minLoc) continue;
      }
      if (p.vwap && s.vol > 0 && dir * (close - s.pv / s.vol) <= 0) continue;
      if (p.minRel >= 0) {
        if (!spy || !spyMeta) continue;
        const spyRef = p.ref === 'open' ? spy.open : spyMeta.prevClose;
        const rel = ((close / refPx - 1) - (spy.last / spyRef - 1)) * 100;
        if (dir * rel < p.minRel) continue;
      }
      const side = (p.mode === 'push' ? dir : -dir) === 1 ? 'long' : 'short';
      if (p.direction !== 'both' && side !== p.direction) continue;
      const long = side === 'long';
      const stop = close + (long ? -1 : 1) * p.stopAtr * s.atr;
      const sig: Signal = {
        symbol: sym, side, stop, targetR: p.targetR || undefined, noStop: p.noStop || undefined,
        breakevenAtR: p.beAtR || undefined, trailR: p.trailR || undefined, tag: `${p.mode}-${side}`,
      };
      if (p.entry === 'limit') {
        sig.entryLimit = r2(close + (long ? -1 : 1) * p.limOff * s.atr);
        sig.limitTtl = p.limitTtl;
        if (long ? sig.entryLimit <= stop : sig.entryLimit >= stop) continue;
      }
      cands.push({ sig, score: Math.abs(trend) });
    }
    return cands.sort((a, b) => b.score - a.score).slice(0, p.maxPicks).map((c) => c.sig);
  },
};

export default {
  strategy,
  grid: {
    // wf run 1 (256 cfgs): push vs fade x liquid/all x 15:15/15:25 x minTrend 0.3/0.6 x minLoc 0/0.8 x market/limit
    //   x stop 0.2/0.4 ATR x risk 50/500, limits off.  WF -5.4R, FAIL.
    // wf run 2: the family that the design months (Apr16-Jun15) favoured: fade, liquid names, 15:15 decision.
    // Explores risk tiers, limits on/off (maxTrades 3/0, maxConcurrent 2/0, daily loss default 3R), market vs limit, breakeven.
    //   WF2 (256 cfgs): +5.1R, 3/4 months up, PF 1.22, stress +1.4 but t 0.54, one trade 46% / SPCX 106% of profit: FAIL.
    // wf run 3: same family, exits and limit-order variants (designed on Apr16-Jun15; also follows WF2, see report):
    // stop 0.2/0.4 ATR, noStop, target 0/2R, trail 0/1R, limit offset 0.05/0.1 ATR and ttl 5/15 min, risk 100/500, limits off.
    universe: ['liquid'], minPrice: [5], decide: [915], mode: ['fade'], direction: ['both'], ref: ['open'],
    minTrend: [0.3], minLoc: [0], vwap: [false], minRel: [-1], maxPicks: [4],
    entry: ['market', 'limit'], limOff: [0.05, 0.1], limitTtl: [5, 15], stopAtr: [0.2, 0.4], noStop: [false, true], targetR: [0, 2], beAtR: [0], trailR: [0, 1],
    'rule.riskPerTrade': [100, 500], 'rule.maxTrades': [0], 'rule.maxConcurrent': [0], 'rule.maxLosses': [0], 'rule.dailyLossLimit': [0],
    'rule.lastEntryMinute': [940], 'rule.flattenMinute': [955],
  },
};
