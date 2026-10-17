// r2_gapfill: gap FADE toward yesterday's close. After a gap up (down), wait for the opening move to fail,
// then trade back toward the prior close, with targets at a fraction of the gap still open (partial/full fill).
// Failure triggers (gap up shown; gap down is mirrored):
//   'orl'  : a signal bucket closes below the opening-range low (OR = first orMinutes)
//   'vwap' : a bucket closes below VWAP after the previous bucket closed at/above it (loss of VWAP)
//   'lh'   : lower high — the day's high is at least lhMinutes old and the bucket closes below the
//            previous bucket's low (and below VWAP if vwapFilter)
// The gap must still be open by at least minRemain of the original gap. Stops: day extreme ('hod'),
// opening-range opposite edge ('or'), recent swing (last 3 buckets, 'swing') or ATR-based ('atr', daily ATR14).
// Targets: fraction of the remaining gap (gapFrac, partial/full fill) or fixed targetR, or none.
// Entry: market, or a LIMIT at the signal close ± limitOff × risk (a small bounce) / at VWAP retest.
// No look-ahead: universe() reads only ctx.meta; onMinute() folds in closed bars incrementally; ATR uses
// ctx.dailyBefore (days strictly before today).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  minGap: number;            // |gap| % lower bound
  maxGap: number;            // |gap| % upper bound
  dir: 'both' | 'up' | 'down';
  minPrice: number;
  maxSymbols: number;        // candidates per day, largest |gap| first
  orMinutes: number;         // opening range length
  barMinutes: number;        // signal bucket length
  trigger: 'orl' | 'vwap' | 'lh';
  lhMinutes: number;         // 'lh': the day extreme must be at least this old
  vwapFilter: boolean;       // require close on the fade side of VWAP
  minRemain: number;         // remaining gap (|close - prevClose| / |open - prevClose|) at least this
  stopMode: 'hod' | 'or' | 'swing' | 'atr';
  stopAtr: number;           // 'atr': stop distance = stopAtr × ATR14
  stopBuf: number;           // extra buffer, % of price
  gapFrac: number;           // >0: target = this fraction of the remaining gap (1 = full fill); 0 = use targetR
  minTargetR: number;        // with gapFrac: skip if implied target < this many R
  targetR: number;           // fixed target when gapFrac = 0 (0 = none)
  breakevenAtR: number;      // 0 = off
  trailR: number;            // 0 = off
  noStop: boolean;
  holdMinutes: number;       // time exit after the signal (0 = flatten)
  cutoffMinute: number;      // last NY minute-of-day for a signal
  entry: 'market' | 'limitBounce' | 'limitVwap';
  limitOff: number;          // limitBounce: limit = close ± limitOff × risk toward the stop (better price)
  limitTtl: number;
}

