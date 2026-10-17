// r2_random: CONTROL strategy — random entries, the baseline every real strategy is compared with.
// Each day a deterministic PRNG (keyed on date + seed + universe + entries/day + entry window; NOT on direction or
// exit params, so long/short/random and every exit variant of one seed share the same random times and symbols)
// draws `perDay` entries: a random minute in [winFrom, winTo], a random symbol from the chosen universe tag and a
// random side (used only when dir = 'random').
// Exit variants (param `exit`):
//   p<X>[t<R>]  — stop X% from the reference price, optional fixed target R (e.g. p1, p1t2, p0.5t1);
//   a<F>[t<R>]  — stop F × daily ATR(14) (from daily bars strictly before today), optional target;
//   none        — no stop, sized as if the stop were 1% away, held to the flatten time (15:55).
// Entry: market (next bar's open) or 'lim<ttl>': LIMIT `limOff`% better than the last closed bar's close, ttl minutes.
// Decisions use only the last closed bar (reference price) and dailyBefore; nothing from the future.
import type { Bar } from '../../types.js';
import type { DayContext, MinuteContext, Signal, Strategy } from '../types.js';

interface P {
  universe: 'gap' | 'liquid' | 'index' | 'liqidx';
  seed: number;
  dir: 'random' | 'long' | 'short';
  perDay: number;          // random entry attempts per day
  winFrom: number;         // NY minute-of-day window for random entry times
  winTo: number;
  exit: string;            // see header
  entry: string;           // 'market' or 'lim<ttl>' (LIMIT limOff% better than the reference, ttl minutes)
  limOff: number;          // % better than the reference close for limit entries
}

interface Planned { minute: number; idx: number; long: boolean }

// FNV-1a string hash → 32-bit seed; mulberry32 PRNG. Deterministic across runs and platforms.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function inUniverse(tags: string[], u: P['universe']): boolean {
  if (u === 'liqidx') return tags.includes('liquid') || tags.includes('index');
  return tags.includes(u);
}

/** Sorted (stable, order-independent) list of the universe's symbols from 09:30 meta only. */
function symbols(ctx: DayContext, p: P): string[] {
  return Object.values(ctx.meta).filter((m) => inUniverse(m.tags, p.universe)).map((m) => m.symbol).sort();
}

function parseExit(e: string): { kind: 'p' | 'a' | 'none'; x: number; targetR?: number } {
  if (e === 'none') return { kind: 'none', x: 1 };
  const m = /^([pa])([\d.]+)(?:t([\d.]+))?$/.exec(e);
  if (!m) throw new Error(`bad exit ${e}`);
  return { kind: m[1] as 'p' | 'a', x: Number(m[2]), targetR: m[3] ? Number(m[3]) : undefined };
}

const strategy: Strategy<P> = {
  name: 'r2_random',
  universe(ctx: DayContext, p: P) {
    return symbols(ctx, p);
  },
  onMinute(ctx: MinuteContext, p: P): Signal[] {
    let plan = ctx.state.get('plan') as Planned[] | undefined;
    let syms = ctx.state.get('syms') as string[] | undefined;
    if (!plan || !syms) {
      syms = symbols(ctx, p);
      const rnd = mulberry32(hash(`${ctx.date}|${p.seed}|${p.universe}|${p.perDay}|${p.winFrom}|${p.winTo}`));
      plan = [];
      for (let i = 0; i < p.perDay; i++) {
        const minute = p.winFrom + Math.floor(rnd() * (p.winTo - p.winFrom + 1));
        const idx = Math.floor(rnd() * syms.length);
        const long = rnd() < 0.5;
        plan.push({ minute, idx, long });
      }
      plan.sort((a, b) => a.minute - b.minute);
      ctx.state.set('plan', plan);
      ctx.state.set('syms', syms);
    }
    const out: Signal[] = [];
    const ex = parseExit(p.exit);
    for (const e of plan) {
      if (e.minute !== ctx.minute || !syms.length) continue;
      const sym = syms[e.idx];
      const bars = ctx.bars(sym);
      if (!bars.length) continue;
      const ref = bars[bars.length - 1].c; // last CLOSED bar
      const long = p.dir === 'random' ? e.long : p.dir === 'long';
      const lim = p.entry.startsWith('lim');
      const base = lim ? ref * (1 + (long ? -1 : 1) * p.limOff / 100) : ref;
      let dist: number;
      if (ex.kind === 'a') {
        const atr = atr14(ctx.dailyBefore(sym));
        if (!atr) continue;
        dist = ex.x * atr;
      } else dist = (ex.x / 100) * base;
      const sig: Signal = {
        symbol: sym, side: long ? 'long' : 'short', stop: long ? base - dist : base + dist,
        targetR: ex.targetR, noStop: ex.kind === 'none' || undefined, tag: long ? 'long' : 'short',
      };
      if (lim) { sig.entryLimit = Math.round(base * 100) / 100; sig.limitTtl = Number(p.entry.slice(3)); }
      out.push(sig);
    }
    return out;
  },
};



export default {
  strategy,
  // Run 1 (300 cfgs): universe gap/liquid/index x seeds 0-9 x exits p0.5,p1,p1t1,p1t2,p2,p2t2,p4,a0.25,a0.5t2,none, market, perDay 3, default rules.
  // Run 2 (this grid): risk tiers x limits on/off x market/limit entries.
  grid: {
    universe: ['gap', 'liquid'],
    seed: [0, 1, 2, 3],
    dir: ['random'],
    perDay: [6],
    winFrom: [575],
    winTo: [930],
    exit: ['p1', 'p2t2', 'none'],
    entry: ['market', 'lim5', 'lim15'],
    limOff: [0.1],
    'rule.riskPerTrade': [50, 100, 200, 500],
    'rule.maxTrades': [3, 0],
    'rule.maxConcurrent': [2, 0],
  },
};
