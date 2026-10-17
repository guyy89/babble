// r2_xsmom: cross-sectional intraday momentum, market-neutral basket (round 2).
// At one decision minute, rank the liquid single stocks (tag 'liquid'; ETFs and the duplicate GOOG share class
// excluded) by a score, then go LONG the top K and SHORT the bottom K (dir 'mom'; dir 'rev' = the mirror basket,
// long losers / short winners, the intraday-reversal hypothesis). Each leg is one trade sized from its stop
// distance, so every leg carries the same $ risk (sizing 'atr' = risk parity) or the same $ notional (sizing 'eq').
// Score windows:  'open' = last close / today's open − 1;  'prev' = last close / previous close − 1 (incl. gap);
//                 'w30'  = last close / close 30 minutes earlier − 1.
// Normalisation:  'raw' = return;  'atr' = return / ATR%;  'xatr' = (return − SPY return over the window) / ATR%.
// Stop distance d = max(stopK × ATR14 (sizing 'atr') or stopK × median-ATR% × price (sizing 'eq'), price × K/190).
// The floor makes the whole basket fit the buying power at every tier: notional per leg = risk / (d/price) ≤
// 190 × risk, so 2K legs ≤ 380 × risk < 400 × risk (= 4 × equity); it also keeps a leg under the 200 × risk cap.
// noStop = size from d but do not place the stop (exit by time / flatten only).
// Signals are emitted interleaved (long #1, short #1, long #2, …) so a refused leg leaves the basket nearly balanced.
// No look-ahead: universe() uses ctx.meta only; ATR from ctx.dailyBefore(); scores use only closed bars.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  K: number;                       // names per side
  decMin: number;                  // decision minute after 09:30 (30 = 10:00)
  win: 'open' | 'prev' | 'w30';
  norm: 'raw' | 'atr' | 'xatr';
  dir: 'mom' | 'rev';
  sizing: 'atr' | 'eq';
  stopK: number;                   // stop / sizing distance in daily-ATR units
  noStop: boolean;
  targetR: number;                 // 0 = none
  trailR: number;                  // 0 = off
  hold: number;                    // 0 = to the flatten; else exit this many minutes after the decision
  entry: 'mkt' | 'lim' | 'lim5' | 'lim15'; // 'limN' = limit with ttl N (overrides limTtl)
  limOff: number;                  // limit: ATR fraction better than the last close
  limTtl: number;
  idxMin: number;                  // 0 = always; else trade only when |SPY return since open| ≥ idxMin % at decision
}

const OPEN = 9 * 60 + 30;
const SPY = 'SPY';
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'IVV', 'VOO', 'GLD', 'TQQQ', 'SQQQ', 'SMH', 'SOXX', 'HYG', 'TLT', 'DIA', 'XLF', 'XLE', 'SOXL', 'SLV', 'GOOG']);
const isEtfName = (n: string) => /\bETF\b|\bTrust\b|ProShares|iShares|SPDR|\bFund\b|Direxion/i.test(n);

