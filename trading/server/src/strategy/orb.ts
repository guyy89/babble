import { nyParts } from '../market/clock.js';
import type { Bar } from '../types.js';

/**
 * Opening-range breakout (ORB). Pure rules shared by the live robot and the backtest, so both trade
 * exactly the same strategy:
 *  - Candidates: up to `candidates` stocks priced minPrice–maxPrice, liquid, not leveraged/inverse
 *    funds, ranked by today's opening gap from yesterday's close (|gap| ≥ minGapPct).
 *  - Opening range: high/low of the first `orMinutes` of the session.
 *  - Entry: a `barMinutes` bar closes beyond the range, on the same side of VWAP. One entry per symbol.
 *  - Stop: the other side of the range (its middle when the range is wider than wideRangePct).
 *  - Target: rr × risk. Stop moves to entry once price reaches breakevenAtR × risk.
 *  - Day rules: at most maxTrades entries, stop after maxLosses losers, no entries after lastEntry.
 */
export interface OrbParams {
  candidates: number;
  minPrice: number;
  maxPrice: number;
  minGapPct: number;
  /** Average daily volume (over 20 days) in the data feed's units. */
  minAvgVolume: number;
  orMinutes: number;
  barMinutes: number;
  wideRangePct: number;
  rr: number;
  breakevenAtR: number;
  riskPerTrade: number;
  maxPositionNotional: number;
  maxTrades: number;
  maxLosses: number;
  /** Minutes after midnight New York: last time a new entry may be taken. */
  lastEntryMinute: number;
  /** Minutes after midnight New York: all positions are closed. */
  flattenMinute: number;
}

export const DEFAULT_ORB: OrbParams = {
  candidates: 8,
  minPrice: 10,
  maxPrice: 80,
  minGapPct: 3,
  minAvgVolume: 100_000, // IEX volume: roughly 2–3% of the consolidated tape, so ~4M+ shares market-wide
  orMinutes: 15,
  barMinutes: 5,
  wideRangePct: 2,
  rr: 2,
  breakevenAtR: 1,
  riskPerTrade: 50,
  maxPositionNotional: 10_000,
  maxTrades: 3,
  maxLosses: 2,
  lastEntryMinute: 11 * 60 + 30, // 18:30 Israel time
  flattenMinute: 15 * 60 + 55,
};

export const OPEN_MINUTE = 9 * 60 + 30;

// Leveraged / inverse products move mechanically with another asset; excluded from candidates.
const LEVERAGED = /\b(\d(\.\d)?x|2x|3x|ultra|leveraged?|inverse|bull|bear|short|daily target)\b/i;
const NOT_COMMON = /\b(warrants?|rights?|units?|preferred|notes?)\b/i;

export interface CandidateInput {
  symbol: string;
  name: string;
  open: number;
  prevClose: number;
  avgVolume: number;
}

export interface Candidate extends CandidateInput {
  gapPct: number;
}

export function selectCandidates(rows: CandidateInput[], p: OrbParams): Candidate[] {
  return rows
    .filter((r) => r.prevClose > 0 && r.open >= p.minPrice && r.open <= p.maxPrice && r.avgVolume >= p.minAvgVolume)
    .filter((r) => !LEVERAGED.test(r.name) && !NOT_COMMON.test(r.name))
    .map((r) => ({ ...r, gapPct: ((r.open - r.prevClose) / r.prevClose) * 100 }))
    .filter((r) => Math.abs(r.gapPct) >= p.minGapPct)
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
    .slice(0, p.candidates);
}

export const nyMinute = (ms: number) => nyParts(ms).minuteOfDay;
export const nyDate = (ms: number) => nyParts(ms).date;

/** Today's regular-session 1-minute bars (09:30–16:00 NY) for the given NY date. */
export function sessionBars(bars: Bar[], date: string): Bar[] {
  return bars.filter((b) => {
    const p = nyParts(b.t);
    return p.date === date && p.minuteOfDay >= OPEN_MINUTE && p.minuteOfDay < 16 * 60;
  });
}

export interface Range {
  high: number;
  low: number;
}

/** High/low of the first `orMinutes`; undefined until that window has fully passed. */
export function openingRange(session: Bar[], p: OrbParams, nowMinute: number): Range | undefined {
  if (nowMinute < OPEN_MINUTE + p.orMinutes) return undefined;
  const window = session.filter((b) => nyMinute(b.t) < OPEN_MINUTE + p.orMinutes);
  if (!window.length) return undefined;
  return { high: Math.max(...window.map((b) => b.h)), low: Math.min(...window.map((b) => b.l)) };
}

/** Completed `barMinutes` bars after the opening range, each with session VWAP as of its last minute. */
export function completedBars(session: Bar[], p: OrbParams, nowMinute: number) {
  type Done = { start: number; endMinute: number; close: number; vwap: number };
  const out: Done[] = [];
  let pv = 0;
  let vol = 0;
  let cur: Done | undefined;
  for (const b of session) {
    const m = nyMinute(b.t);
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
    if (m < OPEN_MINUTE + p.orMinutes) continue;
    const start = OPEN_MINUTE + Math.floor((m - OPEN_MINUTE) / p.barMinutes) * p.barMinutes;
    if (cur && cur.start !== start) out.push(cur);
    if (!cur || cur.start !== start) cur = { start, endMinute: start + p.barMinutes, close: b.c, vwap: b.c };
    cur.close = b.c;
    cur.vwap = vol > 0 ? pv / vol : b.c;
  }
  // The newest bucket only counts once its time window has ended.
  if (cur && cur.endMinute <= nowMinute) out.push(cur);
  return out;
}

export type Side = 'long' | 'short';

export function breakout(bar: { close: number; vwap: number }, range: Range): Side | undefined {
  if (bar.close > range.high && bar.close > bar.vwap) return 'long';
  if (bar.close < range.low && bar.close < bar.vwap) return 'short';
  return undefined;
}

export interface TradePlan {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  breakeven: number;
  qty: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Stop, target and size for an entry at `entry`. Undefined when the trade can't be sized. */
export function planTrade(side: Side, entry: number, range: Range, p: OrbParams): TradePlan | undefined {
  const wide = ((range.high - range.low) / entry) * 100 > p.wideRangePct;
  const far = side === 'long' ? range.low : range.high;
  const stop = round2(wide ? (range.high + range.low) / 2 : far);
  const risk = side === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0.01)) return undefined;
  const qty = Math.min(Math.floor(p.riskPerTrade / risk), Math.floor(p.maxPositionNotional / entry));
  if (qty < 1) return undefined;
  const dir = side === 'long' ? 1 : -1;
  return {
    side, entry, stop, qty,
    target: round2(entry + dir * risk * p.rr),
    breakeven: round2(entry + dir * risk * p.breakevenAtR),
  };
}

/**
 * Israel wall-clock time ("HH:MM") of a New York minute-of-day on the date of `at`. Israel and the US
 * change clocks on different dates, so the gap is usually 7 hours but sometimes 6.
 */
export function israelTime(nyMinuteOfDay: number, at = Date.now()): string {
  const d = new Date(at);
  const wall = (tz: string) => new Date(d.toLocaleString('en-US', { timeZone: tz })).getTime();
  const diff = Math.round((wall('Asia/Jerusalem') - wall('America/New_York')) / 60_000);
  const m = (((nyMinuteOfDay + diff) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
