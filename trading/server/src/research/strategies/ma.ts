// ma: moving-average strategies on N-minute bars aggregated from 1-minute bars (buckets aligned to 09:30).
//   variant 'pullback': EMA(fast) > EMA(slow), both rising (mirror for shorts); a bucket pulls back to the
//                       fast EMA (low <= fast EMA, close holds the slow EMA); the next bucket resumes
//                       (closes beyond the pullback bucket's high/low) -> enter at the next minute's open.
//                       Stop beyond the pullback extreme (or the slow EMA, whichever is farther).
//   variant 'cross':    EMA(fast) crosses EMA(slow) on a bucket close; optional direction filter (gap / VWAP),
//                       chop filters (slow-EMA slope, minimum post-cross separation). Stop beyond the
//                       extreme of the last `stopBars` buckets.
// No look-ahead: universe() uses only meta; onMinute() only folds in closed 1-minute bars (t < ctx.minute),
// and a bucket [a, a+N) is evaluated only once ctx.minute >= a+N (all its bars have closed).
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  variant: 'pullback' | 'cross';
  barMinutes: number;
  emas: string;              // 'fast/slow' EMA lengths in buckets, e.g. '9/21'
  warm: number;              // completed buckets required before signals (EMAs seeded with the first close)
  minRiskPct: number;        // widen the stop to at least this % of price (0 = off)
  tags: 'gap' | 'liquid' | 'index' | 'liquid+index' | 'all';
  minGap: number;            // |gap| % (applies to 'gap' tagged symbols only)
  minPrice: number;
  maxPrice: number;
  maxSymbols: number;
  direction: 'both' | 'with-gap' | 'vwap' | 'gap+vwap' | 'long';
  minSepPct: number;         // |fast-slow|/price % required at signal (0 = off)
  minSlopePct: number;       // slow-EMA change over the last bucket, % of price, in trade direction (0 = only sign for pullback)
  pbTolPct: number;          // pullback touch tolerance: low <= fast*(1+tol%)
  stopBars: number;          // cross: stop beyond extreme of last N buckets
  stopBufPct: number;        // extra stop buffer, % of price
  maxRiskPct: number;        // skip if stop distance > this % of price (0 = off)
  startMin: number;          // earliest entry, minutes after 09:30
  endMin: number;            // latest entry, minutes after 09:30
  targetR: number;           // 0 = none
  breakevenAtR: number;      // 0 = off
  trailR: number;            // 0 = off
  holdMinutes: number;       // 0 = off
  reentry: boolean;          // allow another entry on a symbol already traded today
}

interface Bk { o: number; h: number; l: number; c: number }
interface S {
  seen: number;
  pv: number; vol: number;
  cur?: Bk; curIdx: number;      // bucket being built
  hist: Bk[];                     // completed buckets
  ef?: number; es?: number; efPrev?: number; esPrev?: number;
  pbLong?: { hi: number; lo: number; age: number };   // pending long pullback bucket
  pbShort?: { hi: number; lo: number; age: number };
}

const OPEN = 9 * 60 + 30;

function universe(ctx: DayContext, p: P): string[] {
  const ok = (tags: string[]) =>
    p.tags === 'all' ? true : p.tags === 'liquid+index' ? tags.includes('liquid') || tags.includes('index') : tags.includes(p.tags);
  const metaList = Object.values(ctx.meta)
    .filter((m) => ok(m.tags) && m.open >= p.minPrice && m.open <= p.maxPrice)
    .filter((m) => !m.tags.includes('gap') || p.tags !== 'gap' || Math.abs(m.gapPct) >= p.minGap);
  metaList.sort((a, b) => (p.tags === 'gap' ? Math.abs(b.gapPct) - Math.abs(a.gapPct) : b.avgVolume * b.open - a.avgVolume * a.open));
  return metaList.slice(0, p.maxSymbols).map((m) => m.symbol);
}