interface S {
  seen: number; pv: number; vol: number;
  orHi: number; orLo: number; dHi: number; dLo: number; dHiMin: number; dLoMin: number;
  bHi: number; bLo: number; bClose: number; bIdx: number;
  prevBuckets: { h: number; l: number; c: number; vwap: number }[];
  lastMin: number;
  atr?: number;
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
  name: 'r2_gapfill',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('gap'))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && Math.abs(m.gapPct) <= p.maxGap && m.open >= p.minPrice)
      .filter((m) => p.dir === 'both' || (p.dir === 'up' ? m.gapPct > 0 : m.gapPct < 0))
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; g: number }[] = [];
    const orEnd = OPEN + p.orMinutes;
    const m = ctx.minute;
    const evalNow = m >= orEnd + p.barMinutes && (m - OPEN) % p.barMinutes === 0 && m <= p.cutoffMinute;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { seen: 0, pv: 0, vol: 0, orHi: -Infinity, orLo: Infinity, dHi: -Infinity, dLo: Infinity, dHiMin: 0, dLoMin: 0,
          bHi: -Infinity, bLo: Infinity, bClose: NaN, bIdx: -1, prevBuckets: [], lastMin: -1,
          atr: p.stopMode === 'atr' ? atr14(ctx.dailyBefore(sym)) : undefined };
        ctx.state.set(sym, s);
      }
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        const idx = Math.floor((bm - OPEN) / p.barMinutes);
        if (idx !== s.bIdx) {
          // the previous bucket has closed: keep it with the VWAP as of its close
          if (s.bIdx >= 0 && Number.isFinite(s.bClose)) {
            s.prevBuckets.push({ h: s.bHi, l: s.bLo, c: s.bClose, vwap: s.vol > 0 ? s.pv / s.vol : s.bClose });
            if (s.prevBuckets.length > 4) s.prevBuckets.shift();
          }
          s.bIdx = idx; s.bHi = -Infinity; s.bLo = Infinity;
        }
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < orEnd) { s.orHi = Math.max(s.orHi, b.h); s.orLo = Math.min(s.orLo, b.l); }
        if (b.h > s.dHi) { s.dHi = b.h; s.dHiMin = bm; }
        if (b.l < s.dLo) { s.dLo = b.l; s.dLoMin = bm; }
        s.bHi = Math.max(s.bHi, b.h); s.bLo = Math.min(s.bLo, b.l); s.bClose = b.c;
        s.lastMin = bm;
      }
      if (!evalNow) continue;
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.orHi)) continue;
      if (s.lastMin !== m - 1) continue; // the bucket must have just closed with a fresh bar
      const meta = ctx.meta[sym];
      const up = meta.gapPct > 0;
      const sgn = up ? 1 : -1; // stop side
      const close = s.bClose;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const prev = s.prevBuckets.at(-1);
      const pc = meta.prevClose;
      const gap0 = Math.abs(meta.open - pc);
      if (!(gap0 > 0)) continue;
      const remain = (close - pc) * sgn;
      if (remain / gap0 < p.minRemain) continue;

      let trig = false;
      if (p.trigger === 'orl') trig = up ? close < s.orLo : close > s.orHi;
      else if (p.trigger === 'vwap') {
        // loss of VWAP: this bucket closes beyond VWAP, the previous bucket closed on the gap side of its VWAP
        const prevSide = prev ? (prev.c - prev.vwap) * sgn : -1;
        trig = (close - vwap) * sgn < 0 && prevSide >= 0;
      } else {
        const extMin = up ? s.dHiMin : s.dLoMin;
        trig = !!prev && m - 1 - extMin >= p.lhMinutes && (up ? close < prev.l : close > prev.h);
      }
      if (p.vwapFilter && (close - vwap) * sgn >= 0) trig = false;
      if (!trig) continue;

      let stop: number;
      const buf = (close * p.stopBuf) / 100;
      if (p.stopMode === 'hod') stop = up ? s.dHi : s.dLo;
      else if (p.stopMode === 'or') stop = up ? s.orHi : s.orLo;
      else if (p.stopMode === 'swing') {
        const recent = [...s.prevBuckets.slice(-2), { h: s.bHi, l: s.bLo }];
        stop = up ? Math.max(...recent.map((x) => x.h)) : Math.min(...recent.map((x) => x.l));
      } else {
        if (!s.atr) continue;
        stop = close + sgn * p.stopAtr * s.atr;
      }
      stop += sgn * buf;
      const side = up ? 'short' : 'long';
      let ref = close;
      let entryLimit: number | undefined;
      if (p.entry === 'limitBounce') { entryLimit = close + sgn * p.limitOff * Math.abs(stop - close); ref = entryLimit; }
      else if (p.entry === 'limitVwap') { entryLimit = vwap; ref = vwap; }
      if (entryLimit !== undefined) entryLimit = Math.round(entryLimit * 100) / 100;
      const risk = (stop - ref) * sgn;
      if (!(risk > 0)) continue;
      let targetR: number | undefined = p.targetR || undefined;
      if (p.gapFrac > 0) {
        const tR = (Math.abs(ref - pc) * p.gapFrac) / risk;
        if (tR < p.minTargetR) continue;
        targetR = tR;
      }
      out.push({
        sig: {
          symbol: sym, side, stop, targetR,
          breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, noStop: p.noStop || undefined,
          exitMinute: p.holdMinutes > 0 ? m + p.holdMinutes : undefined,
          entryLimit, limitTtl: entryLimit !== undefined ? p.limitTtl : undefined,
          tag: `${p.trigger}-${up ? 'up' : 'dn'}`,
        },
        g: Math.abs(meta.gapPct),
      });
    }
    return out.sort((a, b) => b.g - a.g).map((x) => x.sig);
  },
};

export default {
  strategy,
  grid: {
    // wf run 1 (1152 cfgs): minGap [3,6] × dir [both,up,down] × orMinutes [15,30] × barMinutes [5,15] × trigger [orl,lh]
    //   × stopMode [hod,atr] × gapFrac [0,0.5,1] (targetR 2 when 0) × breakevenAtR [0,1] × cutoff [11:00,13:00] → WF −16.5R.
    // wf run 2 (shaped by run 1 + M1–M2 design exploration): gap-DOWN fades only, risk tiers, limits, entry type.
    //   (768 cfgs: trigger [orl,lh] × stopAtr [0.2,0.35] × gapFrac [0.5,1] × entry [market,limitBounce,limitVwap]
    //   × risk [50,100,200,500] × maxTrades [3,0] × maxConcurrent [2,0] × maxLosses [2,0]) → WF −8.0R.
    // wf run 3 (shaped by runs 1–2): 'lh' trigger, exits (targets/none, breakeven, trailing, noStop, time exit),
    // limitTtl, daily loss limit default (3R) vs none at risk 100.
    minGap: [6], maxGap: [100], dir: ['down'], minPrice: [5], maxSymbols: [10],
    orMinutes: [15], barMinutes: [5], trigger: ['lh'], lhMinutes: [15], vwapFilter: [true], minRemain: [0.6],
    stopMode: ['atr'], stopAtr: [0.2, 0.35], stopBuf: [0.05], gapFrac: [0, 1], minTargetR: [1], targetR: [0, 3],
    breakevenAtR: [0, 1], trailR: [0, 1.5], noStop: [false, true], holdMinutes: [0, 90], cutoffMinute: [11 * 60],
    entry: ['market', 'limitBounce', 'limitVwap'], limitOff: [0.2], limitTtl: [5, 20],
    'rule.riskPerTrade': [100], 'rule.dailyLossLimit': [300, 0],
  } as Record<string, unknown[]>,
};
