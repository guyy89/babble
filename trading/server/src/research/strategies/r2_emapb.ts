// r2_emapb: EMA pullback on N-minute buckets (aligned to 09:30) built from closed 1-minute bars.
//   Trend: EMA(fast) > EMA(slow), both rising over the last bucket (mirror for shorts), optional min separation.
//   entry 'limit':  at each completed bucket in a trend whose close is still on the trend side of the fast EMA,
//                   rest a LIMIT at the fast EMA (or the fast/slow midpoint) for `ttlBuckets` buckets.
//   entry 'market': a bucket pulls back to the fast EMA (touch within tol, close holds the slow EMA); the next
//                   bucket resumes (closes beyond the pullback bucket's high/low) -> market at the next open.
//   Stop: 'slow' = beyond min(slow EMA, pullback extreme) - buffer; 'atr' = stopAtr x ATR(bucket) beyond entry ref.
// No look-ahead: universe() uses only meta; onMinute() folds in closed bars only, and a bucket [a, a+N) is
// evaluated only once ctx.minute >= a+N.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  entry: 'limit' | 'limitmid' | 'market'; // limitmid = limit at the fast/slow midpoint (overrides limitAt)
  barMinutes: number;
  emas: string;            // 'fast/slow' in buckets
  warm: number;            // completed buckets before signals
  tags: 'gap' | 'liquid+index' | 'all';
  minGap: number;          // |gap| % for gap-tagged names
  maxSymbols: number;
  direction: 'both' | 'with-gap' | 'vwap';
  minSepPct: number;       // |fast-slow| / price %, 0 = off
  limitAt: 'fast' | 'mid'; // limit level (limit entry)
  ttlBuckets: number;      // limit lifetime in buckets
  pbTolPct: number;        // market: pullback touch tolerance
  stopMode: 'slow' | 'atr';
  stopAtr: number;         // ATR multiple for stopMode 'atr'
  stopBufPct: number;      // extra stop buffer, % of price
  minRiskPct: number;      // widen stop to at least this % of price
  maxRiskPct: number;      // skip if stop distance > this % (0 = off)
  startMin: number;        // earliest signal, minutes after 09:30
  endMin: number;          // latest signal
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMinutes: number;     // 0 = off
  noStop: boolean;         // size from stop but don't place it (needs holdMinutes or close exit)
  maxPerSym: number;       // filled entries per symbol per day
}

interface Bk { o: number; h: number; l: number; c: number }
interface S {
  seen: number; pv: number; vol: number;
  cur?: Bk; curIdx: number; nDone: number; lastC?: number;
  ef?: number; es?: number; efP?: number; esP?: number; atr?: number;
  pbL?: Bk; pbS?: Bk;
  fills: number;
  lim?: { px: number; long: boolean; from: number; to: number }; // outstanding limit (minute window)
}

const OPEN = 9 * 60 + 30;

function universe(ctx: DayContext, p: P): string[] {
  const ok = (t: string[]) => (p.tags === 'all' ? true : p.tags === 'gap' ? t.includes('gap') : t.includes('liquid') || t.includes('index'));
  const list = Object.values(ctx.meta)
    .filter((m) => ok(m.tags) && m.open >= 5)
    .filter((m) => !m.tags.includes('gap') || Math.abs(m.gapPct) >= p.minGap || p.tags !== 'gap');
  list.sort((a, b) => (p.tags === 'gap' ? Math.abs(b.gapPct) - Math.abs(a.gapPct) : b.avgVolume * b.open - a.avgVolume * a.open));
  return list.slice(0, p.maxSymbols).map((m) => m.symbol);
}

