// Regime-switching day type (round 2).
// Idea: classify each day early (at 09:30 + clsMin) as TREND or RANGE from SPY only, using information
// available then: opening-range width vs SPY's 14-day ATR, SPY gap (in ATR units), prior-day range vs ATR
// (ctx.dailyBefore) and the directional efficiency of SPY's first effWin minutes (|net move| / sum |bar moves|).
//  - TREND days: trade continuation in liquid names — a close beyond the stock's own opening range in the
//    direction of SPY's opening move (optionally also above/below the stock's VWAP).
//  - RANGE days: trade mean reversion — fade a stock that is ≥ k × daily ATR away from its session VWAP,
//    targeting VWAP (or a fixed R).
// cls 'none' = no classifier (both legs eligible every day): the control showing whether the classifier adds value.
// No look-ahead: universe() uses ctx.meta + ctx.dailyBefore only; onMinute() folds in closed bars incrementally.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'liquid' | 'liqidx';      // traded names: 'liquid' tag, or liquid + SPY/QQQ
  clsMin: number;                 // classification (and stock opening range) length in minutes after 09:30
  effWin: number;                 // SPY efficiency window (minutes from the open, ≤ clsMin)
  cls: 'none' | 'eff' | 'orw' | 'vote';
  effHi: number; effLo: number;   // efficiency thresholds: ≥ effHi trend, ≤ effLo range
  orwHi: number; orwLo: number;   // SPY OR width / ATR: ≥ orwHi trend, ≤ orwLo range
  gapT: number;                   // vote: |SPY gap| ≥ gapT ATR counts for trend
  prevT: number;                  // vote: prior-day range ≤ prevT ATR (narrow → expansion) counts for trend
  voteT: number;                  // vote: ≥ voteT votes → trend; ≤ voteR votes → range
  voteR: number;
  legs: 'both' | 'trend' | 'range';
  // TREND leg
  tEnd: number;                   // last entry minute after 09:30 for the trend leg
  tVwap: boolean;                 // require close on the trend side of the stock's VWAP
  tStop: 'or' | 'mid' | 'atr';
  tAtrK: number;                  // atr stop distance (and sizing distance for noStop), in daily ATR
  tTarget: number;                // R; 0 = none
  tLim: boolean;                  // limit entry at the broken OR level (pullback), ttl limTtl
  // RANGE leg
  rK: number;                     // stretch from VWAP ≥ rK × ATR
  rEnd: number;                   // last entry minute after 09:30 for the range leg
  rConf: boolean;                 // require the last bar to close back toward VWAP
  rStopK: number;                 // stop beyond entry reference, in ATR
  rTarget: 'vwap' | 'half' | 'r2' | 'none';  // vwap = full revert, half = half-way, r2 = 2R fixed
  rLimOff: number;                // >0: limit entry this many ATR further stretched; 0 = market
  limTtl: number;
  // common exits
  trailR: number;                 // 0 = off
  breakevenAtR: number;           // 0 = off
  noStop: boolean;                // size from the stop, exit only by target/time/close
  exitMin: number;                // 0 = flatten; else exit at 09:30 + exitMin
}

interface S {
  seen: number;
  atr: number;
  open: number;
  orHi: number; orLo: number;
  pv: number; vol: number;
  last?: Bar;
  prev?: Bar;
}

interface Spy {
  seen: number;
  atr: number;
  open: number;
  hi: number; lo: number;
  path: number; lastC: number; effNet: number; effDone: boolean;
  regime?: 'trend' | 'range' | 'none' | 'skip';
  dir: number;                     // SPY direction at classification (+1/-1)
}

const OPEN = 9 * 60 + 30;
const r2 = (x: number) => Math.round(x * 100) / 100;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 6) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

