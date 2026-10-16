import { EventEmitter } from 'node:events';
import type { RiskConfig } from './config.js';
import { BrokerError, type Broker } from './broker/broker.js';
import type { StateStore } from './broker/stateStore.js';
import type { MarketClock } from './market/clock.js';
import type { MarketDataFeed } from './market/feed.js';
import type { SymbolDirectory } from './market/symbolDirectory.js';
import { RiskManager } from './risk/riskManager.js';
import type { Account, Order, OrderRequest, ServerEvent } from './types.js';

const SIDE_HE = { buy: 'קנייה', sell: 'מכירה' } as const;
const sideHe = (s: unknown) => SIDE_HE[s as keyof typeof SIDE_HE] ?? String(s);

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
    readonly directory: SymbolDirectory,
    private readonly watchlistStore?: StateStore<string[]>,
  ) {
    super();
    this.risk = new RiskManager(riskCfg);
  }

  async start(): Promise<void> {
    this.feed.on('quote', (q) => this.send({ type: 'quote', data: q }));
    this.feed.on('bar', (b) => this.send({ type: 'bar', data: b }));
    this.feed.on('trade', (t) => this.send({ type: 'trade', data: t }));
    this.broker.on('order', (o: Order) => {
      this.send({ type: 'order', data: o });
      if (o.status === 'rejected') this.notice('warn', `${sideHe(o.side)} ${o.qty} ${o.symbol} נדחתה: ${o.rejectReason}`);
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
      acct.blockReason = `הגעת למגבלת ההפסד היומי ($${this.riskCfg.maxDailyLoss}). מותרות רק פקודות סגירה`;
    }
    if (acct.marginCall) {
      acct.tradingBlocked = true;
      acct.blockReason = `חוסר בביטחונות: ההון ($${acct.equity.toFixed(2)}) נמוך מהדרישה ($${acct.maintenanceRequirement.toFixed(2)}). צריך להקטין פוזיציות`;
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
        limitPrice: req.limitPrice, stopPrice: req.stopPrice, status: 'rejected', rejectReason: `ניהול סיכונים: ${reason}`,
        filledQty: 0, avgFillPrice: 0, createdAt: now, updatedAt: now,
      };
      this.notice('warn', `${sideHe(req.side)} ${req.qty} ${symbol} נחסמה בגלל ניהול סיכונים: ${reason}`);
      return rejected;
    }
    return this.broker.submitOrder({ ...req, symbol });
  }

  /** Watchlist symbols with company names, in watchlist order. */
  watchlist(): { symbol: string; name: string }[] {
    return this.feed.symbols().map((symbol) => ({ symbol, name: this.directory.get(symbol)?.name ?? '' }));
  }

  async addSymbol(raw: string): Promise<void> {
    const symbol = String(raw ?? '').trim().toUpperCase();
    if (!this.directory.get(symbol)) throw new BrokerError(`המניה ${symbol || '(ריק)'} לא נמצאה ברשימת המניות הנסחרות`, 404);
    if (this.feed.symbols().includes(symbol)) return;
    try {
      await this.feed.addSymbol(symbol);
    } catch (err) {
      console.error(`[watchlist] could not add ${symbol}:`, err);
      throw new BrokerError(`לא הצלחתי לטעון נתונים עבור ${symbol}`, 502);
    }
    this.watchlistChanged();
  }

  async removeSymbol(raw: string): Promise<void> {
    const symbol = String(raw ?? '').trim().toUpperCase();
    const position = (await this.broker.getPositions()).find((p) => p.symbol === symbol && p.qty !== 0);
    const openOrders = (await this.broker.getOrders('open')).some((o) => o.symbol === symbol);
    // Without a live quote the position can't be marked or protected, so it has to stay subscribed.
    if (position || openOrders) throw new BrokerError(`אי אפשר להסיר את ${symbol} כשיש בה פוזיציה או פקודה פתוחה`, 409);
    this.feed.removeSymbol(symbol);
    this.watchlistChanged();
  }

  private watchlistChanged(): void {
    this.watchlistStore?.save(this.feed.symbols(), true);
    this.send({ type: 'symbols', data: this.watchlist() });
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
      this.notice('warn', `סגירה אוטומטית: כל הפוזיציות נסגרות ${cfg.flattenMinutesBeforeClose} דקות לפני סוף המסחר`);
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