const strategy: Strategy<P> = {
  name: 'r2_emapb',
  universe,
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    const out: { sig: Signal; score: number }[] = [];
    const N = p.barMinutes;
    const [fast, slow] = p.emas.split('/').map(Number);
    const af = 2 / (fast + 1), as = 2 / (slow + 1), aa = 1 / 14;
    const boundary = (ctx.minute - OPEN) % N === 0;
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) ctx.state.set(sym, (s = { seen: 0, pv: 0, vol: 0, curIdx: -1, nDone: 0, fills: 0 }));
      const st = s;
      const finalize = () => {
        const b = st.cur!;
        const tr = st.lastC === undefined ? b.h - b.l : Math.max(b.h, st.lastC) - Math.min(b.l, st.lastC);
        st.atr = st.atr === undefined ? tr : st.atr + aa * (tr - st.atr);
        st.efP = st.ef; st.esP = st.es;
        st.ef = st.ef === undefined ? b.c : st.ef + af * (b.c - st.ef);
        st.es = st.es === undefined ? b.c : st.es + as * (b.c - st.es);
        st.lastC = b.c; st.nDone++; st.cur = undefined;
      };
      for (; s.seen < bars.length; s.seen++) {
        const b: Bar = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        // Did an outstanding limit get filled (trade-through by a cent) by this closed bar?
        if (s.lim && bm >= s.lim.from && bm < s.lim.to) {
          if (s.lim.long ? b.l <= s.lim.px - 0.01 + 1e-9 : b.h >= s.lim.px + 0.01 - 1e-9) { s.fills++; s.lim = undefined; }
        }
        const idx = Math.floor((bm - OPEN) / N);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v; s.vol += b.v;
        if (s.cur && idx !== s.curIdx) finalize();
        if (!s.cur) { s.cur = { o: b.o, h: b.h, l: b.l, c: b.c }; s.curIdx = idx; }
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
      }
      if (s.lim && ctx.minute >= s.lim.to) s.lim = undefined;
      if (!boundary) continue;
      const completedIdx = (ctx.minute - OPEN) / N - 1;
      if (!(s.cur && s.curIdx <= completedIdx)) continue;
      const last = s.cur; // the bucket that just completed
      finalize();
      if (s.nDone < Math.max(p.warm, 2) || s.efP === undefined || s.esP === undefined) continue;
      const since = ctx.minute - OPEN;
      if (since < p.startMin || since > p.endMin) { s.pbL = s.pbS = undefined; continue; }
      if (ctx.open.has(sym) || s.fills >= p.maxPerSym) { s.pbL = s.pbS = undefined; continue; }

      const ef = s.ef!, es = s.es!, px = last.c, atr = s.atr!;
      const sepPct = ((ef - es) / px) * 100;
      const up = ef > es && ef > s.efP && es > s.esP && sepPct >= p.minSepPct;
      const dn = ef < es && ef < s.efP && es < s.esP && -sepPct >= p.minSepPct;
      const vwap = s.vol > 0 ? s.pv / s.vol : px;
      const gapUp = ctx.meta[sym].gapPct > 0;
      const allow = (L: boolean) => (p.direction === 'with-gap' ? L === gapUp : p.direction === 'vwap' ? (L ? px > vwap : px < vwap) : true);
      const buf = (px * p.stopBufPct) / 100;

      const emit = (L: boolean, ref: number, structStop: number, tag: string, limit?: number) => {
        let stop = p.stopMode === 'atr' ? (L ? ref - p.stopAtr * atr : ref + p.stopAtr * atr) : structStop;
        stop = L ? stop - buf : stop + buf;
        const minD = (ref * p.minRiskPct) / 100;
        stop = L ? Math.min(stop, ref - minD) : Math.max(stop, ref + minD);
        const dist = L ? ref - stop : stop - ref;
        if (!(dist > 0)) return;
        if (p.maxRiskPct > 0 && (dist / ref) * 100 > p.maxRiskPct) return;
        const sig: Signal = {
          symbol: sym, side: L ? 'long' : 'short', stop: Math.round(stop * 100) / 100, tag,
          targetR: p.targetR || undefined, breakevenAtR: p.breakevenAtR || undefined, trailR: p.trailR || undefined,
          exitMinute: p.holdMinutes ? ctx.minute + p.holdMinutes : undefined, noStop: p.noStop || undefined,
        };
        if (limit !== undefined) {
          sig.entryLimit = limit; sig.limitTtl = N > 1 ? p.ttlBuckets * N - 1 : p.ttlBuckets; // expires before the next re-placement boundary
          s!.lim = { px: limit, long: L, from: ctx.minute, to: ctx.minute + sig.limitTtl };
        }
        out.push({ sig, score: Math.abs(sepPct) });
      };

      if (p.entry === 'limit' || p.entry === 'limitmid') {
        // Rest a limit at the fast EMA (or fast/slow midpoint) while price is still extended on the trend side.
        const lvlRaw = p.limitAt === 'mid' || p.entry === 'limitmid' ? (ef + es) / 2 : ef;
        const lvl = Math.round(lvlRaw * 100) / 100;
        if (up && allow(true) && last.l > ef) emit(true, lvl, Math.min(es, lvl), 'lim-long', lvl);
        else if (dn && allow(false) && last.h < ef) emit(false, lvl, Math.max(es, lvl), 'lim-short', lvl);
        continue;
      }
      // Market on the resumption bucket after a pullback bucket.
      let fired = false;
      if (s.pbL && up && allow(true) && last.c > s.pbL.h) { emit(true, px, Math.min(s.pbL.l, es), 'mkt-long'); fired = true; }
      else if (s.pbS && dn && allow(false) && last.c < s.pbS.l) { emit(false, px, Math.max(s.pbS.h, es), 'mkt-short'); fired = true; }
      s.pbL = s.pbS = undefined;
      if (!fired) {
        if (up && last.l <= ef * (1 + p.pbTolPct / 100) && last.c >= es) s.pbL = { ...last };
        else if (dn && last.h >= ef * (1 - p.pbTolPct / 100) && last.c <= es) s.pbS = { ...last };
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((o) => o.sig);
  },
};

export default {
  strategy,
  grid: {
    entry: ['limit', 'limitmid'],
    barMinutes: [1],
    emas: ['8/21', '13/34'],
    warm: [10],
    tags: ['liquid+index'],
    minGap: [3],
    maxSymbols: [15],
    direction: ['both'],
    minSepPct: [0.1],
    limitAt: ['fast'],
    ttlBuckets: [1],
    pbTolPct: [0.05],
    stopMode: ['slow'],
    stopAtr: [1.5],
    stopBufPct: [0.05],
    minRiskPct: [0.2],
    maxRiskPct: [3],
    startMin: [15],
    endMin: [330],
    targetR: [0, 4],
    breakevenAtR: [0],
    trailR: [0],
    holdMinutes: [0],
    noStop: [false],
    maxPerSym: [2],
    'rule.riskPerTrade': [100, 500],
    'rule.maxLosses': [0],
    'rule.maxTrades': [0],
    'rule.maxConcurrent': [2, 0],
  },
} as { strategy: Strategy<P>; grid: Record<string, unknown[]> };
