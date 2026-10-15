import type { Side } from '../types.js';

/**
 * Trading cost model. Defaults follow IBKR Pro "Fixed" pricing for US stocks
 * (USD 0.005/share, USD 1.00 minimum, capped at 1% of trade value) plus the two
 * regulatory transaction fees brokers pass through on sales.
 */
export interface FeeSchedule {
  commissionPerShare: number;
  /** Minimum commission per order (not per partial fill). */
  minCommission: number;
  /** Commission cap as a fraction of order value; 0 = no cap. */
  maxCommissionPct: number;
  /** SEC Section 31 fee on sales, USD per $1M of proceeds. */
  secFeePerMillion: number;
  /** FINRA Trading Activity Fee on sales, USD per share. */
  tafPerShare: number;
  /** FINRA TAF cap per trade. */
  tafMaxPerTrade: number;
}

const ceilCent = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
const roundCent = (x: number) => Math.round(x * 100) / 100;

/** Total broker commission for an order that has filled `qty` shares worth `notional` so far. */
export function orderCommission(qty: number, notional: number, f: FeeSchedule): number {
  if (qty <= 0) return 0;
  let c = Math.max(qty * f.commissionPerShare, f.minCommission);
  if (f.maxCommissionPct > 0) c = Math.min(c, notional * f.maxCommissionPct);
  return roundCent(c);
}

/** SEC + FINRA fees for one execution. Only sales are charged; each fee rounds up to the cent. */
export function regulatoryFees(side: Side, qty: number, notional: number, f: FeeSchedule): number {
  if (side !== 'sell' || qty <= 0) return 0;
  const sec = f.secFeePerMillion > 0 ? ceilCent((notional * f.secFeePerMillion) / 1_000_000) : 0;
  const taf = f.tafPerShare > 0 ? ceilCent(Math.min(qty * f.tafPerShare, f.tafMaxPerTrade || Infinity)) : 0;
  return roundCent(sec + taf);
}

/** Estimated cost of a full round trip (buy + sell of `qty` shares around `price`). */
export function roundTripCost(qty: number, price: number, f: FeeSchedule): number {
  const notional = qty * price;
  return roundCent(2 * orderCommission(qty, notional, f) + regulatoryFees('sell', qty, notional, f));
}