function classify(ctx: MinuteContext, p: P, sp: Spy): Spy['regime'] {
  if (p.cls === 'none') return 'none';
  if (!(sp.atr > 0) || !(sp.path > 0)) return 'skip';
  const eff = sp.effNet / sp.path;
  const orw = (sp.hi - sp.lo) / sp.atr;
  if (p.cls === 'eff') return eff >= p.effHi ? 'trend' : eff <= p.effLo ? 'range' : 'skip';
  if (p.cls === 'orw') return orw >= p.orwHi ? 'trend' : orw <= p.orwLo ? 'range' : 'skip';
  const m = ctx.meta.SPY;
  const daily = ctx.dailyBefore('SPY');
  const pd = daily.at(-1);
  const gapAtr = m ? Math.abs((m.gapPct / 100) * m.prevClose) / sp.atr : 0;
  const prevR = pd ? (pd.h - pd.l) / sp.atr : 1;
  const votes = (eff >= p.effHi ? 1 : 0) + (orw >= p.orwHi ? 1 : 0) + (gapAtr >= p.gapT ? 1 : 0) + (prevR <= p.prevT ? 1 : 0);
  return votes >= p.voteT ? 'trend' : votes <= p.voteR ? 'range' : 'skip';
}

const strategy: Strategy<P> = {
  name: 'r2_regime',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.symbol === 'SPY' || m.tags.includes('liquid') || (p.uni === 'liqidx' && m.tags.includes('index')))
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const rel = ctx.minute - OPEN;
    // --- SPY regime state ---
    let sp = ctx.state.get('$spy') as Spy | undefined;
    const sb = ctx.bars('SPY');
    if (!sp) {
      if (!sb.length) return [];
      sp = { seen: 0, atr: dailyAtr(ctx.dailyBefore('SPY')), open: sb[0].o, hi: -Infinity, lo: Infinity, path: 0, lastC: sb[0].o, effNet: 0, effDone: false, dir: 0 };
      ctx.state.set('$spy', sp);
    }
    for (; sp.seen < sb.length; sp.seen++) {
      const b = sb[sp.seen];
      const bm = ctx.minuteOf(b.t) - OPEN;
      if (bm < p.clsMin) { sp.hi = Math.max(sp.hi, b.h); sp.lo = Math.min(sp.lo, b.l); }
      if (bm < p.effWin) { sp.path += Math.abs(b.c - sp.lastC); sp.lastC = b.c; sp.effNet = Math.abs(b.c - sp.open); }
      if (bm < p.clsMin) sp.dir = Math.sign(b.c - sp.open);
    }
    if (rel < p.clsMin) {
      // still fold stock bars below so state stays incremental
    } else if (sp.regime === undefined) {
      sp.regime = classify(ctx, p, sp);
    }

    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, atr: dailyAtr(ctx.dailyBefore(sym)), open: bars[0].o, orHi: -Infinity, orLo: Infinity, pv: 0, vol: 0 };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        if (ctx.minuteOf(b.t) - OPEN < p.clsMin) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        s.prev = s.last;
        s.last = b;
      }
      if (rel < p.clsMin || !sp.regime || sp.regime === 'skip') continue;
      const m = ctx.meta[sym];
      if (!m || (sym === 'SPY' && p.uni !== 'liqidx')) continue;
      if (!m.tags.includes('liquid') && !(p.uni === 'liqidx' && m.tags.includes('index'))) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !s.last || !(s.atr > 0) || !(s.vol > 0)) continue;
      const c = s.last.c;
      const vwap = s.pv / s.vol;
      const trendOk = (sp.regime === 'trend' || sp.regime === 'none') && p.legs !== 'range';
      const rangeOk = (sp.regime === 'range' || sp.regime === 'none') && p.legs !== 'trend';
      const common = {
        trailR: p.trailR || undefined, breakevenAtR: p.breakevenAtR || undefined,
        noStop: p.noStop || undefined, exitMinute: p.exitMin ? OPEN + p.exitMin : undefined,
      };

      // TREND leg: break of the stock's opening range in SPY's direction.
      if (trendOk && rel <= p.tEnd && sp.dir !== 0 && Number.isFinite(s.orHi)) {
        const d = sp.dir;
        const broke = d > 0 ? c > s.orHi : c < s.orLo;
        const vw = !p.tVwap || (d > 0 ? c > vwap : c < vwap);
        if (broke && vw) {
          const ref = p.tLim ? (d > 0 ? s.orHi : s.orLo) : c;
          let stop: number;
          if (p.noStop || p.tStop === 'atr') stop = ref - d * p.tAtrK * s.atr;
          else if (p.tStop === 'mid') stop = (s.orHi + s.orLo) / 2;
          else stop = d > 0 ? s.orLo : s.orHi;
          if ((ref - stop) * d > 0) {
            const sig: Signal = { symbol: sym, side: d > 0 ? 'long' : 'short', stop: r2(stop), tag: `T${d > 0 ? 'L' : 'S'}`, targetR: p.tTarget || undefined, ...common };
            if (p.tLim) { sig.entryLimit = r2(ref); sig.limitTtl = p.limTtl; }
            cands.push({ sig, score: 10 + (Math.abs(c - (d > 0 ? s.orHi : s.orLo)) / s.atr) });
            continue;
          }
        }
      }

      // RANGE leg: fade a stretch of ≥ rK ATR from VWAP back toward VWAP.
      if (rangeOk && rel <= p.rEnd) {
        const dev = (c - vwap) / s.atr;
        if (Math.abs(dev) >= p.rK) {
          const d = dev > 0 ? -1 : 1; // trade direction (short when stretched up)
          const conf = !p.rConf || (s.prev !== undefined && (d < 0 ? c < s.prev.c : c > s.prev.c));
          if (conf) {
            const ref = p.rLimOff > 0 ? c - d * p.rLimOff * s.atr : c;
            const stop = ref - d * p.rStopK * s.atr;
            const risk = Math.abs(ref - stop);
            let targetR: number | undefined;
            if (p.rTarget === 'vwap') targetR = Math.abs(ref - vwap) / risk;
            else if (p.rTarget === 'half') targetR = Math.abs(ref - vwap) / 2 / risk;
            else if (p.rTarget === 'r2') targetR = 2;
            if (targetR !== undefined && targetR < 0.2) continue;
            const sig: Signal = { symbol: sym, side: d > 0 ? 'long' : 'short', stop: r2(stop), tag: `R${d > 0 ? 'L' : 'S'}`, targetR: targetR ? Math.round(targetR * 100) / 100 : undefined, ...common };
            if (p.rLimOff > 0) { sig.entryLimit = r2(ref); sig.limitTtl = p.limTtl; }
            cands.push({ sig, score: Math.abs(dev) });
          }
        }
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((x) => x.sig);
  },
};

