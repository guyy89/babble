import { EventEmitter } from 'node:events';
import type { RiskConfig } from './config.js';
import type { Broker } from './broker/broker.js';
import type { MarketClock } from './market/clock.js';
import type { MarketDataFeed } from './market/feed.js';
import { RiskManager } from './risk/riskManager.js';
import type { Account, Order, OrderRequest, ServerEvent } from './types.js';

/**
 * Ties market data, broker and risk together and exposes a single event stream
 * ('event' → ServerEvent) for the API layer.
 */
export class TradingService extends EventEmitter {
  private readonly risk: RiskManager;
  private timer?: NodeJS.Timeout;
  private accountDirty = false;
  private flattenedForDate?: string;
  private lossNoticeForDate?: string;

  constructor(
    readonly feed: MarketDataFeed,
    readonly broker: Broker,
    readonly clock: MarketClock,
    private readonly riskCfg: RiskConfig,
  ) {
    super();
    this.risk = new RiskManager(riskCfg);
  }

  async start(): Promise<void> {
    this.feed.on('quote', (q) => this.send({ type: 'quote', data: q }));
    this.feed.on('bar', (b) => this.send({ type: 'bar', data: b }));
    this.broker.on('order', (o: Order) => {
      this.send({ type: 'order', data: o });
      if (o.status === 'rejected') this.notice('warn', `${o.side.toUpperCase()} ${o.qty} ${o.symbol} rejected: ${o.rejectReason}`);
    });
    this.broker.on('fill', (f) => this.send({ type: 'fill', data: f }));
    this.broker.on('account', () => (this.accountDirty = true));

    await this.feed.start();
    await this.broker.start();

    // Account/position snapshots are throttled; quotes move them many times a second.
    this.timer = setInterval(() => void this.tick(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.feed.stop();
    this.broker.stop();
  }

  async account(): Promise<Account> {
    const acct = await this.broker.getAccount();
    if (this.risk.dailyLossBreached(acct)) {
      acct.tradingBlocked = true;
      acct.blockReason = `Daily loss limit ($${this.riskCfg.maxDailyLoss}) reached — closing orders only`;
    }
    return acct;
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    const symbol = String(req.symbol ?? '').toUpperCase();
    const positions = await this.broker.getPositions();
    const reason = this.risk.check(
      { ...req, symbol },
      { account: await this.account(), position: positions.find((p) => p.symbol === symbol), quote: this.feed.getQuote(symbol) },
    );
    if (reason) {
      const now = Date.now();
      const rejected: Order = {
        id: `risk-${now}`, symbol, side: req.side, qty: Number(req.qty), type: req.type, tif: req.tif ?? 'day',
        limitPrice: req.limitPrice, stopPrice: req.stopPrice, status: 'rejected', rejectReason: `risk: ${reason}`,
        filledQty: 0, avgFillPrice: 0, createdAt: now, updatedAt: now,
      };
      this.notice('warn', `${req.side?.toUpperCase()} ${req.qty} ${symbol} blocked by risk: ${reason}`);
      return rejected;
    }
    return this.broker.submitOrder({ ...req, symbol });
  }

  notice(level: 'info' | 'warn', message: string): void {
    this.send({ type: 'notice', data: { level, message, ts: Date.now() } });
  }

  private send(ev: ServerEvent): void {
    this.emit('event', ev);
  }

  private async tick(): Promise<void> {
    const clock = this.clock.state();
    this.send({ type: 'clock', data: clock });

    const cfg = this.riskCfg;
    if (
      !clock.alwaysOpen && clock.isOpen && cfg.flattenMinutesBeforeClose > 0 &&
      clock.minutesToClose !== null && clock.minutesToClose <= cfg.flattenMinutesBeforeClose &&
      this.flattenedForDate !== clock.nyDate
    ) {
      this.flattenedForDate = clock.nyDate;
      this.notice('warn', `Auto-flatten: closing all positions ${cfg.flattenMinutesBeforeClose} min before the close`);
      await this.broker.closeAll();
    }

    if (!this.accountDirty) return;
    this.accountDirty = false;
    const acct = await this.account();
    if (acct.tradingBlocked && this.lossNoticeForDate !== clock.nyDate) {
      this.lossNoticeForDate = clock.nyDate;
      this.notice('warn', acct.blockReason!);
    }
    this.send({ type: 'account', data: acct });
    this.send({ type: 'positions', data: await this.broker.getPositions() });
  }
}
