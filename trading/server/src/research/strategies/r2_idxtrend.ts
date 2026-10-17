// Index-driven trend following (round 2).
// Idea: let SPY/QQQ (tag 'index') define the market's intraday trend — index above VWAP and above its opening
// range (or below both), and/or index move from the open ≥ idxK × its 14-day daily ATR. While the index trends,
// trade liquid single stocks that move with it and show relative strength (long) / weakness (short) vs the index
// (stock move from open in its own ATR minus the index's), entering at market, on a limit pullback, at a VWAP
// limit, or on a break to a new session extreme. Alternatively trade the index ETFs themselves on the same signal.
// Control (idxMode 'none'): the stock's own move from the open ≥ minMoveAtr ATR at a fixed time, no index filter.
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore only; onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  trade: 'stocks' | 'index';
  idxSym: 'SPY' | 'QQQ' | 'both';        // which index defines the trend ('both' = SPY and QQQ must agree)
  idxMode: 'vwap' | 'atr' | 'combo' | 'none'; // vwap: c vs VWAP and opening range; atr: move ≥ idxK ATR; combo: both
  orMin: number;          // index opening range length (minutes)
  idxK: number;           // atr/combo: index |move from open| ≥ idxK × ATR14
  checkStart: number;     // minutes after 09:30 when signals start (30 = 10:00)
  checkEnd: number;       // last minute after 09:30 for signals (inclusive)
  minMoveAtr: number;     // stock move from open in the trend direction, in its own ATR (≥)
  moveRef: 'open' | 'prev'; // stock move measured from today's open or from the previous close (includes the gap)
  rsMin: number;         // stock ATR-move minus index ATR-move in the trend direction (≥)
  stockVwap: boolean;     // stock must close on the trend side of its own VWAP
  direction: 'both' | 'long' | 'short';
  entry: 'mkt' | 'lim' | 'vwl' | 'brk'; // lim: limit limOff ATR better than close; vwl: limit at stock VWAP; brk: market after a close at a new session extreme
  limOff: number;
  limTtl: number;
  stopMode: 'atr' | 'vwap'; // atr: atrK ATR from the entry reference; vwap: beyond VWAP by 0.1 ATR (but ≥ 0.15 ATR)
  atrK: number;
  targetR: number;        // 0 = none
  trailR: number;         // 0 = off
  breakevenAtR: number;   // 0 = off
  noStop: boolean;        // size from the stop, exit only by target/time/close
  exitMin: number;        // 0 = flatten; else time exit at this minute after 09:30
}

interface S {
  seen: number;
  atr: number;
  open: number;
  hi: number; lo: number; prevHi: number; prevLo: number;
  orHi: number; orLo: number;
  pv: number; vol: number;
  last?: Bar;
}

const OPEN = 9 * 60 + 30;
const INDEX = ['SPY', 'QQQ'];
// ETFs among the 'liquid' names are not single stocks.
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'SOXL', 'SOXS', 'TNA', 'TZA', 'UVXY', 'VXX', 'SH', 'PSQ', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV', 'TLT', 'HYG', 'EEM', 'FXI', 'KWEB', 'ARKK', 'SMH', 'XBI', 'KRE', 'GDX', 'IVV', 'VOO', 'SOXX', 'VTI', 'SPLG']);

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function fold(ctx: MinuteContext, sym: string, orMin: number): S | undefined {
  const bars = ctx.bars(sym);
  if (!bars.length) return undefined;
  let s = ctx.state.get(sym) as S | undefined;
  if (!s) {
    s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, hi: -Infinity, lo: Infinity, prevHi: -Infinity, prevLo: Infinity, orHi: -Infinity, orLo: Infinity, pv: 0, vol: 0 };
    ctx.state.set(sym, s);
  }
  for (; s.seen < bars.length; s.seen++) {
    const b = bars[s.seen];
    s.prevHi = s.hi; s.prevLo = s.lo;
    s.hi = Math.max(s.hi, b.h);
    s.lo = Math.min(s.lo, b.l);
    if (ctx.minuteOf(b.t) < OPEN + orMin) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
    s.pv += ((b.h + b.l + b.c) / 3) * b.v;
    s.vol += b.v;
    s.last = b;
  }
  return s;
}

