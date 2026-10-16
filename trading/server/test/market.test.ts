import { describe, expect, it } from 'vitest';
import { executableQuote } from '../src/broker/quote.js';
import { SymbolDirectory } from '../src/market/symbolDirectory.js';
import type { Quote } from '../src/types.js';

const q = (bid: number, ask: number, last: number): Quote => ({ symbol: 'AMD', bid, ask, bidSize: 100, askSize: 100, last, ts: 0 });

describe('executableQuote', () => {
  it('pulls an inflated single-venue spread to within the band around the last trade', () => {
    const e = executableQuote(q(525, 550, 529.5), 10); // band = 0.53
    expect(e.bid).toBe(528.97);
    expect(e.ask).toBe(530.03);
  });

  it('leaves a tight quote untouched', () => {
    const tight = q(100, 100.02, 100.01);
    expect(executableQuote(tight, 10)).toBe(tight);
  });

  it('is disabled at 0 bps or without a last trade', () => {
    const wide = q(525, 550, 529.5);
    expect(executableQuote(wide, 0)).toBe(wide);
    expect(executableQuote({ ...wide, last: 0 }, 10).ask).toBe(550);
  });

  it('never produces a crossed quote when the last trade sits outside the bid/ask', () => {
    const e = executableQuote(q(10, 10.5, 12), 10);
    expect(e.ask).toBeGreaterThan(e.bid);
  });
});

describe('SymbolDirectory.search', () => {
  const dir = new SymbolDirectory(async () => [
    { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' },
    { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.', exchange: 'NYSE' },
    { symbol: 'PINE', name: 'Alpine Income Property Trust', exchange: 'NYSE' },
    { symbol: 'A', name: 'Agilent Technologies', exchange: 'NYSE' },
  ]);

  it('ranks exact symbol, then symbol prefix, then name word, then name substring', async () => {
    await dir.load();
    expect(dir.search('a').map((s) => s.symbol).slice(0, 3)).toEqual(['A', 'AAPL', 'APLE']);
    expect(dir.search('apple').map((s) => s.symbol)).toEqual(['AAPL', 'APLE']);
    expect(dir.search('pine').map((s) => s.symbol)).toEqual(['PINE']);
    expect(dir.search('lpine').map((s) => s.symbol)).toEqual(['PINE']);
    expect(dir.search('  ')).toEqual([]);
  });
});
