// r2_firstpb — first pullback after a strong opening drive.
//  A stock (gapper or liquid name) drives hard from the open: the leg from the session low (long) to the
//  high of day is ≥ `driveAtr` × daily ATR(14) and the high is set within the first `driveMax` minutes.
//  The FIRST orderly pullback from that high is then watched: it must retrace ≥ minRet and ≤ maxRet of the
//  leg and (optionally) hold above session VWAP / the day open. When a bar closes above the previous bar's
//  high (resumption) we enter long; stop below the pullback low. Mirror for shorts.
//  Only one attempt per symbol and side: a pullback that goes too deep / breaks the hold level, or a new
//  high made after a qualifying pullback without a trigger, kills the setup for the day.
//  Bars can be aggregated to `barMin` minutes (buckets aligned to 09:30). Distances use the daily ATR(14)
//  known at 09:30 (ctx.dailyBefore). State is folded incrementally from closed 1-minute bars only.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  uni: 'gap' | 'liquid' | 'all';
  minGap: number;          // gap names: |gap| % threshold
  dir: 'with-gap' | 'both' | 'long';
  barMin: number;          // bar size for pullback/trigger detection
  driveAtr: number;        // leg size (session extreme to HOD/LOD) in daily ATR
  driveMax: number;        // drive high/low must be set within this many minutes after 09:30
  retr: string;            // "minRet-maxRet" retrace band of the leg, e.g. "0.3-0.6"
  hold: 'vwap' | 'open' | 'none';
  maxEntry: number;        // no triggers later than this many minutes after 09:30
  // execution / exits
  entry: 'market' | 'limit';
  limOff: number;          // limit = trigger close − limOff × (close − stop)  (long)
  limitTtl: number;
  stopPad: number;         // stop = pullback low − stopPad × ATR
  targetR: number;         // 0 = none
  breakevenAtR: number;    // 0 = off
  trailR: number;          // 0 = off
  holdMin: number;         // 0 = off; time exit this many minutes after the signal
  noStop: boolean;         // size from the stop but exit only by target/time (needs holdMin)
  // Compact overrides (when present): ent = 'mkt' | 'lim<off>x<ttl>' (e.g. lim0.3x5);
  // ex = '_'-joined tokens: t<R> target, be<R> breakeven, tr<R> trail, h<min> time exit, ns no stop, 'none'.
  ent?: string;
  ex?: string;
}

function resolveExec(p: P) {
  let { entry, limOff, limitTtl, targetR, breakevenAtR, trailR, holdMin, noStop } = p;
  if (p.ent) {
    const m = /^lim([\d.]+)x(\d+)$/.exec(p.ent);
    if (m) { entry = 'limit'; limOff = Number(m[1]); limitTtl = Number(m[2]); } else entry = 'market';
  }
  if (p.ex) {
    targetR = 0; breakevenAtR = 0; trailR = 0; holdMin = 0; noStop = false;
    for (const tok of p.ex.split('_')) {
      if (tok.startsWith('tr')) trailR = Number(tok.slice(2));
      else if (tok.startsWith('t')) targetR = Number(tok.slice(1));
      else if (tok.startsWith('be')) breakevenAtR = Number(tok.slice(2));
      else if (tok.startsWith('h')) holdMin = Number(tok.slice(1));
      else if (tok === 'ns') noStop = true;
    }
  }
  return { entry, limOff, limitTtl, targetR, breakevenAtR, trailR, holdMin, noStop };
}

interface Side {
  dead: boolean;
  ext: number;      // HOD (long) / LOD (short) of the drive
  extMin: number;   // minute the extreme was set
  run: number;      // running opposite extreme since open (session low for long)
  legBase: number;  // opposite extreme up to the drive extreme
  pb: number;       // pullback extreme since the drive extreme (low for long)
  qual: boolean;    // pullback reached minRet
}

interface Bk { o: number; h: number; l: number; c: number; idx: number; end: number }

