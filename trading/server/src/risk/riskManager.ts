import type { RiskConfig } from '../config.js';
import type { Account, OrderRequest, Position, Quote } from '../types.js';
import { openingPart } from '../broker/paperBroker.js';

export interface RiskContext {
  account: Account;
  position?: Position;
  quote?: Quote;
}

/**
 * Account-level guard rails that sit in front of *any* broker, paper or live.
 * Orders that only reduce an existing position are always allowed through so
 * the trader can never be locked into a losing position.
 */
export class RiskManager {
  constructor(private readonly cfg: RiskConfig) {}

  dailyLossBreached(account: Account): boolean {
    return this.cfg.maxDailyLoss > 0 && account.dayPnl <= -this.cfg.maxDailyLoss;
  }

  /** noStopAllowed: the momentum robot trades without a stop by design; every other limit still applies. */
  check(req: OrderRequest, ctx: RiskContext, noStopAllowed = false): string | null {
    const pos = ctx.position?.qty ?? 0;
    const qty = Number(req.qty);
    if (!Number.isFinite(qty) || qty <= 0) return null; // shape errors are the broker's to report
    const delta = req.side === 'buy' ? qty : -qty;
    const opening = openingPart(pos, delta);
    if (opening === 0) return null;

    if (this.dailyLossBreached(ctx.account)) {
      return `הגעת למגבלת ההפסד היומי ($${this.cfg.maxDailyLoss}). היום מותרות רק פקודות סגירה`;
    }
    const price = req.limitPrice ?? req.stopPrice ?? (req.side === 'buy' ? ctx.quote?.ask : ctx.quote?.bid);
    if (!price) return null;

    if (this.cfg.maxRiskPerTrade > 0 && !noStopAllowed) {
      const stop = req.stopLoss?.stopPrice;
      if (stop === undefined) {
        return `חובה סטופ בכל פוזיציה חדשה (סיכון של עד $${this.cfg.maxRiskPerTrade} לעסקה)`;
      }
      const risk = qty * Math.abs(price - Number(stop));
      if (risk > this.cfg.maxRiskPerTrade + 1e-6) {
        const maxQty = Math.floor(this.cfg.maxRiskPerTrade / Math.abs(price - Number(stop)));
        return `הסיכון עד הסטופ ($${risk.toFixed(2)}) גבוה מהמגבלה של $${this.cfg.maxRiskPerTrade} לעסקה (עם הסטופ הזה: עד ${maxQty} מניות)`;
      }
    }

    const orderNotional = qty * price;
    if (this.cfg.maxOrderNotional > 0 && orderNotional > this.cfg.maxOrderNotional) {
      return `שווי הפקודה ($${orderNotional.toFixed(0)}) גבוה מגודל פקודה מקסימלי של $${this.cfg.maxOrderNotional}`;
    }
    const resulting = Math.abs(pos + delta) * price;
    if (this.cfg.maxPositionNotional > 0 && resulting > this.cfg.maxPositionNotional) {
      return `שווי הפוזיציה אחרי הפקודה ($${resulting.toFixed(0)}) גבוה מגודל פוזיציה מקסימלי של $${this.cfg.maxPositionNotional}`;
    }
    return null;
  }
}
