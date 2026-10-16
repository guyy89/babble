import type { Bar } from '../types.js';

/** What is known about a symbol at the 09:30 open (from daily bars before today + today's open). */
export interface DayMeta {
  symbol: string;
  name: string;
  open: number;
  prevClose: number;
  /** 20-day average daily volume (IEX feed units, ~2–3% of the consolidated tape). */
  avgVolume: number;
  gapPct: number;
  /** Why it is in the day's dataset: 'gap' (top 25 |gap|), 'liquid' (top 15 by avg $ volume), 'index' (SPY/QQQ). */
  tags: string[];
}

export interface DayContext {
  date: string;
  meta: Record<string, DayMeta>;
  /** Daily bars strictly before `date` (no look-ahead), oldest first. */
  dailyBefore(symbol: string): Bar[];
}

export interface MinuteContext extends DayContext {
  /** New York minute-of-day of the bar about to open; decisions here fill at this bar's open. */
  minute: number;
  /** Today's regular-session 1-minute bars that have fully closed (t < this minute). */
  bars(symbol: string): Bar[];
  /** Symbols with an open position right now. */
  open: Set<string>;
  /** Symbols already traded today (entered at least once). */
  traded: Set<string>;
  /** New York minute-of-day of a bar timestamp (09:30 = 570). */
  minuteOf(t: number): number;
  /** Free per-day scratch space for the strategy (reset every day). */
  state: Map<string, unknown>;
}

export type Side = 'long' | 'short';

/** An entry decision. The harness fills it at the next bar's open plus slippage, then sizes it. */
export interface Signal {
  symbol: string;
  side: Side;
  /** Protective stop price (must be on the losing side of the entry). */
  stop: number;
  /** Profit target as a multiple of the initial risk (omit for no fixed target). */
  targetR?: number;
  /** Move the stop to entry once price has gone this many R in favour. */
  breakevenAtR?: number;
  /** Trail the stop this many R behind the best price reached (applied from the next bar). */
  trailR?: number;
  /** Close at this New York minute-of-day if still open (default: flatten time). */
  exitMinute?: number;
  /** Optional label for analysis. */
  tag?: string;
}

export interface Strategy<P extends object = Record<string, number | string | boolean>> {
  name: string;
  /** Symbols to watch today. Use ONLY ctx.meta and ctx.dailyBefore (things known at 09:30). */
  universe(ctx: DayContext, p: P): string[];
  /** Called once per minute from 09:31 to 15:59 New York time. Return entries to take at this minute's open. */
  onMinute(ctx: MinuteContext, p: P): Signal[];
}

export interface Rules {
  riskPerTrade: number;
  maxPositionNotional: number;
  buyingPower: number;
  dailyLossLimit: number;
  maxTrades: number;
  maxLosses: number;
  maxConcurrent: number;
  /** Last New York minute-of-day for new entries, and the forced flatten minute. */
  lastEntryMinute: number;
  flattenMinute: number;
}

export interface Costs {
  slippagePct: number;
  minSlippage: number;
  /** Multiplier on commissions and regulatory fees (stress tests use 2). */
  feeMultiplier: number;
}

export interface ResearchTrade {
  date: string;
  symbol: string;
  side: Side;
  tag?: string;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  qty: number;
  risk: number;
  gross: number;
  costs: number;
  net: number;
  r: number;
  exitReason: 'stop' | 'target' | 'breakeven' | 'trail' | 'time' | 'flatten';
}