interface S {
  seen: number;
  pv: number; vol: number;
  atr: number;
  open: number;
  cur?: Bk;
  prev?: Bk;
  L: Side; Sh: Side;
}

const OPEN = 9 * 60 + 30;

function dailyAtr(bars: Bar[], n = 14): number {
  const b = bars.slice(-(n + 1));
  if (b.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

// ATR depends only on daily bars before the date: cache it across configurations (pure, no look-ahead).
const atrCache = new Map<string, number>();
function atrFor(ctx: MinuteContext, sym: string): number {
  const k = `${ctx.date}|${sym}`;
  let v = atrCache.get(k);
  if (v === undefined) { v = dailyAtr(ctx.dailyBefore(sym)); atrCache.set(k, v); }
  return v;
}

const newSide = (long: boolean): Side => ({ dead: false, ext: long ? -Infinity : Infinity, extMin: 0, run: long ? Infinity : -Infinity, legBase: NaN, pb: long ? Infinity : -Infinity, qual: false });

const strategy: Strategy<P> = {
  name: 'r2_firstpb',
  universe(ctx: DayContext, p: P) {
    return Object.values(ctx.meta)
      .filter((m) => {
        const gap = m.tags.includes('gap') && Math.abs(m.gapPct) >= p.minGap;
        const liq = m.tags.includes('liquid');
        if (p.uni === 'gap') return gap;
        if (p.uni === 'liquid') return liq;
        return gap || liq;
      })
      .map((m) => m.symbol);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    if (ctx.minute - OPEN > p.maxEntry + 1) return []; // nothing can trigger any more
    const [minRet, maxRet] = p.retr.split('-').map(Number);
    const x = resolveExec(p);
    const cands: { sig: Signal; score: number }[] = [];
    for (const sym of Object.keys(ctx.meta)) {
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      let s = ctx.state.get(sym) as S | undefined;
      if (!s) {
        const atr = atrFor(ctx, sym);
        ctx.state.set(sym, (s = { seen: 0, pv: 0, vol: 0, atr, open: bars[0].o, L: newSide(true), Sh: newSide(false) }));
      }
      const meta = ctx.meta[sym];
      const allowLong = p.dir !== 'with-gap' || !meta.tags.includes('gap') || meta.gapPct > 0;
      const allowShort = p.dir === 'both' || (p.dir === 'with-gap' && (!meta.tags.includes('gap') || meta.gapPct < 0));
      const done: Bk[] = [];
      for (; s.seen < bars.length; s.seen++) {
        const b = bars[s.seen];
        const bm = ctx.minuteOf(b.t);
        s.pv += ((b.h + b.l + b.c) / 3) * b.v;
        s.vol += b.v;
        const idx = Math.floor((bm - OPEN) / p.barMin);
        if (s.cur && s.cur.idx !== idx) { done.push(s.cur); s.cur = undefined; }
        if (!s.cur) s.cur = { o: b.o, h: b.h, l: b.l, c: b.c, idx, end: OPEN + (idx + 1) * p.barMin };
        else { s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c; }
        if (bm + 1 >= s.cur.end) { done.push(s.cur); s.cur = undefined; }
      }
      if (!(s.atr > 0)) continue;
      const vwap = s.vol > 0 ? s.pv / s.vol : s.open;
      for (const bk of done) {
        const prev = s.prev;
        s.prev = bk;
        const fresh = bk.end >= ctx.minute - 1; // only act on a bucket that has just completed
        for (const long of [true, false]) {
          const sd = long ? s.L : s.Sh;
          if (sd.dead) continue;
          const dirn = long ? 1 : -1;
          const hi = long ? bk.h : -bk.l; // work in "long space": negate prices for shorts
          const lo = long ? bk.l : -bk.h;
          const ext = long ? sd.ext : -sd.ext;
          // running opposite extreme (session low for long), before this bucket's extension
          const run = Math.min(long ? sd.run : -sd.run, lo);
          sd.run = long ? run : -run;
          if (!sd.qual && hi > ext) {
            // drive extends: new extreme, pullback resets
            sd.ext = long ? hi : -hi;
            sd.extMin = bk.end;
            sd.legBase = long ? run : -run;
            sd.pb = long ? Infinity : -Infinity;
            if (bk.end - OPEN > p.driveMax) sd.dead = true; // not an opening drive any more
            continue;
          }
          const legBase = long ? sd.legBase : -sd.legBase;
          const leg = ext - legBase;
          if (!(leg > 0) || leg < p.driveAtr * s.atr) continue; // drive not strong (yet)
          const pb = Math.min(long ? sd.pb : -sd.pb, lo);
          sd.pb = long ? pb : -pb;
          const ret = (ext - pb) / leg;
          const holdLvl = p.hold === 'vwap' ? (long ? vwap : -vwap) : p.hold === 'open' ? (long ? s.open : -s.open) : -Infinity;
          if (ret > maxRet || pb < holdLvl) { sd.dead = true; continue; }
          if (ret >= minRet) sd.qual = true;
          if (!sd.qual) continue;
          const close = long ? bk.c : -bk.c;
          const prevHi = prev ? (long ? prev.h : -prev.l) : Infinity;
          if (close > prevHi) {
            sd.dead = true; // one attempt only
            if (!fresh || !(long ? allowLong : allowShort) || ctx.traded.has(sym) || ctx.open.has(sym)) continue;
            if (ctx.minute - OPEN > p.maxEntry) continue;
            const stop = (pb - p.stopPad * s.atr) * dirn; // back to real prices
            const realClose = bk.c;
            const sig: Signal = {
              symbol: sym, side: long ? 'long' : 'short', stop,
              targetR: x.targetR || undefined,
              breakevenAtR: x.breakevenAtR || undefined,
              trailR: x.trailR || undefined,
              exitMinute: x.holdMin ? ctx.minute + x.holdMin : undefined,
              noStop: x.noStop || undefined,
              tag: long ? 'long' : 'short',
            };
            if (x.entry === 'limit') {
              sig.entryLimit = Math.round((realClose - dirn * x.limOff * Math.abs(realClose - stop)) * 100) / 100;
              sig.limitTtl = x.limitTtl;
            }
            cands.push({ sig, score: leg / s.atr });
          } else if (hi > ext) {
            sd.dead = true; // new extreme after a qualifying pullback without a trigger: missed
          }
        }
      }
    }
    return cands.sort((a, b) => b.score - a.score).map((c) => c.sig);
  },
};

// Run 1 (768 configs): core shape — uni, dir, barMin, driveAtr, driveMax, retr, hold, stopPad, targetR.
// Run 2 (512): zoom on the run-1 region (1-min bars, both directions, 15-min drive, VWAP hold) × entry type × exits.
// Run 3 (576): run-2 region (shallow 15–40% / 20–50% pullbacks, small stop pad, limit entries) × risk tiers × maxTrades.
// Run 4: run-3 region (NOTE: shaped by runs 1–3 incl. their walk-forward) × day limits on/off × stop pad × exits, risk 500.
const base = {
  uni: ['all'], minGap: [3], dir: ['both'], barMin: [1],
  driveAtr: [0.8, 1.0], driveMax: [15], retr: ['0.15-0.4'], hold: ['vwap'], maxEntry: [90],
  entry: ['market'], limOff: [0], limitTtl: [5], stopPad: [0.05, 0.1],
  targetR: [0], breakevenAtR: [0], trailR: [0], holdMin: [0], noStop: [false],
  ent: ['lim0.3x5', 'lim0.5x5', 'lim0.5x10'],
  ex: ['none', 'ns_h30', 'ns_h60', 'tr2'],
  'rule.riskPerTrade': [500],
  'rule.maxTrades': [0],
  'rule.dailyLossLimit': [1500, 0],
  'rule.maxLosses': [2, 0],
  'rule.maxConcurrent': [2, 0],
};

export default { strategy, grid: base };
