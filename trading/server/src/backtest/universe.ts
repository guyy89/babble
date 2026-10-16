import type { CandidateInput } from '../strategy/orb.js';
import type { Bar } from '../types.js';

/** Daily bars are stamped at New York midnight (04:00Z/05:00Z), so the UTC date is the trading date. */
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Candidate inputs for one trading date from daily bars: that day's open, the previous close and the
 * 20-day average volume before it. Used by the backtest and by replay mode, as the live robot uses
 * the same three numbers from yesterday's bars and today's snapshot.
 */
export function candidateRows(daily: Record<string, Bar[]>, names: Map<string, string>, date: string): CandidateInput[] {
  const rows: CandidateInput[] = [];
  for (const [symbol, bars] of Object.entries(daily)) {
    const i = bars.findIndex((b) => dayKey(b.t) === date);
    if (i < 1) continue;
    const prev = bars.slice(Math.max(0, i - 20), i);
    rows.push({
      symbol, name: names.get(symbol) ?? symbol, open: bars[i].o, prevClose: bars[i - 1].c,
      avgVolume: prev.reduce((a, b) => a + b.v, 0) / prev.length,
    });
  }
  return rows;
}

/** UTC epoch ms of a New York wall-clock minute on a date (handles daylight saving). */
export function nyToUtc(date: string, minuteOfDay: number): number {
  const guess = Date.parse(`${date}T00:00:00Z`) + minuteOfDay * 60_000;
  // New York is UTC-4 or UTC-5; pick the offset whose New York wall time matches.
  for (const offsetH of [4, 5]) {
    const t = guess + offsetH * 3600_000;
    const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(t)).split(':').map(Number);
    if (ny[0] * 60 + ny[1] === minuteOfDay) return t;
  }
  return guess + 4 * 3600_000;
}
