import type { Bar } from './store';

/** Combine 1-minute bars into `minutes`-minute bars (bucketed on epoch time, which lines up with the 09:30 NY open). */
export function aggregate(bars: Bar[], minutes: number): Bar[] {
  if (minutes <= 1) return bars;
  const span = minutes * 60_000;
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / span) * span;
    const last = out.at(-1);
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ ...b, t });
    }
  }
  return out;
}

/** Exponential moving average of closes; null until `period` bars exist (seeded with the simple average). */
export function ema(bars: Bar[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let sum = 0;
  return bars.map((b, i) => {
    if (i < period - 1) { sum += b.c; return null; }
    if (prev === null) { sum += b.c; prev = sum / period; return prev; }
    prev = b.c * k + prev * (1 - k);
    return prev;
  });
}

/** Wilder's RSI of closes; null until `period` price changes exist. */
export function rsi(bars: Bar[], period = 14): (number | null)[] {
  let avgGain = 0;
  let avgLoss = 0;
  return bars.map((b, i) => {
    if (i === 0) return null;
    const change = b.c - bars[i - 1].c;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i < period) return null;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  });
}

/** Wilder's Average True Range; null until `period` bars exist. */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  let value = 0;
  return bars.map((b, i) => {
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < period) {
      value += tr / period;
      return i === period - 1 ? value : null;
    }
    value = (value * (period - 1) + tr) / period;
    return value;
  });
}
