// r2_first30: the first 15/30/45 minutes' direction predicts the rest of the day.
//   At 09:30 + entryMin (one decision per day), for each universe name measure the move from the open (ref 'open'),
//   from the previous close (ref 'prev'), or require both to agree (ref 'both'), in units of the 14-day daily ATR.
//   If |move| ≥ thrAtr × ATR, trade in that direction ('follow') — or against it ('fade', the symmetric control).
//   Optional filters: price on the trade's side of the session VWAP; direction filter; the strongest N names only.
//   Entry: market (next bar open) or LIMIT at a pullback toward VWAP / the open (limit = close − pb × (close − anchor)).
//   Risk/sizing: the stop is always stopAtr × ATR from the signal close, so position size is the same whether the
//   stop is placed or not (noStop: sized from that distance, exits only by target/time/close). This keeps R honest.
//   Exits: target R, trailing R, breakeven, time exit at 09:30 + exitMin, or the harness flatten (15:55).
// No look-ahead: universe() uses ctx.meta + dailyBefore only; onMinute() uses closed bars only, folded incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  entryMin: number;                        // decision at 09:30 + entryMin (15/30/45)
  uni: 'gap' | 'liquid' | 'all' | 'index'; // all = gap + liquid (index ETFs excluded)
  minPrice: number;
  ref: 'open' | 'prev' | 'both';
  thrAtr: number;                          // |move| ≥ thrAtr × ATR14
  mode: 'follow' | 'fade';
  dir: 'both' | 'long' | 'short' | 'with-gap';
  vwapFilter: boolean;                     // follow-side close must be on the trade side of VWAP
  maxSignals: number;                      // strongest N by |move|/ATR (0 = all)
  entry: 'market' | 'limit';
  anchor: 'vwap' | 'open';                 // limit pullback anchor
  pb: number;                              // fraction of the way from close toward the anchor
  limitTtl: number;
  stopAtr: number;                         // stop / sizing distance in ATR units
  noStop: boolean;
  targetR: number;                         // 0 = none
  trailR: number;                          // 0 = off
  breakevenAtR: number;                    // 0 = off
  exitMin: number;                         // time exit at 09:30 + exitMin (0 = harness flatten)
  // Bundles (override the individual fields when set) so a grid can vary them jointly without duplicates:
  plan: '' | 'market' | 'open30_15' | 'open30_45' | 'vwap60_15' | 'vwap60_45'; // entry type/anchor/pullback/ttl
  risk: '' | 'ns05' | 'st05' | 'st10' | 'ns10';                                 // noStop/stop x stopAtr
}

const PLAN: Record<string, Partial<P>> = {
  market: { entry: 'market' },
  open30_15: { entry: 'limit', anchor: 'open', pb: 0.3, limitTtl: 15 },
  open30_45: { entry: 'limit', anchor: 'open', pb: 0.3, limitTtl: 45 },
  vwap60_15: { entry: 'limit', anchor: 'vwap', pb: 0.6, limitTtl: 15 },
  vwap60_45: { entry: 'limit', anchor: 'vwap', pb: 0.6, limitTtl: 45 },
};
const RISK: Record<string, Partial<P>> = {
  ns05: { noStop: true, stopAtr: 0.5 }, ns10: { noStop: true, stopAtr: 1 },
  st05: { noStop: false, stopAtr: 0.5 }, st10: { noStop: false, stopAtr: 1 },
};

