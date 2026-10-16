// Gap family: (1) gap FADE — trade a large opening gap back toward yesterday's close once the first
// N minutes fail to extend it; (2) gap-and-GO — trade with a gap that holds, on the break of the
// first-N-minute extreme (or on the first pullback after that break that holds).
// No look-ahead: universe() reads only ctx.meta (09:30 info); onMinute() folds in closed bars only.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'fade' | 'go';
  minGap: number;          // |gap| % lower bound
  maxGap: number;          // |gap| % upper bound (cap)
  dir: 'both' | 'up' | 'down'; // which gap direction to trade
  minPrice: number;
  maxPrice: number;
  minAvgVol: number;       // 20-day avg daily volume (IEX units)
  maxSymbols: number;      // candidates per day, largest |gap| first
  n: number;               // opening window minutes
  barMinutes: number;      // evaluate on completed buckets of this length (1 = every minute)
  // fade
  confirm: 'orl' | 'vwap' | 'mid'; // fade trigger: close beyond window extreme / beyond VWAP / beyond window mid (no new extreme)
  fadeTarget: number;      // 0 = fixed targetR; >0 = fraction of the remaining gap to prevClose as target
  minTargetR: number;      // fade with fadeTarget>0: skip if the implied target is < this many R
  // go
  goEntry: 'break' | 'pb'; // break of window extreme, or first pullback that holds after the break
  hold: number;            // go: window must keep this fraction of the gap (0 = just not filled)
  goStop: 'lo' | 'mid';    // go: stop at opposite window extreme or window mid
  // common
  stopBuf: number;         // extra stop buffer, % of price
  targetR: number;         // 0 = no target
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  rank: 'gap' | 'gapAsc' | 'rvol' | 'retrace'; // order of simultaneous signals (maxConcurrent=2 binds)
  minRvol: number;         // opening-window volume per minute / (avgVolume/390); 0 = off
  cutoff: number;          // minutes after the open after which no new entries
  exitAfter: number;       // minutes after the open to time-exit (0 = flatten)
}

interface S {
  wVol: number;
  seen: number; wHi: number; wLo: number; dHi: number; dLo: number; pv: number; vol: number;
  last?: Bar; lastMin: number; bucketHi: number; bucketLo: number; bucketClose: number;
  // pullback state (go/pb)
  broke: boolean; pbTouched: boolean; pbLow: number; pbHigh: number; prev?: { h: number; l: number };
}

const OPEN = 9 * 60 + 30;