/** +1 / -1 / 0 trend of one index, and its signed ATR move from the open. */
function idxTrend(s: S | undefined, p: P): { dir: number; move: number } {
  if (!s?.last || !(s.atr > 0) || !(s.vol > 0)) return { dir: 0, move: NaN };
  const c = s.last.c;
  const vwap = s.pv / s.vol;
  const move = (c - s.open) / s.atr;
  const vw = c > vwap && c > s.orHi ? 1 : c < vwap && c < s.orLo ? -1 : 0;
  const at = move >= p.idxK ? 1 : move <= -p.idxK ? -1 : 0;
  const dir = p.idxMode === 'vwap' ? vw : p.idxMode === 'atr' ? at : p.idxMode === 'combo' ? (vw === at ? vw : 0) : 0;
  return { dir, move };
}

const strategy: Strategy<P> = {
  name: 'r2_idxtrend',
  universe(ctx: DayContext, p: P) {
    const syms = Object.values(ctx.meta).filter((m) => m.tags.includes('index') || (p.trade === 'stocks' && m.tags.includes('liquid') && !ETF.has(m.symbol) && m.open >= 5));
    // GOOG and GOOGL are the same company: keep GOOGL only.
    return syms.map((m) => m.symbol).filter((s) => !(s === 'GOOG' && ctx.meta.GOOGL));
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    const st = new Map<string, S | undefined>();
    for (const sym of Object.keys(ctx.meta)) st.set(sym, fold(ctx, sym, p.orMin));
    if (rel < p.checkStart || rel > p.checkEnd) return [];

    // Index trend.
    const idxs = p.idxSym === 'both' ? INDEX : [p.idxSym];
    const tr = idxs.map((s) => idxTrend(st.get(s), p));
    if (tr.some((t) => !Number.isFinite(t.move))) return [];
    let idxDir = tr[0].dir;
    if (tr.some((t) => t.dir !== idxDir)) idxDir = 0;
    const idxMove = tr.reduce((a, t) => a + t.move, 0) / tr.length;
    if (p.idxMode !== 'none' && idxDir === 0) return [];
    if (p.trade === 'index' && p.idxMode === 'none') return [];

    const tradeable = p.trade === 'index' ? idxs : [...st.keys()].filter((s) => !INDEX.includes(s) && ctx.meta[s].tags.includes('liquid'));
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of tradeable) {
      const s = st.get(sym);
      if (!s?.last || !(s.atr > 0) || !(s.vol > 0)) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym)) continue;
      const c = s.last.c;
      const vwap = s.pv / s.vol;
      const move = (c - s.open) / s.atr;
      const moveSel = p.moveRef === 'prev' ? (c - ctx.meta[sym].prevClose) / s.atr : move;
      const d = p.idxMode === 'none' ? Math.sign(moveSel) : idxDir;
      if (d === 0) continue;
      const side = d > 0 ? 'long' : 'short';
      if (p.direction !== 'both' && p.direction !== side) continue;
      let score = 0;
      if (p.trade === 'stocks') {
        if (d * moveSel < p.minMoveAtr) continue;
        const rs = d * (move - idxMove);
        if (p.idxMode !== 'none' && rs < p.rsMin) continue;
        score = d * moveSel;
      }
      if (p.stockVwap && d * (c - vwap) <= 0) continue;
      if (p.entry === 'brk' && !(d > 0 ? c > s.prevHi : c < s.prevLo)) continue;
      let ref = c;
      if (p.entry === 'lim') ref = c - d * p.limOff * s.atr;
      else if (p.entry === 'vwl') ref = vwap;
      let stop = p.stopMode === 'atr' ? ref - d * p.atrK * s.atr : vwap - d * 0.1 * s.atr;
      if (p.stopMode === 'vwap' && d * (ref - stop) < 0.15 * s.atr) stop = ref - d * 0.15 * s.atr;
      if (d * (ref - stop) <= 0) continue;
      const sig: Signal = {
        symbol: sym, side, stop: Math.round(stop * 100) / 100, tag: side,
        targetR: p.targetR || undefined,
        trailR: p.trailR || undefined,
        breakevenAtR: p.breakevenAtR || undefined,
        noStop: p.noStop || undefined,
        exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
      };
      if (p.entry === 'lim' || p.entry === 'vwl') { sig.entryLimit = Math.round(ref * 100) / 100; sig.limitTtl = p.limTtl; }
      cands.push({ sig, score });
    }
    return cands.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

