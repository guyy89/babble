// High-beta amplification (round 2).
// Idea: each name's beta to SPY is estimated from PRIOR daily close-to-close returns only (ctx.dailyBefore).
// When SPY shows a clear intraday direction early (at the decision minute: SPY return since today's first bar
// open ≥ thr % and SPY on the same side of its session VWAP), trade the highest-beta names in that direction
// (they should amplify the index move), or — mode 'low' — the lowest-beta names AGAINST it, or — controls —
// SPY / QQQ themselves with the same signal. Exit by time / flatten, optional stop/target/trail.
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore only; onMinute() folds closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  mode: 'high' | 'low' | 'lowwith' | 'spy' | 'qqq'; // lowwith: CONTROL, lowest-beta names WITH SPY
  uni: 'liquid' | 'all' | 'nogap';  // nogap: all names with |gap| ≤ maxGap
  maxGap: number;                   // % (only for uni = nogap)
  betaLb: number;                   // daily returns used for beta (uses what exists, min 15)
  minBeta: number;                  // high: beta ≥ minBeta (low mode: beta < 1)
  decMin: number;                   // decision minute after 09:30 (30 = 10:00)
  scanEnd: number;                  // 0 = one-shot at decMin; else first minute in [decMin, scanEnd] meeting the signal
  thr: number;                      // |SPY return since open| in % to call a direction
  spyVwap: boolean;                 // SPY must be on the move's side of its session VWAP
  confirm: boolean;                 // the stock itself must already be moving in the trade direction since open
  topN: number;
  dir: 'both' | 'long' | 'short';
  entry: 'mkt' | 'lim';
  limOff: number;                   // limit: ATR fraction better than the last close
  limTtl: number;
  atrK: number;                     // stop distance = atrK × daily ATR(14) from the entry reference
  noStop: boolean;                  // size from that stop but do not place it
  targetR: number;                  // 0 = none
  trailR: number;                   // 0 = off
  breakevenAtR: number;             // 0 = off
  exitMin: number;                  // 0 = flatten; else exit at this minute after 09:30
  // Optional preset overriding atrK/noStop/targetR/trailR/breakevenAtR: 'tight3' = 0.2 ATR stop + 3R target;
  // 'trail' = 0.3 ATR stop, 1R trail; 'wide' = 1 ATR stop, 2R target, breakeven at 1R;
  // 'noStopAtr' = no stop, sized from a 1 ATR stop (so R is not inflated), held to the time exit.
  exitSet?: 'none' | 'tight3' | 'trail' | 'wide' | 'noStopAtr';
}

interface S { seen: number; open: number; pv: number; vol: number; last?: Bar }

const OPEN = 9 * 60 + 30;
const SPY = 'SPY';
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

/** Beta of `sym` to SPY over the last `lb` common daily close-to-close returns (dates aligned). */
function beta(sym: Bar[], spy: Bar[], lb: number): number {
  const spyRet = new Map<string, number>();
  for (let i = 1; i < spy.length; i++) spyRet.set(dayKey(spy[i].t), spy[i].c / spy[i - 1].c - 1);
  const xs: number[] = [], ys: number[] = [];
  for (let i = sym.length - 1; i >= 1 && xs.length < lb; i--) {
    const x = spyRet.get(dayKey(sym[i].t));
    // Consecutive daily bars only (a missing day would make a multi-day return).
    if (x === undefined || !spyRet.has(dayKey(sym[i - 1].t))) continue;
    xs.push(x);
    ys.push(sym[i].c / sym[i - 1].c - 1);
  }
  if (xs.length < 15) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  return vx > 0 ? cov / vx : NaN;
}

function eligible(m: DayContext['meta'][string], p: P): boolean {
  if (p.mode === 'spy') return m.symbol === SPY;
  if (p.mode === 'qqq') return m.symbol === 'QQQ';
  if (m.tags.includes('index') || m.open < 5) return false;
  if (p.uni === 'liquid') return m.tags.includes('liquid');
  if (p.uni === 'nogap') return Math.abs(m.gapPct) <= p.maxGap;
  return true;
}