// wf run log (strategy code unchanged across runs; only the grid changes):
//  run 1 (8 cfg, accidental: the placeholder grid — cls none/eff/orw/vote × legs trend/range, clsMin 30, ORB stop,
//         rK 0.5 vwap target) → WF -10.6R, t -1.44, FAIL.
//  run 2 (144 cfg, chosen on M1–M2 only): clsMin 60, cls none/orw/vote, legs both/range, rK 0.3/0.4/0.5,
//         rTarget 2R/none, range limit off/0.1 ATR, stop vs noStop (sized from 0.3 ATR), $100 risk, default limits
//         → WF -14.3R, t -1.17, PF 0.71, FAIL. Full-period best +24.5R (orw, range, rK 0.3, noStop).
//  run 3 (256 cfg, planned before run 2's result): range leg, cls none/orw, rK 0.4, target 2R/none, stop vs noStop,
//         market vs limit 0.1 ATR, risk tiers 50/100/200/500, maxConcurrent 2/0, maxTrades 3/0
//         → WF -18.9R, t -1.16, PF 0.71, FAIL. Full-period best +22.8R.
//  run 4 (192 cfg, planned before runs 2–3): each leg alone vs combined, cls none/orw, daily-loss limit and
//         max-losers OFF, exits: trail 0/1.5R, breakeven 0/1R, time exit 14:30 vs close; trend-leg limit at the
//         broken OR level (ttl 5/15) vs market.
export default {
  strategy,
  grid: {
    uni: ['liquid'],
    clsMin: [60],
    effWin: [30],
    cls: ['none', 'orw'],
    effHi: [0.3],
    effLo: [0.15],
    orwHi: [0.4],
    orwLo: [0.4],
    gapT: [0.4],
    prevT: [0.6],
    voteT: [2],
    voteR: [0],
    legs: ['trend', 'range', 'both'],
    tEnd: [150],
    tVwap: [true],
    tStop: ['atr'],
    tAtrK: [0.4],
    tTarget: [2],
    tLim: [false, true],
    rK: [0.4],
    rEnd: [300],
    rConf: [false],
    rStopK: [0.3],
    rTarget: ['r2'],
    rLimOff: [0],
    limTtl: [5, 15],
    trailR: [0, 1.5],
    breakevenAtR: [0, 1],
    noStop: [false],
    exitMin: [0, 300],
    'rule.riskPerTrade': [100],
    'rule.dailyLossLimit': [0],
    'rule.maxLosses': [0],
  },
};
