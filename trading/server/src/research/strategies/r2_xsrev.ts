// r2_xsrev: cross-sectional INTRADAY REVERSAL, market-neutral basket (round 2).
// At one decision minute (e.g. 11:00/12:00/13:00/14:00) rank the liquid single stocks (tag 'liquid'; ETFs and the
// duplicate GOOG share class excluded; univ 'all' adds the 'gap' stocks) by their return over a lookback window,
// then go LONG the K biggest losers and SHORT the K biggest winners. Every leg carries the same $ risk (sized from
// its own stop distance), so the basket is risk-balanced and the common market move largely cancels.
// Lookback:       'w30' / 'w60' / 'w90' = last close / close N minutes earlier − 1;  'open' = last close / today's open − 1.
// Normalisation:  'raw' = return;  'atr' = return / daily ATR%;  'xatr' = (return − SPY return) / ATR%;
//                 'ivol' = return / (today's 1-minute realised vol × √lookback minutes).
// minAbs: pair i (i-th loser, i-th winner) is traded only if both |return / ATR%| ≥ minAbs (0 = always).
// Stop/sizing distance d = max(stopK × ATR14, price × K/190). The floor makes the whole basket fit the buying power
// at every tier: notional per leg = risk / (d/price) ≤ 190 × risk, so 2K legs ≤ 380 × risk < 400 × risk (4 × equity);
// it also keeps a leg under the 200 × risk position cap. noStop = size from d but place no stop (time/flatten exit).
// Signals are interleaved (long #1, short #1, long #2, …) so a refused leg leaves the basket nearly balanced.
// No look-ahead: universe() uses ctx.meta only; ATR from ctx.dailyBefore(); scores use only closed bars.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  K: number;                       // names per side
  decMin: number;                  // decision minute after 09:30 (90 = 11:00)
  lb: 'w30' | 'w60' | 'w90' | 'open';
  norm: 'raw' | 'atr' | 'xatr' | 'ivol';
  minAbs: number;                  // min |ATR-normalised move| for both names of a pair (0 = off)
  univ: 'liq' | 'all';
  stopK: number;                   // stop / sizing distance in daily-ATR units (subject to the basket floor)
  noStop: boolean;
  targetR: number;                 // 0 = none
  beR: number;                     // breakeven at this R (0 = off)
  trailR: number;                  // 0 = off
  hold: number;                    // 0 = to the flatten; else exit this many minutes after the decision
  entry: 'mkt' | 'lim';
  limOff: number;                  // limit: ATR fraction better than the last close
  limTtl: number;
}

const OPEN = 9 * 60 + 30;
const SPY = 'SPY';
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'IVV', 'VOO', 'GLD', 'TQQQ', 'SQQQ', 'SMH', 'SOXX', 'HYG', 'TLT', 'DIA', 'XLF', 'XLE', 'SOXL', 'SLV', 'GOOG']);
const isEtfName = (n: string) => /\bETF\b|\bTrust\b|ProShares|iShares|SPDR|\bFund\b|Direxion|\bShares\b/i.test(n);

