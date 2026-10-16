import { useEffect, useState } from 'react';

// Per-browser preferences (indicator setup, drawn lines, price alerts, layout). Storage can be
// unavailable (private window, blocked site data), so every access is guarded and falls back.

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function readArray<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory value still applies for this session.
  }
}

/** useState that survives reloads. Objects are merged over the default so new fields get defaults. */
export function usePref<T extends object>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => (Array.isArray(fallback) ? (readArray(key) as T) : read(key, fallback)));
  useEffect(() => write(key, value), [key, value]);
  return [value, setValue] as const;
}

export interface IndicatorConfig {
  vwap: boolean;
  ema1: { on: boolean; len: number };
  ema2: { on: boolean; len: number };
  sma1: { on: boolean; len: number };
  sma2: { on: boolean; len: number };
  bb: { on: boolean; len: number; mult: number };
  rsi: { on: boolean; len: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
  /** Yesterday's high, low and close as lines on intraday charts. */
  prevDay: boolean;
  volume: boolean;
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  vwap: true,
  ema1: { on: true, len: 9 },
  ema2: { on: true, len: 20 },
  sma1: { on: false, len: 50 },
  sma2: { on: false, len: 200 },
  bb: { on: false, len: 20, mult: 2 },
  rsi: { on: true, len: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
  prevDay: true,
  volume: true,
};

export interface PriceAlert {
  id: string;
  symbol: string;
  price: number;
  /** Fires when the last price crosses to this side of `price`. */
  dir: 'above' | 'below';
  createdAt: number;
}

/** Horizontal levels drawn by the user, per symbol. */
export type DrawnLines = Record<string, number[]>;
