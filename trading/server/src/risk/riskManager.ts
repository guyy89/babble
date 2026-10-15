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

  check(req: OrderRequest, ctx: RiskContext): string | null {
    const pos = ctx.position?.qty ?? 0;
    const qty = Number(req.qty);
    if (!Number.isFinite(qty) || qty <= 0) return null; // shape errors are the broker's to report
    const delta = req.side === 'buy' ? qty : -qty;
    const opening = openingPart(pos, delta);
    if (opening === 0) return null;

    if (this.dailyLossBreached(ctx.account)) {
      return `daily loss limit of $${this.cfg.maxDailyLoss} reached — only closing orders are allowed today`;
    }
    const price = req.limitPrice ?? req.stopPrice ?? (req.side === 'buy' ? ctx.quote?.ask : ctx.quote?.bid);
    if (!price) return null;

    if (this.cfg.maxRiskPerTrade > 0) {
      const stop = req.stopLoss?.stopPrice;
      if (stop === undefined) {
        return `a stop-loss is required on every new position (max risk $${this.cfg.maxRiskPerTrade} per trade)`;
      }
      const risk = qty * Math.abs(price - Number(stop));
      if (risk > this.cfg.maxRiskPerTrade + 1e-6) {
        const maxQty = Math.floor(this.cfg.maxRiskPerTrade / Math.abs(price - Number(stop)));
        return `risk to stop $${risk.toFixed(2)} exceeds max $${this.cfg.maxRiskPerTrade} per trade (max ${maxQty} shares at this stop)`;
      }
    }

    const orderNotional = qty * price;
    if (this.cfg.maxOrderNotional > 0 && orderNotional > this.cfg.maxOrderNotional) {
      return `order value $${orderNotional.toFixed(0)} exceeds max order size $${this.cfg.maxOrderNotional}`;
    }
    const resulting = Math.abs(pos + delta) * price;
    if (this.cfg.maxPositionNotional > 0 && resulting > this.cfg.maxPositionNotional) {
      return `resulting position $${resulting.toFixed(0)} exceeds max position size $${this.cfg.maxPositionNotional}`;
    }
    return null;
  }
}