const strategy: Strategy<P> = {
  name: 'gap',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => m.tags.includes('gap'))
      .filter((m) => Math.abs(m.gapPct) >= p.minGap && Math.abs(m.gapPct) <= p.maxGap)
      .filter((m) => p.dir === 'both' || (p.dir === 'up' ? m.gapPct > 0 : m.gapPct < 0))
      .filter((m) => m.open >= p.minPrice && m.open <= p.maxPrice && m.avgVolume >= p.minAvgVol)
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, p.maxSymbols)
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; g: number; rv: number; rt: number }[] = [];
    const winEnd = OPEN + p.n;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        s = { wVol: 0, seen: 0, wHi: -Infinity, wLo: Infinity, dHi: -Infinity, dLo: Infinity, pv: 0, vol: 0, lastMin: -1,
          bucketHi: -Infinity, bucketLo: Infinity, bucketClose: NaN, broke: false, pbTouched: false, pbLow: Infinity, pbHigh: -Infinity };
        ctx.state.set(sym, s);
      }
      const meta = ctx.meta[sym];
      const up = meta.gapPct > 0;
      const sgn = up ? 1 : -1;
      let newBucket = false;
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (bm < winEnd) { s.wVol += b.v; s.wHi = Math.max(s.wHi, b.h); s.wLo = Math.min(s.wLo, b.l); }
        // bucket aggregation for post-window signal bars
        const bucketStart = Math.floor((bm - OPEN) / p.barMinutes);
        const lastBucket = s.lastMin < 0 ? -1 : Math.floor((s.lastMin - OPEN) / p.barMinutes);
        if (bucketStart !== lastBucket) { s.bucketHi = -Infinity; s.bucketLo = Infinity; }
        s.bucketHi = Math.max(s.bucketHi, b.h); s.bucketLo = Math.min(s.bucketLo, b.l); s.bucketClose = b.c;
        // go/pb: track break + pullback using bars after the window (before updating dHi/dLo)
        if (p.variant === 'go' && p.goEntry === 'pb' && bm >= winEnd && Number.isFinite(s.wHi)) {
          const ext = up ? s.wHi : s.wLo;
          if (!s.broke) {
            if (up ? b.c > ext : b.c < ext) { s.broke = true; s.pbLow = Infinity; s.pbHigh = -Infinity; }
          } else {
            const vwapNow = s.vol > 0 ? s.pv / s.vol : b.c;
            if (up ? b.l <= Math.max(ext, vwapNow) : b.h >= Math.min(ext, vwapNow)) s.pbTouched = true;
            if (s.pbTouched) { s.pbLow = Math.min(s.pbLow, b.l); s.pbHigh = Math.max(s.pbHigh, b.h); }
          }
        }
        s.prev = s.last ? { h: s.last.h, l: s.last.l } : undefined;
        s.dHi = Math.max(s.dHi, b.h); s.dLo = Math.min(s.dLo, b.l);
        s.last = b; s.lastMin = bm;
        newBucket = true;
      }
      const m = ctx.minute;
      if (m < winEnd + p.barMinutes || (m - OPEN) % p.barMinutes !== 0) continue;
      if (m > OPEN + p.cutoff) continue;
      if (!newBucket || s.lastMin !== m - 1) continue; // need a fresh bar that closes the bucket
      if (ctx.traded.has(sym) || ctx.open.has(sym) || !Number.isFinite(s.wHi)) continue;
      const close = s.bucketClose;
      const vwap = s.vol > 0 ? s.pv / s.vol : close;
      const buf = (close * p.stopBuf) / 100;
      const pc = meta.prevClose;
      const rv = meta.avgVolume > 0 ? s.wVol / p.n / (meta.avgVolume / 390) : 0;
      if (p.minRvol > 0 && rv < p.minRvol) continue;
      const rt = (s.wHi > s.wLo ? (up ? s.wHi - close : close - s.wLo) / (s.wHi - s.wLo) : 0);
      const exitMinute = p.exitAfter > 0 ? OPEN + p.exitAfter : undefined;
      const common = { breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined, exitMinute };

      if (p.variant === 'fade') {
        // against the gap: short a gap-up, long a gap-down
        const side = up ? 'short' : 'long';
        const winMid = (s.wHi + s.wLo) / 2;
        const extreme = up ? s.dHi : s.dLo;          // morning extreme so far
        const noNewExt = up ? s.dHi <= s.wHi : s.dLo >= s.wLo;
        let trig = false;
        if (p.confirm === 'orl') trig = up ? close < s.wLo : close > s.wHi;
        else if (p.confirm === 'vwap') trig = noNewExt && (up ? close < vwap && close < winMid : close > vwap && close > winMid);
        else trig = noNewExt && (up ? close < winMid : close > winMid);
        if (!trig) continue;
        // gap must still be open (price on the gap side of yesterday's close)
        if (up ? close <= pc : close >= pc) continue;
        const stop = extreme + sgn * buf;
        const risk = Math.abs(stop - close);
        if (risk <= 0) continue;
        let targetR: number | undefined = p.targetR || undefined;
        if (p.fadeTarget > 0) {
          const tgtR = (Math.abs(close - pc) * p.fadeTarget) / risk;
          if (tgtR < p.minTargetR) continue;
          targetR = tgtR;
        }
        out.push({ sig: { symbol: sym, side, stop, targetR, ...common, tag: `fade-${up ? 'up' : 'dn'}` }, g: Math.abs(meta.gapPct), rv, rt });
      } else {
        // with the gap; the gap must hold through the window
        const gap = meta.open - pc;
        const holdLevel = pc + gap * p.hold;
        if (up ? s.wLo <= holdLevel : s.wHi >= holdLevel) continue;
        if (up ? s.dLo <= holdLevel : s.dHi >= holdLevel) continue;
        const side = up ? 'long' : 'short';
        let stop: number;
        if (p.goEntry === 'break') {
          const trig = up ? close > s.wHi && close > vwap : close < s.wLo && close < vwap;
          if (!trig) continue;
          const base = p.goStop === 'mid' ? (s.wHi + s.wLo) / 2 : up ? s.wLo : s.wHi;
          stop = base - sgn * buf;
        } else {
          if (!s.broke || !s.pbTouched || !s.prev) continue;
          // resumption: bar closes beyond the previous bar's extreme, still on the right side of VWAP
          const trig = up ? close > s.prev.h && close > vwap : close < s.prev.l && close > 0 && close < vwap;
          if (!trig) continue;
          stop = (up ? s.pbLow : s.pbHigh) - sgn * buf;
          if (p.goStop === 'lo') stop = up ? Math.min(stop, s.wLo - buf) : Math.max(stop, s.wHi + buf);
        }
        if (up ? stop >= close : stop <= close) continue;
        out.push({ sig: { symbol: sym, side, stop, targetR: p.targetR || undefined, ...common, tag: `go-${up ? 'up' : 'dn'}` }, g: Math.abs(meta.gapPct), rv, rt });
      }
    }
    const key = (x: { g: number; rv: number; rt: number }) => (p.rank === 'gap' ? x.g : p.rank === 'gapAsc' ? -x.g : p.rank === 'rvol' ? x.rv : x.rt);
    return out.sort((a, b) => key(b) - key(a)).map((x) => x.sig);
  },
};

export default {
  strategy,
  grid: {
    variant: ['fade'],
    minGap: [3, 4, 5], maxGap: [100], dir: ['up'], minPrice: [5], maxPrice: [200], minAvgVol: [100_000], maxSymbols: [10],
    n: [4, 5, 6], barMinutes: [5],
    confirm: ['mid'], fadeTarget: [0], minTargetR: [1],
    goEntry: ['break'], hold: [0], goStop: ['lo'],
    stopBuf: [0.1], targetR: [2.5, 3, 4], breakevenAtR: [0], trailR: [0], rank: ['gap'], minRvol: [0], cutoff: [120], exitAfter: [0],
  } as Record<string, unknown[]>,
};