interface S { seen: number; first?: number; last?: Bar; pv: number; vol: number; atr?: number }

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
  name: 'r2_first30',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => (p.uni === 'index' ? m.tags.includes('index') : !m.tags.includes('index')))
      .filter((m) => p.uni === 'index' || (p.uni === 'all' ? m.tags.includes('gap') || m.tags.includes('liquid') : m.tags.includes(p.uni)))
      .filter((m) => m.open >= p.minPrice)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, pIn: P): Signal[] {
    const p: P = { ...pIn, ...(pIn.plan ? PLAN[pIn.plan] : {}), ...(pIn.risk ? RISK[pIn.risk] : {}) };
    if (ctx.minute > OPEN + p.entryMin) return [];
    const decide = ctx.minute === OPEN + p.entryMin;
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, pv: 0, vol: 0 }));
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        if (s.first === undefined) {
          if (ctx.minuteOf(b.t) !== OPEN) { s.first = NaN; } else s.first = b.o; // need the 09:30 bar
        }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.last = b;
      }
      if (!decide || !s.last || !(s.first! > 0) || ctx.open.has(sym) || ctx.traded.has(sym)) continue;
      // Only act on a fresh last bar (the bar of the minute just closed).
      if (ctx.minuteOf(s.last.t) < ctx.minute - 2) continue;
      if (s.atr === undefined) s.atr = atr14(ctx.dailyBefore(sym)) ?? NaN;
      const atr = s.atr;
      if (!(atr > 0)) continue;
      const c = s.last.c;
      const mOpen = (c - s.first!) / atr;
      const mPrev = (c - ctx.meta[sym].prevClose) / atr;
      let mv: number;
      if (p.ref === 'open') mv = mOpen;
      else if (p.ref === 'prev') mv = mPrev;
      else { if (Math.sign(mOpen) !== Math.sign(mPrev)) continue; mv = Math.sign(mOpen) * Math.min(Math.abs(mOpen), Math.abs(mPrev)); }
      if (!(Math.abs(mv) >= p.thrAtr)) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : c;
      if (p.vwapFilter && (mv > 0 ? c <= vwap : c >= vwap)) continue;
      const long = (mv > 0) === (p.mode === 'follow');
      if (p.dir === 'long' && !long) continue;
      if (p.dir === 'short' && long) continue;
      if (p.dir === 'with-gap' && long !== ctx.meta[sym].gapPct > 0) continue;
      const stop = long ? c - p.stopAtr * atr : c + p.stopAtr * atr;
      const sig: Signal = {
        symbol: sym, side: long ? 'long' : 'short', stop,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
        noStop: p.noStop || undefined,
        tag: long ? 'long' : 'short',
      };
      if (p.entry === 'limit') {
        const a = p.anchor === 'vwap' ? vwap : s.first!;
        // Anchor must be on the pullback side of the close; otherwise use a small fixed pullback (0.05 ATR).
        const dist = long ? c - a : a - c;
        const back = dist > 0 ? p.pb * dist : 0.05 * atr;
        const lim = long ? c - back : c + back;
        if (long ? lim <= stop : lim >= stop) continue;
        sig.entryLimit = Math.round(lim * 100) / 100;
        sig.limitTtl = p.limitTtl;
      }
      cands.push({ sig, score: Math.abs(mv) });
    }
    cands.sort((a, b) => b.score - a.score);
    return (p.maxSignals > 0 ? cands.slice(0, p.maxSignals) : cands).map((x) => x.sig);
  },
};

export default {
  strategy,
  // Run 3 (SHAPED BY TEST-MONTH RESULTS — see report): simplest variant, market entry, hold to the close with
  // sizing from a 0.5-ATR stop distance, all signals taken (limits off).
  grid: {
    entryMin: [15, 30], uni: ['liquid'], minPrice: [5], ref: ['prev'], thrAtr: [0.4, 0.6, 0.8], mode: ['follow'], dir: ['both', 'long'], vwapFilter: [false],
    maxSignals: [0], entry: ['market'], anchor: ['vwap'], pb: [0.3], limitTtl: [15], stopAtr: [0.5], noStop: [true],
    targetR: [0], trailR: [0], breakevenAtR: [0], exitMin: [0], plan: ['market'], risk: ['ns05'],
    'rule.riskPerTrade': [100, 500],
    'rule.maxTrades': [0], 'rule.maxConcurrent': [0], 'rule.maxLosses': [0], 'rule.dailyLossLimit': [0],
  },
};
