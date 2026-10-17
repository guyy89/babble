import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { nyToUtc } from '../backtest/universe.js';
import type { Bar } from '../types.js';
import type { DayMeta } from './types.js';

type Row = [number, number, number, number, number, number];
// RESEARCH_DIR selects the dataset (e.g. research-sip for consolidated data).
const DIR = resolve(config.dataDir, process.env.RESEARCH_DIR || 'research');
const toBars = (symbol: string, rows: Row[]): Bar[] => rows.map(([t, o, h, l, c, v]) => ({ symbol, t, o, h, l, c, v }));
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface LoadedDay {
  date: string;
  meta: Record<string, DayMeta>;
  /** Regular-session (09:30–16:00 NY) 1-minute bars per symbol, with the NY minute-of-day of each bar. */
  bars: Map<string, { bar: Bar; minute: number }[]>;
  /** Same bars keyed by minute-of-day, built once per day and shared by every configuration (read-only). */
  byMinute: Map<string, Map<number, Bar>>;
  /** UTC epoch ms of 09:30 New York on this date. */
  openUtc: number;
}

let dailyCache: Map<string, Bar[]> | undefined;

/** Daily bars for the research universe (oldest first). */
export function daily(): Map<string, Bar[]> {
  if (!dailyCache) {
    const raw = JSON.parse(readFileSync(resolve(DIR, 'daily.json'), 'utf8')) as Record<string, Row[]>;
    dailyCache = new Map(Object.entries(raw).map(([s, rows]) => [s, toBars(s, rows)]));
  }
  return dailyCache;
}

/** Daily bars strictly before `date`. */
export function dailyBefore(symbol: string, date: string): Bar[] {
  const all = daily().get(symbol) ?? [];
  let hi = all.length;
  while (hi > 0 && dayKey(all[hi - 1].t) >= date) hi--;
  return all.slice(0, hi);
}

export function listDates(from: string, to: string): string[] {
  const dir = resolve(DIR, 'days');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.replace('.json', '')).filter((d) => d >= from && d <= to).sort();
}

// Only the most recent day is kept in memory, so many research processes can run side by side.
let lastDay: LoadedDay | undefined;
let qualityCache: Record<string, Record<string, string>> | undefined;

/** Symbol-days excluded by validate-data.ts, if it has been run on this dataset. */
function quality(): Record<string, Record<string, string>> {
  if (!qualityCache) {
    const f = resolve(DIR, 'quality.json');
    qualityCache = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  }
  return qualityCache!;
}

/** Tests rewrite a day file under the same date; production files never change. */
export function clearDayCache(): void {
  lastDay = undefined;
}

export function loadDay(date: string): LoadedDay {
  if (lastDay?.date === date) return lastDay;
  const raw = JSON.parse(readFileSync(resolve(DIR, 'days', `${date}.json`), 'utf8')) as { meta: Record<string, DayMeta>; bars: Record<string, Row[]> };
  // One offset lookup per day: minute-of-day = 09:30 + whole minutes since the open.
  const openUtc = nyToUtc(date, 9 * 60 + 30);
  const bars = new Map<string, { bar: Bar; minute: number }[]>();
  const excluded = quality()[date] ?? {};
  for (const [s, rows] of Object.entries(raw.bars)) {
    if (excluded[s]) continue; // failed the integrity check (validate-data.ts)
    const list = toBars(s, rows)
      .map((bar) => ({ bar, minute: 9 * 60 + 30 + Math.floor((bar.t - openUtc) / 60_000) }))
      .filter((x) => x.minute >= 9 * 60 + 30 && x.minute < 16 * 60);
    bars.set(s, list);
  }
  const byMinute = new Map([...bars].map(([s, list]) => [s, new Map(list.map((x) => [x.minute, x.bar]))]));
  lastDay = { date, meta: raw.meta, bars, byMinute, openUtc };
  return lastDay;
}