const strategy: Strategy<P> = {
  name: 'ma',
  universe,
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    const N = p.barMinutes;
    const [fast, slow] = p.emas.split('/').map(Number);
    const af = 2 / (fast + 1);
    const as = 2 / (slow + 1);
    const boundary = (ctx.minute - OPEN) % N === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, pv: 0, vol: 0, curIdx: -1, hist: [] }));
      const st = s;
      const finalize = () => {
        if (!st.cur) return;
        const b = st.cur;
        st.hist.push(b);
        st.efPrev = st.ef; st.esPrev = st.es;
        st.ef = st.ef === undefined ? b.c : st.ef + af * (b.c - st.ef);
        st.es = st.es === undefined ? b.c : st.es + as * (b.c - st.es);
        st.cur = undefined;
      };
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const idx = Math.floor((ctx.minuteOf(b.t) - OPEN) / N);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        if (s.cur && idx !== s.curIdx) finalize();
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curIdx = idx; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      if (!boundary) continue;
      // Bucket ending at ctx.minute is complete (all its 1-minute bars have t < ctx.minute).
      const completedIdx = (ctx.minute - OPEN) / N - 1;
      if (s.cur && s.curIdx <= completedIdx) finalize();
      else continue; // no new bucket completed (no bars in it) -> nothing to evaluate
      const h = s.hist;
      if (h.length < Math.max(p.warm, 2) || s.efPrev === undefined || s.esPrev === undefined) continue;
      const since = ctx.minute - OPEN;
      if (since < p.startMin || since > p.endMin) { s.pbLong = s.pbShort = undefined; continue; }
      if (ctx.open.has(sym) || (!p.reentry && ctx.traded.has(sym))) { s.pbLong = s.pbShort = undefined; continue; }

      const ef = s.ef!, es = s.es!, efP = s.efPrev, esP = s.esPrev;
      const last = h[h.length - 1];
      const px = last.c;
      const vwap = s.vol > 0 ? s.pv / s.vol : px;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allow = (side: 'long' | 'short') => {
        const L = side === 'long';
        switch (p.direction) {
          case 'long': return L;
          case 'with-gap': return L === gapUp;
          case 'vwap': return L ? px > vwap : px < vwap;
          case 'gap+vwap': return L === gapUp && (L ? px > vwap : px < vwap);
          default: return true;
        }
      };
      const sepPct = ((ef - es) / px) * 100;
      const slopePct = ((es - esP) / px) * 100;
      const buf = (px * p.stopBufPct) / 100;
      const emit = (side: 'long' | 'short', stop0: number, tag: string) => {
        const minDist = (px * p.minRiskPct) / 100;
        const stop = side === 'long' ? Math.min(stop0, px - minDist) : Math.max(stop0, px + minDist);
        const dist = side === 'long' ? px - stop : stop - px;
        if (dist <= 0) return;
        if (p.maxRiskPct > 0 && (dist / px) * 100 > p.maxRiskPct) return;
        out.push({
          sig: {
            symbol: sym, side, stop, tag,
            targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
            exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined,
          },
          score: Math.abs(sepPct),
        });
      };

      if (p.variant === 'pullback') {
        const upTrend = ef > es && ef > efP && es > esP && sepPct >= p.minSepPct && slopePct >= p.minSlopePct;
        const dnTrend = ef < es && ef < efP && es < esP && -sepPct >= p.minSepPct && -slopePct >= p.minSlopePct;
        // 1) resume of a pending pullback (pullback was the previous bucket)
        let fired = false;
        if (s.pbLong && upTrend && allow('long') && last.c > s.pbLong.hi) {
          emit('long', Math.min(s.pbLong.lo, es) - buf, 'pb-long');
          fired = true;
        } else if (s.pbShort && dnTrend && allow('short') && last.c < s.pbShort.lo) {
          emit('short', Math.max(s.pbShort.hi, es) + buf, 'pb-short');
          fired = true;
        }
        // 2) is this bucket a pullback? (touches fast EMA, holds the slow EMA)
        s.pbLong = s.pbShort = undefined;
        if (!fired) {
          if (upTrend && last.l <= ef * (1 + p.pbTolPct / 100) && last.c >= es) s.pbLong = { hi: last.h, lo: last.l, age: 0 };
          else if (dnTrend && last.h >= ef * (1 - p.pbTolPct / 100) && last.c <= es) s.pbShort = { hi: last.h, lo: last.l, age: 0 };
        }
      } else {
        const crossUp = efP <= esP && ef > es;
        const crossDn = efP >= esP && ef < es;
        const k = Math.max(1, p.stopBars);
        const recent = h.slice(-k);
        if (crossUp && allow('long') && sepPct >= p.minSepPct && slopePct >= p.minSlopePct) {
          emit('long', Math.min(...recent.map((b) => b.l)) - buf, 'x-long');
        } else if (crossDn && allow('short') && -sepPct >= p.minSepPct && -slopePct >= p.minSlopePct) {
          emit('short', Math.max(...recent.map((b) => b.h)) + buf, 'x-short');
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((o) => o.sig);
  },
};

export default {
  strategy,
  grid: {
    variant: ['cross', 'pullback'],
    barMinutes: [2, 5],
    emas: ['5/13', '9/21'],
    warm: [6],
    minRiskPct: [0],
    tags: ['gap'],
    minGap: [2],
    minPrice: [5],
    maxPrice: [500],
    maxSymbols: [15],
    direction: ['both'],
    minSepPct: [0],
    minSlopePct: [0],
    pbTolPct: [0.05],
    stopBars: [6],
    stopBufPct: [0.02],
    maxRiskPct: [2],
    startMin: [30, 90],
    endMin: [330],
    targetR: [0, 3],
    breakevenAtR: [0],
    trailR: [0],
    holdMinutes: [0],
    reentry: [false],
  },
} as { strategy: Strategy<P>; grid: Record<string, unknown[]> };