// Design (M1+M2 only, scratch runAll, limits off): market/limit entries on stocks after the index trend is confirmed
// (10:00+) lost money; the edge sat in liquid names already ≥0.5–1 ATR from the previous close by 09:45–10:15
// with the index trending the same way (index > VWAP and 5-min OR, or index ≥0.2 ATR from the open), held to the close.
// wf run 1 (108 cfg): idxMode none/vwap/atr × checkEnd 30/45/60 × minMove 0.5/0.7/1 × mkt/lim × noStop, limits off, $100
//   → WF +7.5R, t 0.36, PF 1.08, 330 trades, FAIL (PF, t, stress, concentration). Full-period plateau ~+40–46R mostly from M1–M2.
// wf run 2: index-filtered core (vwap/atr, 0.7 ATR, by 10:15) × risk tiers × maxTrades 3/0 × maxConcurrent 2/0 (daily loss limit
//   default 3R) × mkt/lim (ttl 10/30) × noStop. Pre-planned from the design period, not tuned on run 1.
//   → WF +17.6R, t 1.47, PF 1.69, 88 trades, 4/4 months +, stress +16.6R, FAIL (t only). Long +19.5R / short -1.9R.
// wf run 3: exits (pre-planned from design grid g4): noStop vs ATR stop 0.5/1, target 0/3R, trail 0/2R, breakeven 0/1R,
//   time exit 14:30 vs close; mkt vs lim (ttl 20, the design default); $100, default limits.
//   → WF +19.8R, t 2.33, PF 2.53, 65 trades, 4/4 months +, stress +17.9R, PASS. Long +19.3R / short +0.5R. Picks: vwap, lim, noStop.
// wf run 4: trade the index ETFs themselves on the same trend signal (pre-planned; design grid g4b was weak).
//   → WF +3.4R, t 0.39, PF 1.26, 47 trades, 2/4 months, FAIL. Index ETFs themselves: no edge.
// Post-hoc (after run 3, full period, fixed core config): the same entry/exit WITHOUT the index filter (idxMode none)
// made as much or more in the test months (+26R lim / +33R mkt vs +19.6R), so the index filter adds no measurable value;
// the profit is the early-mover/hold-to-close effect and is long-side only. Grid below = run 3 (the passing run).
export default {
  strategy,
  grid: {
    trade: ['stocks'],
    idxSym: ['both'],
    idxMode: ['vwap', 'atr'],
    orMin: [5],
    idxK: [0.2],
    checkStart: [15],
    checkEnd: [45],
    minMoveAtr: [0.7],
    moveRef: ['prev'],
    rsMin: [-9],
    stockVwap: [true],
    direction: ['both'],
    entry: ['mkt', 'lim'],
    limOff: [0.1],
    limTtl: [20],
    stopMode: ['atr'],
    atrK: [0.5, 1.0],
    targetR: [0, 3],
    trailR: [0, 2],
    breakevenAtR: [0, 1],
    noStop: [true, false],
    exitMin: [0, 300],
    'rule.riskPerTrade': [100],
  },
};
