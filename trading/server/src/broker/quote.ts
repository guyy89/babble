import type { Quote } from '../types.js';

/**
 * The quote the simulator executes against. A single-venue feed (Alpaca's free IEX data) often shows
 * a far wider spread than the real national best bid/offer, e.g. 525.00 / 550.00 around a 529.50 last.
 * Filling at that ask would invent a loss no real broker would charge, so each side is pulled to within
 * `maxDeviationBps` of the last trade. Quotes that are already tight pass through unchanged.
 */
export function executableQuote(q: Quote, maxDeviationBps: number): Quote {
  if (!(maxDeviationBps > 0) || !(q.last > 0)) return q;
  const band = (q.last * maxDeviationBps) / 10_000;
  const tick = q.last >= 1 ? 0.01 : 0.0001;
  const bid = Math.max(q.bid, round(q.last - band, tick));
  const ask = Math.min(q.ask, round(q.last + band, tick));
  if (bid === q.bid && ask === q.ask) return q;
  return { ...q, bid, ask: Math.max(ask, round(bid + tick, tick)) };
}

const round = (x: number, tick: number) => Number((Math.round(x / tick) * tick).toFixed(4));