const strategy: Strategy<P> = {
  name: 'r2_beta',
  universe(ctx: DayContext, p: P) {
    if (!ctx.meta[SPY]) return [];
    const spyD = ctx.dailyBefore(SPY);
    const cands = Object.values(ctx.meta).filter((m) => eligible(m, p)).map((m) => m.symbol);
    // Beta and ATR are known at 09:30 (prior daily bars only): stash them once per (day, params) in a side map.
    const info: Record<string, { beta: number; atr: number }> = {};
    for (const s of cands) {
      // Pure function of (date, symbol, lookback) from prior daily bars: memoised across configurations.
      const k = ctx.date + '|' + s + '|' + p.betaLb;
      let v = memo.get(k);
      if (!v) memo.set(k, (v = { beta: beta(ctx.dailyBefore(s), spyD, p.betaLb), atr: dailyAtr(ctx.dailyBefore(s)) }));
      info[s] = v;
    }
    let pick = cands.filter((s) => Number.isFinite(info[s].beta) && info[s].atr > 0);
    if (p.mode === 'high') pick = pick.filter((s) => info[s].beta >= p.minBeta);
    if (p.mode === 'low' || p.mode === 'lowwith') pick = pick.filter((s) => info[s].beta < 1);
    infoByDay.set(ctx.date, Object.fromEntries(pick.map((s) => [s, info[s]])));
    return [SPY, ...pick.filter((s) => s !== SPY)];
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    const spyBars = ctx.bars(SPY);
    if (!spyBars.length) return [];
    // Fold SPY + candidates incrementally (VWAP and last close).
    const fold = (sym: string): S | undefined => {
      const bars = ctx.bars(sym);
      if (!bars.length) return undefined;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, open: bars[0].o, pv: 0, vol: 0 }));
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.last = b;
      }
      return s;
    };
    const info = infoByDay.get(ctx.date) ?? {};
    const syms = Object.keys(info);
    // Nothing is needed outside the decision window: folding is incremental from the first bar, so catching up
    // at the decision minute gives the same VWAP/last values as folding every minute.
    if (ctx.state.get('__done')) return [];
    const inWindow = p.scanEnd ? rel >= p.decMin && rel <= p.scanEnd : rel === p.decMin;
    if (!inWindow) return [];
    const spy = fold(SPY)!;
    const spyRet = (spy.last!.c / spy.open - 1) * 100;
    const spyVwap = spy.vol > 0 ? spy.pv / spy.vol : spy.last!.c;
    let mkt: 'long' | 'short' | undefined;
    if (spyRet >= p.thr && (!p.spyVwap || spy.last!.c > spyVwap)) mkt = 'long';
    else if (spyRet <= -p.thr && (!p.spyVwap || spy.last!.c < spyVwap)) mkt = 'short';
    if (!mkt) return [];
    ctx.state.set('__done', true); // one decision per day
    for (const s of syms) if (s !== SPY) fold(s);
    const side: 'long' | 'short' = p.mode === 'low' ? (mkt === 'long' ? 'short' : 'long') : mkt;
    if (p.dir !== 'both' && p.dir !== side) return [];
    const d = side === 'long' ? 1 : -1;
    let ranked = syms.filter((s) => {
      const st = ctx.state.get(s) as S | undefined;
      if (!st?.last || ctx.open.has(s) || ctx.traded.has(s)) return false;
      if (p.confirm && (st.last.c / st.open - 1) * d <= 0) return false;
      return true;
    });
    ranked.sort((a, b) => (p.mode === 'low' || p.mode === 'lowwith' ? info[a].beta - info[b].beta : info[b].beta - info[a].beta));
    ranked = ranked.slice(0, p.topN);
    const out: Signal[] = [];
    const presets: Record<string, Partial<P>> = {
      tight3: { atrK: 0.2, noStop: false, targetR: 3, trailR: 0, breakevenAtR: 0 },
      trail: { atrK: 0.3, noStop: false, targetR: 0, trailR: 1, breakevenAtR: 0 },
      wide: { atrK: 1, noStop: false, targetR: 2, trailR: 0, breakevenAtR: 1 },
      noStopAtr: { atrK: 1, noStop: true, targetR: 0, trailR: 0, breakevenAtR: 0 },
    };
    if (p.exitSet && presets[p.exitSet]) p = { ...p, ...presets[p.exitSet] };
    for (const s of ranked) {
      const st = ctx.state.get(s) as S;
      const atr = info[s].atr;
      const c = st.last!.c;
      const ref = p.entry === 'lim' ? c - d * p.limOff * atr : c;
      const stop = ref - d * p.atrK * atr;
      const sig: Signal = {
        symbol: s, side, stop: Math.round(stop * 100) / 100, tag: side,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        noStop: p.noStop || undefined,
        exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
      };
      if (p.entry === 'lim') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = p.limTtl; }
      out.push(sig);
    }
    return out;
  },
};

// Per-date beta/ATR table computed in universe() (09:30 information only); the harness calls universe() once
// per (date, config) before onMinute(), so the entry for ctx.date is always this config's own table.
const memo = new Map<string, { beta: number; atr: number }>();
const infoByDay = new Map<string, Record<string, { beta: number; atr: number }>>();

export default {
  strategy,
  grid: {
    mode: ['high'],
    uni: ['nogap'],
    maxGap: [3],
    betaLb: [30],
    minBeta: [1],
    decMin: [60, 90],
    scanEnd: [0],
    thr: [0.15, 0.25],
    spyVwap: [true],
    confirm: [false],
    topN: [2, 3],
    dir: ['both'],
    entry: ['mkt', 'lim'],
    limOff: [0.03],
    limTtl: [10],
    atrK: [0.2],
    noStop: [false],
    targetR: [3],
    trailR: [0],
    breakevenAtR: [0],
    exitMin: [0],
    exitSet: ['tight3', 'trail', 'wide', 'noStopAtr'],
    'rule.riskPerTrade': [100],
    'rule.dailyLossLimit': [300, 0],
    'rule.maxTrades': [3, 0],
  },
};