function atr14(d: Bar[]): number {
  const b = d.slice(-15);
  if (b.length < 7) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function stocks(ctx: DayContext): string[] {
  return Object.values(ctx.meta)
    .filter((m) => m.tags.includes('liquid') && !m.tags.includes('index') && !ETF.has(m.symbol) && !isEtfName(m.name) && m.open >= 5)
    .map((m) => m.symbol)
    .sort();
}

/** Close of the last bar at or before NY minute `upTo` (bars are in time order). */
function closeAt(ctx: MinuteContext, bars: Bar[], upTo: number): number | undefined {
  for (let i = bars.length - 1; i >= 0; i--) if (ctx.minuteOf(bars[i].t) <= upTo) return bars[i].c;
  return undefined;
}

const strategy: Strategy<P> = {
  name: 'r2_xsmom',
  universe(ctx: DayContext) {
    const s = stocks(ctx);
    return ctx.meta[SPY] ? [SPY, ...s] : s;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute !== OPEN + p.decMin) return [];
    const last = ctx.minute - 1; // newest closed bar's minute
    const spyBars = ctx.bars(SPY);
    const spyLast = spyBars.at(-1);
    if (!spyLast || ctx.minuteOf(spyLast.t) < last - 5) return [];
    const spyOpenRet = spyLast.c / ctx.meta[SPY].open - 1;
    if (p.idxMin > 0 && Math.abs(spyOpenRet) * 100 < p.idxMin) return [];
    const ref = (sym: string, bars: Bar[]) =>
      p.win === 'open' ? ctx.meta[sym].open : p.win === 'prev' ? ctx.meta[sym].prevClose : closeAt(ctx, bars, last - 30);
    const spyRef = ref(SPY, spyBars);
    const spyRet = spyRef ? spyLast.c / spyRef - 1 : 0;

    const rows: { sym: string; score: number; px: number; atr: number; atrPct: number }[] = [];
    for (const sym of stocks(ctx)) {
      const bars = ctx.bars(sym);
      const b = bars.at(-1);
      if (!b || ctx.minuteOf(b.t) < last - 5) continue; // stale / missing
      const db = ctx.dailyBefore(sym);
      const atr = atr14(db);
      const prevC = db.length ? db[db.length - 1].c : ctx.meta[sym].prevClose;
      if (!(atr > 0) || !(prevC > 0)) continue;
      const r0 = ref(sym, bars);
      if (!r0 || !(r0 > 0)) continue;
      const ret = b.c / r0 - 1;
      const atrPct = atr / prevC;
      const score = p.norm === 'raw' ? ret : p.norm === 'atr' ? ret / atrPct : (ret - spyRet) / atrPct;
      rows.push({ sym, score, px: b.c, atr, atrPct });
    }
    if (rows.length < 2 * p.K + 2) return [];
    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, p.K), bottom = rows.slice(-p.K).reverse(); // bottom[0] = weakest
    const longs = p.dir === 'mom' ? top : bottom;
    const shorts = p.dir === 'mom' ? bottom : top;
    const medAtrPct = [...rows].map((r) => r.atrPct).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const floorFrac = p.K / 190;
    const exitMinute = p.hold > 0 ? ctx.minute + p.hold : undefined;

    const mk = (r: (typeof rows)[number], side: 'long' | 'short', rank: number): Signal => {
      const base = p.sizing === 'atr' ? p.stopK * r.atr : p.stopK * medAtrPct * r.px;
      const d = Math.max(base, r.px * floorFrac);
      const lim = p.entry !== 'mkt' ? (side === 'long' ? r.px - p.limOff * r.atr : r.px + p.limOff * r.atr) : undefined;
      const e = lim ?? r.px;
      return {
        symbol: r.sym, side, stop: side === 'long' ? e - d : e + d,
        targetR: p.targetR || undefined, trailR: p.trailR || undefined, noStop: p.noStop || undefined,
        exitMinute, entryLimit: lim, limitTtl: lim !== undefined ? (p.entry === 'lim' ? p.limTtl : Number(p.entry.slice(3))) : undefined,
        tag: `${side}${rank + 1}${d > base ? 'f' : ''}`,
      };
    };
    const out: Signal[] = [];
    for (let i = 0; i < p.K; i++) out.push(mk(longs[i], 'long', i), mk(shorts[i], 'short', i));
    return out;
  },
};

export default {
  strategy,
  grid: {
    // WF4 (robustness, SHAPED BY WF1-3 results): larger baskets K 3-5 and raw vs ATR ranking at 09:45, limits off.
    K: [3, 4, 5], decMin: [15], win: ['open'], norm: ['atr', 'raw'], dir: ['mom'], sizing: ['atr'], stopK: [0.5],
    noStop: [true], targetR: [0], trailR: [0], hold: [0], entry: ['mkt', 'lim5'], limOff: [0.05], limTtl: [10], idxMin: [0],
    'rule.riskPerTrade': [100, 500], 'rule.dailyLossLimit': [0], 'rule.maxTrades': [0], 'rule.maxConcurrent': [0], 'rule.maxLosses': [0],
  },
};