function atr14(d: Bar[]): number {
  const b = d.slice(-15);
  if (b.length < 7) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function stocks(ctx: DayContext, univ: P['univ']): string[] {
  return Object.values(ctx.meta)
    .filter((m) => (m.tags.includes('liquid') || (univ === 'all' && m.tags.includes('gap'))) && !m.tags.includes('index'))
    .filter((m) => !ETF.has(m.symbol) && !isEtfName(m.name) && m.open >= 5)
    .map((m) => m.symbol)
    .sort();
}

/** Close of the last bar at or before NY minute `upTo` (bars are in time order). */
function closeAt(ctx: MinuteContext, bars: Bar[], upTo: number): number | undefined {
  for (let i = bars.length - 1; i >= 0; i--) if (ctx.minuteOf(bars[i].t) <= upTo) return bars[i].c;
  return undefined;
}

const LBMIN: Record<P['lb'], number> = { w30: 30, w60: 60, w90: 90, open: 0 };

const strategy: Strategy<P> = {
  name: 'r2_xsrev',
  universe(ctx: DayContext, p: P) {
    const s = stocks(ctx, p.univ);
    return ctx.meta[SPY] ? [SPY, ...s] : s;
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute !== OPEN + p.decMin) return [];
    const last = ctx.minute - 1; // newest closed bar's minute
    const lbm = LBMIN[p.lb];
    const ref = (sym: string, bars: Bar[]) => (p.lb === 'open' ? ctx.meta[sym].open : closeAt(ctx, bars, last - lbm));
    const spyBars = ctx.bars(SPY);
    const spyLast = spyBars.at(-1);
    const spyRef = spyLast ? ref(SPY, spyBars) : undefined;
    const spyRet = spyLast && spyRef ? spyLast.c / spyRef - 1 : 0;
    const winMin = p.lb === 'open' ? ctx.minute - OPEN : lbm;

    const rows: { sym: string; score: number; z: number; px: number; atr: number }[] = [];
    for (const sym of stocks(ctx, p.univ)) {
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
      const z = ret / atrPct;
      let score: number;
      if (p.norm === 'raw') score = ret;
      else if (p.norm === 'atr') score = z;
      else if (p.norm === 'xatr') score = (ret - spyRet) / atrPct;
      else {
        // realised 1-minute vol from today's closed bars (computed once, at the decision)
        let s2 = 0, n = 0;
        for (let i = 1; i < bars.length; i++) { const x = Math.log(bars[i].c / bars[i - 1].c); s2 += x * x; n++; }
        const sd = n > 10 ? Math.sqrt(s2 / n) : NaN;
        if (!(sd > 0)) continue;
        score = ret / (sd * Math.sqrt(winMin));
      }
      rows.push({ sym, score, z, px: b.c, atr });
    }
    if (rows.length < 2 * p.K + 2) return [];
    rows.sort((a, b) => a.score - b.score);              // rows[0] = biggest loser
    const losers = rows.slice(0, p.K);
    const winners = rows.slice(-p.K).reverse();           // winners[0] = biggest winner
    const floorFrac = p.K / 190;
    const exitMinute = p.hold > 0 ? ctx.minute + p.hold : undefined;

    const mk = (r: (typeof rows)[number], side: 'long' | 'short', rank: number): Signal => {
      const base = p.stopK * r.atr;
      const d = Math.max(base, r.px * floorFrac);
      const lim = p.entry === 'lim' ? (side === 'long' ? r.px - p.limOff * r.atr : r.px + p.limOff * r.atr) : undefined;
      const e = lim ?? r.px;
      return {
        symbol: r.sym, side, stop: side === 'long' ? e - d : e + d,
        targetR: p.targetR || undefined, breakevenAtR: p.beR || undefined, trailR: p.trailR || undefined, noStop: p.noStop || undefined,
        exitMinute, entryLimit: lim, limitTtl: lim !== undefined ? p.limTtl : undefined,
        tag: `${side}${rank + 1}${d > base ? 'f' : ''}`,
      };
    };
    const out: Signal[] = [];
    for (let i = 0; i < p.K; i++) {
      if (p.minAbs > 0 && (Math.abs(losers[i].z) < p.minAbs || Math.abs(winners[i].z) < p.minAbs)) continue;
      if (losers[i].score >= winners[i].score) continue;
      out.push(mk(losers[i], 'long', i), mk(winners[i], 'short', i));
    }
    return out;
  },
};

export default {
  strategy,
  grid: {
    K: [2, 3], decMin: [90, 210, 270], lb: ['w30', 'open'], norm: ['atr'], minAbs: [0], univ: ['liq'],
    stopK: [0.25, 0.5, 1], noStop: [false], targetR: [0, 1, 2], beR: [0], trailR: [0, 1], hold: [120, 0],
    entry: ['mkt'], limOff: [0.05], limTtl: [10],
    'rule.riskPerTrade': [100], 'rule.dailyLossLimit': [0], 'rule.maxTrades': [0], 'rule.maxConcurrent': [0], 'rule.maxLosses': [0],
  },
};
