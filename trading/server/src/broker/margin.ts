// Margin requirement model.
//
// 'intraday' — FINRA intraday margin standards (Rule 4210 as amended, approved by the SEC on
//   2026-04-14, effective 2026-06-04). There is no day-trade count and no $25,000 minimum:
//   equity must cover the maintenance requirement of the positions actually held during the day.
//   Margin (leverage and short selling) needs at least $2,000 of equity.
// 'pdt' — the legacy pattern-day-trader regime, kept because brokers may phase the change in
//   until 2027-10-20: 4x intraday leverage with $25,000+ equity, Reg T 2x below that, and a
//   block on the 4th day trade in 5 business days under $25,000.

export type MarginModel = 'intraday' | 'pdt';
export type AccountType = 'cash' | 'margin';

export const MARGIN_MIN_EQUITY = 2_000;
export const PDT_MIN_EQUITY = 25_000;
const LONG_MAINTENANCE = 0.25;
const SHORT_MAINTENANCE = 0.3;

export interface RequirementRates {
  /** Fraction of long market value that must be covered by equity. */
  long: number;
  /** Fraction of short market value that must be covered, or null when shorting isn't allowed. */
  short: number | null;
}

export function requirementRates(accountType: AccountType, model: MarginModel, equity: number): RequirementRates {
  if (accountType === 'cash') return { long: 1, short: null };
  if (equity < MARGIN_MIN_EQUITY) return { long: 1, short: null };
  if (model === 'pdt') {
    const r = equity >= PDT_MIN_EQUITY ? 0.25 : 0.5;
    return { long: r, short: r };
  }
  return { long: LONG_MAINTENANCE, short: SHORT_MAINTENANCE };
}

export function requirement(longMv: number, shortMvAbs: number, rates: RequirementRates): number {
  // An existing short whose requirement can't be computed (equity dropped below the margin minimum)
  // is charged at 100% so it still consumes equity.
  return longMv * rates.long + shortMvAbs * (rates.short ?? 1);
}
