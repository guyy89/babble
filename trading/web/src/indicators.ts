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

/** Simple moving average of closes; null until `period` bars exist. */
export function sma(bars: Bar[], period: number): (number | null)[] {
  let sum = 0;
  return bars.map((b, i) => {
    sum += b.c;
    if (i >= period) sum -= bars[i - period].c;
    return i >= period - 1 ? sum / period : null;
  });
}

/** Bollinger Bands: SMA ± `mult` population standard deviations. */
export function bollinger(bars: Bar[], period = 20, mult = 2) {
  const mid = sma(bars, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  bars.forEach((_, i) => {
    const m = mid[i];
    if (m === null) { upper.push(null); lower.push(null); return; }
    let v = 0;
    for (let k = i - period + 1; k <= i; k++) v += (bars[k].c - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  });
  return { mid, upper, lower };
}

/** MACD line (fast EMA − slow EMA), its signal EMA and the histogram. */
export function macd(bars: Bar[], fast = 12, slow = 26, signal = 9) {
  const f = ema(bars, fast);
  const s = ema(bars, slow);
  const line = bars.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  // Signal = EMA of the MACD line over the points where it exists.
  const k = 2 / (signal + 1);
  let prev: number | null = null;
  let seen = 0;
  let seed = 0;
  const sig = line.map((v) => {
    if (v === null) return null;
    seen++;
    if (seen < signal) { seed += v; return null; }
    if (prev === null) { prev = (seed + v) / signal; return prev; }
    prev = v * k + prev * (1 - k);
    return prev;
  });
  const hist = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]!));
  return { line, signal: sig, hist };
}
