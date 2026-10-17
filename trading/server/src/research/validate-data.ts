// Integrity check for a research dataset. Flags symbol-days that are internally inconsistent or disagree
// with the daily bars, writes <dir>/quality.json (data.ts then excludes those symbol-days) and prints a report.
//   RESEARCH_DIR=research-sip npx tsx src/research/validate-data.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nyToUtc } from '../backtest/universe.js';
import { config } from '../config.js';

type Row = [number, number, number, number, number, number];
const DIR = resolve(config.dataDir, process.env.RESEARCH_DIR || 'research');
const daily = JSON.parse(readFileSync(resolve(DIR, 'daily.json'), 'utf8')) as Record<string, Row[]>;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

const bad: Record<string, Record<string, string>> = {};
const counts: Record<string, number> = {};
let symbolDays = 0;
const coverage: number[] = [];
const flag = (date: string, s: string, why: string) => {
  (bad[date] ??= {})[s] ??= why;
  counts[why] = (counts[why] ?? 0) + 1;
};

for (const f of readdirSync(resolve(DIR, 'days')).sort()) {
  const date = f.replace('.json', '');
  const raw = JSON.parse(readFileSync(resolve(DIR, 'days', f), 'utf8')) as {
    meta: Record<string, { open: number; prevClose: number; gapPct: number }>;
    bars: Record<string, Row[]>;
  };
  const open = nyToUtc(date, 570);
  const close = nyToUtc(date, 960);
  for (const [s, rows] of Object.entries(raw.bars)) {
    symbolDays++;
    const session = rows.filter((r) => r[0] >= open && r[0] < close);
    coverage.push(session.length / 390);
    if (!session.length) { flag(date, s, 'no regular-session bars'); continue; }
    let prevT = -Infinity;
    for (const [t, o, h, l, c, v] of rows) {
      if (t <= prevT) { flag(date, s, 'timestamps not strictly increasing'); break; }
      prevT = t;
      if (!(o > 0 && h > 0 && l > 0 && c > 0) || v < 0) { flag(date, s, 'non-positive price or negative volume'); break; }
      if (h + 1e-9 < Math.max(o, c, l) || l - 1e-9 > Math.min(o, c, h)) { flag(date, s, 'high/low inconsistent with open/close'); break; }
    }
    // Agreement with the daily bar (same feed).
    const d = (daily[s] ?? []).find((r) => dayKey(r[0]) === date);
    const di = (daily[s] ?? []).findIndex((r) => dayKey(r[0]) === date);
    if (!d) { flag(date, s, 'no daily bar for the date'); continue; }
    const hi = Math.max(...session.map((r) => r[2]));
    const lo = Math.min(...session.map((r) => r[3]));
    // Daily high/low include extended hours, so the session range must sit inside it (small tolerance).
    if (hi > d[2] * 1.005 || lo < d[3] * 0.995) flag(date, s, 'minute range outside the daily range');
    const firstOpen = session[0][1];
    if (Math.abs(firstOpen - d[1]) / d[1] > 0.03) flag(date, s, 'first minute open far from the daily open (>3%)');
    const m = raw.meta[s];
    if (m && di > 0) {
      const prevClose = daily[s][di - 1][4];
      if (Math.abs(prevClose - m.prevClose) > 1e-6) flag(date, s, 'meta prevClose differs from the daily bars');
      const gap = ((m.open - m.prevClose) / m.prevClose) * 100;
      if (Math.abs(gap - m.gapPct) > 1e-6) flag(date, s, 'meta gapPct inconsistent');
    }
  }
}

writeFileSync(resolve(DIR, 'quality.json'), JSON.stringify(bad, null, 1));
const flagged = Object.values(bad).reduce((a, x) => a + Object.keys(x).length, 0);
coverage.sort((a, b) => a - b);
const pct = (q: number) => Math.round(coverage[Math.floor(q * (coverage.length - 1))] * 1000) / 10;
console.log(JSON.stringify({
  dataset: DIR,
  days: readdirSync(resolve(DIR, 'days')).length,
  symbolDays,
  flagged,
  flaggedPct: Math.round((flagged / symbolDays) * 1000) / 10,
  reasons: counts,
  minuteCoveragePct: { p10: pct(0.1), median: pct(0.5), p90: pct(0.9) },
}, null, 1));
