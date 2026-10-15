import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PaperConfig } from '../config.js';
import type { MarketClock } from '../market/clock.js';
import type { MarketDataFeed } from '../market/feed.js';
import type { Account, Fill, Order, OrderRequest, Position, Quote } from '../types.js';
import type { Broker } from './broker.js';
import { BrokerError } from './broker.js';
import type { StateStore } from './stateStore.js';

// Local execution simulator. Aims to be pessimistic rather than flattering:
//  - market orders cross the spread and pay configurable slippage
//  - fills are capped by displayed size, so big orders fill partially over several quotes
//  - resting limit orders need the market to trade *through* the limit (no queue priority)
//  - stops trigger on the bid/ask, then fill like market orders
//  - margin / cash buying power and the FINRA pattern-day-trader rule are enforced

const PDT_EQUITY = 25_000;
const MAX_FILLS_KEPT = 2000;

interface PosState {
  qty: number;
  avgPrice: number;
  realizedToday: number;
  /** An opening fill happened today and has not yet been matched by a closing fill. */
  openedToday: boolean;
}

export interface PaperState {
  version: 1;
  nyDate: string;
  cash: number;
  dayStartEquity: number;
  commissionsToday: number;
  positions: Record<string, PosState>;
  orders: Order[];
  fills: Fill[];
  /** NY dates on which a day trade happened (one entry per day trade). */
  dayTrades: string[];
  /** Order ids that were not marketable on arrival and therefore rest in the book. */
  resting: string[];
}

const WORKING = new Set(['new', 'partially_filled']);
const OPEN = new Set(['new', 'partially_filled', 'held']);

const round2 = (x: number) => Math.round(x * 100) / 100;

export class PaperBroker extends EventEmitter implements Broker {
  readonly name = 'paper';
  private s: PaperState;
  private orders = new Map<string, Order>();
  private resting = new Set<string>();
  private onQuote = (q: Quote) => this.handleQuote(q);

  constructor(
    private readonly feed: MarketDataFeed,
    private readonly clock: MarketClock,
    private readonly cfg: PaperConfig,
    private readonly store?: StateStore<PaperState>,
    private readonly now: () => number = Date.now,
  ) {
    super();
    const loaded = store?.load();
    this.s = loaded ?? {
      version: 1,
      nyDate: clock.nyDate(),
      cash: cfg.startingCash,
      dayStartEquity: cfg.startingCash,
      commissionsToday: 0,
      positions: {},
      orders: [],
      fills: [],
      dayTrades: [],
      resting: [],
    };
    for (const o of this.s.orders) this.orders.set(o.id, o);
    for (const id of this.s.resting) this.resting.add(id);
  }

  async start(): Promise<void> {
    this.rollDayIfNeeded();
    this.feed.on('quote', this.onQuote);
  }

  stop(): void {
    this.feed.off('quote', this.onQuote);
    this.persist(true);
  }

  // ---------------------------------------------------------------- queries

  async getAccount(): Promise<Account> {
    return this.account();
  }

  async getPositions(): Promise<Position[]> {
    return Object.entries(this.s.positions)
      .filter(([, p]) => p.qty !== 0 || p.realizedToday !== 0)
      .map(([symbol, p]) => {
        const marketPrice = this.markPrice(symbol, p.avgPrice);
        return {
          symbol,
          qty: p.qty,
          avgPrice: p.avgPrice,
          marketPrice,
          marketValue: round2(p.qty * marketPrice),
          unrealizedPnl: round2(p.qty * (marketPrice - p.avgPrice)),
          realizedPnlToday: round2(p.realizedToday),
        };
      });
  }

  async getOrders(scope: 'open' | 'all' = 'all'): Promise<Order[]> {
    const list = [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    return scope === 'open' ? list.filter((o) => OPEN.has(o.status)) : list;
  }

  async getFills(): Promise<Fill[]> {
    return [...this.s.fills].reverse();
  }

  // ---------------------------------------------------------------- commands

  async submitOrder(req: OrderRequest): Promise<Order> {
    this.rollDayIfNeeded();
    const order = this.newOrder(req);
    const reason = this.validate(order, req);
    if (reason) {
      order.status = 'rejected';
      order.rejectReason = reason;
      this.track(order);
      return order;
    }

    this.track(order);
    if (req.takeProfit || req.stopLoss) {
      this.attachBracket(order, req);
      this.emit('order', { ...order });
    }

    const q = this.feed.getQuote(order.symbol);
    if (q) this.tryExecute(order, q, true);
    if (WORKING.has(order.status) && order.type !== 'market') this.resting.add(order.id);
    this.persist();
    return order;
  }

  async cancelOrder(id: string): Promise<Order> {
    const o = this.orders.get(id);
    if (!o) throw new BrokerError(`Order ${id} not found`, 404);
    if (!OPEN.has(o.status)) throw new BrokerError(`Order is already ${o.status}`);
    this.finish(o, 'canceled');
    this.persist();
    return o;
  }

  async cancelAll(): Promise<void> {
    for (const o of this.orders.values()) if (OPEN.has(o.status) && !o.parentId) this.finish(o, 'canceled');
    for (const o of this.orders.values()) if (OPEN.has(o.status)) this.finish(o, 'canceled');
    this.persist();
  }

  async closePosition(symbol: string): Promise<Order | undefined> {
    const p = this.s.positions[symbol];
    // Cancel anything working on the symbol first (incl. bracket legs), as brokers do.
    for (const o of this.orders.values()) if (o.symbol === symbol && OPEN.has(o.status)) this.finish(o, 'canceled');
    if (!p || p.qty === 0) return undefined;
    return this.submitOrder({ symbol, side: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), type: 'market' });
  }

  async closeAll(): Promise<void> {
    await this.cancelAll();
    for (const symbol of Object.keys(this.s.positions)) await this.closePosition(symbol);
  }

  // ---------------------------------------------------------------- internals

  private newOrder(req: OrderRequest): Order {
    const ts = this.now();
    return {
      id: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: String(req.symbol ?? '').toUpperCase(),
      side: req.side,
      qty: Number(req.qty),
      type: req.type,
      limitPrice: req.limitPrice,
      stopPrice: req.stopPrice,
      tif: req.tif ?? 'day',
      status: 'new',
      filledQty: 0,
      avgFillPrice: 0,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  private validate(o: Order, req: OrderRequest): string | null {
    if (o.side !== 'buy' && o.side !== 'sell') return 'side must be buy or sell';
    if (!['market', 'limit', 'stop', 'stop_limit'].includes(o.type)) return `unsupported order type ${o.type}`;
    if (!Number.isInteger(o.qty) || o.qty <= 0) return 'qty must be a positive whole number of shares';
    if (o.tif !== 'day' && o.tif !== 'gtc') return 'tif must be day or gtc';
    const q = this.feed.getQuote(o.symbol);
    if (!q) return `no market data for ${o.symbol || '(empty symbol)'}`;

    const needLimit = o.type === 'limit' || o.type === 'stop_limit';
    const needStop = o.type === 'stop' || o.type === 'stop_limit';
    if (needLimit && !validPrice(o.limitPrice)) return 'limitPrice is required and must be a valid price (cent increments above $1)';
    if (needStop && !validPrice(o.stopPrice)) return 'stopPrice is required and must be a valid price (cent increments above $1)';
    if (!needLimit) delete o.limitPrice;
    if (!needStop) delete o.stopPrice;
    if (o.type === 'stop' || o.type === 'stop_limit') {
      if (o.side === 'buy' && o.stopPrice! <= q.ask) return `buy stop must be above the ask (${q.ask})`;
      if (o.side === 'sell' && o.stopPrice! >= q.bid) return `sell stop must be below the bid (${q.bid})`;
    }

    const clock = this.clock.state();
    if (!clock.isOpen && o.type === 'market') return 'market is closed — use a limit order to queue for the open';

    const ref = this.referencePrice(o, q);

    if (req.takeProfit || req.stopLoss) {
      const err = this.validateBracket(o, req, ref);
      if (err) return err;
    }

    const pos = this.s.positions[o.symbol]?.qty ?? 0;
    const signed = o.side === 'buy' ? o.qty : -o.qty;
    const openingQty = openingPart(pos, signed);
    const closingQty = o.qty - openingQty;

    if (this.cfg.accountType === 'cash' && o.side === 'sell' && openingQty > 0) return 'short selling is not allowed in a cash account';

    if (openingQty > 0) {
      const acct = this.account();
      const needed = openingQty * ref + this.reservedBuyingPower();
      if (needed > acct.buyingPower + 1e-6) {
        return `insufficient buying power: need $${needed.toFixed(2)}, have $${acct.buyingPower.toFixed(2)}`;
      }
    }

    if (closingQty > 0 && this.wouldBreachPdt(o.symbol)) {
      return 'pattern day trader protection: this would be a 4th day trade in 5 business days with equity under $25,000';
    }
    return null;
  }

  private validateBracket(o: Order, req: OrderRequest, ref: number): string | null {
    if (o.type === 'stop' || o.type === 'stop_limit') return 'bracket entry must be a market or limit order';
    const tp = req.takeProfit?.limitPrice;
    const sl = req.stopLoss?.stopPrice;
    if (req.takeProfit && !validPrice(tp)) return 'takeProfit.limitPrice must be a valid price';
    if (req.stopLoss && !validPrice(sl)) return 'stopLoss.stopPrice must be a valid price';
    if (o.side === 'buy') {
      if (tp !== undefined && tp <= ref) return `take-profit (${tp}) must be above entry (~${ref})`;
      if (sl !== undefined && sl >= ref) return `stop-loss (${sl}) must be below entry (~${ref})`;
    } else {
      if (tp !== undefined && tp >= ref) return `take-profit (${tp}) must be below entry (~${ref})`;
      if (sl !== undefined && sl <= ref) return `stop-loss (${sl}) must be above entry (~${ref})`;
    }
    return null;
  }

  /** Buying power already committed to other working opening orders on the account. */
  private reservedBuyingPower(): number {
    let total = 0;
    for (const o of this.orders.values()) {
      if (!WORKING.has(o.status) || o.parentId) continue;
      const q = this.feed.getQuote(o.symbol);
      if (!q) continue;
      const pos = this.s.positions[o.symbol]?.qty ?? 0;
      const remaining = o.qty - o.filledQty;
      const opening = openingPart(pos, o.side === 'buy' ? remaining : -remaining);
      total += opening * this.referencePrice(o, q);
    }
    return total;
  }

  private referencePrice(o: Pick<Order, 'side' | 'limitPrice' | 'stopPrice'>, q: Quote): number {
    return o.limitPrice ?? o.stopPrice ?? (o.side === 'buy' ? q.ask : q.bid);
  }

  private wouldBreachPdt(symbol: string): boolean {
    if (this.cfg.accountType !== 'margin') return false;
    const p = this.s.positions[symbol];
    if (!p?.openedToday) return false;
    const acct = this.account();
    return acct.equity < PDT_EQUITY && acct.dayTradeCount >= 3;
  }

  private attachBracket(entry: Order, req: OrderRequest): void {
    const exitSide = entry.side === 'buy' ? 'sell' : 'buy';
    const legs: Order[] = [];
    const base = { ...this.newOrder({ symbol: entry.symbol, side: exitSide, qty: entry.qty, type: 'limit' }), tif: entry.tif };
    if (req.takeProfit) {
      legs.push({ ...base, id: randomUUID(), type: 'limit', limitPrice: req.takeProfit.limitPrice });
    }
    if (req.stopLoss) {
      legs.push({ ...base, id: randomUUID(), type: 'stop', stopPrice: req.stopLoss.stopPrice, limitPrice: undefined });
    }
    for (const leg of legs) {
      leg.status = 'held';
      leg.parentId = entry.id;
      if (legs.length > 1) leg.ocoGroup = entry.id;
      this.track(leg);
    }
    entry.legIds = legs.map((l) => l.id);
  }

  private track(o: Order): void {
    this.orders.set(o.id, o);
    this.emit('order', { ...o });
  }

  private touch(o: Order): void {
    o.updatedAt = this.now();
    this.emit('order', { ...o });
  }

  private finish(o: Order, status: 'canceled' | 'expired' | 'filled'): void {
    if (!OPEN.has(o.status) && status !== 'filled') return;
    o.status = status;
    this.resting.delete(o.id);
    this.touch(o);
    if (o.legIds && status !== 'filled') {
      // Entry canceled: activate legs for whatever got filled, otherwise cancel them.
      for (const id of o.legIds) {
        const leg = this.orders.get(id);
        if (!leg || leg.status !== 'held') continue;
        if (o.filledQty > 0) this.activateLeg(leg, o.filledQty);
        else this.finish(leg, status === 'expired' ? 'expired' : 'canceled');
      }
    }
  }

  private activateLeg(leg: Order, qty: number): void {
    leg.qty = qty;
    leg.status = 'new';
    this.touch(leg);
    const q = this.feed.getQuote(leg.symbol);
    if (q) this.tryExecute(leg, q, true);
    if (WORKING.has(leg.status)) this.resting.add(leg.id);
  }

  private handleQuote(q: Quote): void {
    this.rollDayIfNeeded();
    if (!this.clock.state().isOpen) return;
    let changed = false;
    for (const o of this.orders.values()) {
      if (o.symbol !== q.symbol || !WORKING.has(o.status)) continue;
      const before = o.filledQty;
      const wasTriggered = o.triggered;
      this.tryExecute(o, q, false);
      if (o.filledQty !== before || o.triggered !== wasTriggered) changed = true;
    }
    if (changed) this.persist();
    if (this.s.positions[q.symbol]?.qty) this.emit('account');
  }

  /** Attempts to (partially) fill a working order against the current quote. */
  private tryExecute(o: Order, q: Quote, onArrival: boolean): void {
    if (!WORKING.has(o.status) || !this.clock.state().isOpen) return;
    const buy = o.side === 'buy';

    if ((o.type === 'stop' || o.type === 'stop_limit') && !o.triggered) {
      const hit = buy ? q.ask >= o.stopPrice! : q.bid <= o.stopPrice!;
      if (!hit) return;
      o.triggered = true;
      this.touch(o);
    }

    const asMarket = o.type === 'market' || o.type === 'stop';
    const touch = buy ? q.ask : q.bid;
    let price: number;
    if (asMarket) {
      const slip = (this.cfg.slippageBps / 10_000) * touch;
      price = round2(buy ? touch + slip : touch - slip);
    } else {
      const lim = o.limitPrice!;
      // Marketable on arrival: fills at the touch. Resting: market must trade through the limit.
      const resting = !onArrival && this.resting.has(o.id);
      const fillable = buy ? (resting ? touch < lim : touch <= lim) : resting ? touch > lim : touch >= lim;
      if (!fillable) return;
      price = buy ? Math.min(touch, lim) : Math.max(touch, lim);
    }

    const displayed = buy ? q.askSize : q.bidSize;
    const available = Math.max(1, Math.floor(displayed * this.cfg.liquidityFraction));
    const qty = Math.min(o.qty - o.filledQty, available);
    if (qty > 0) this.applyFill(o, qty, price);
  }

  private applyFill(o: Order, qty: number, price: number): void {
    const ts = this.now();
    const commission = this.commission(qty);
    const p = (this.s.positions[o.symbol] ??= { qty: 0, avgPrice: 0, realizedToday: 0, openedToday: false });
    const delta = o.side === 'buy' ? qty : -qty;

    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(delta)) {
      p.avgPrice = (Math.abs(p.qty) * p.avgPrice + qty * price) / (Math.abs(p.qty) + qty);
      p.qty += delta;
      p.openedToday = true;
    } else {
      const closing = Math.min(qty, Math.abs(p.qty));
      p.realizedToday += closing * (price - p.avgPrice) * Math.sign(p.qty);
      if (p.openedToday) {
        this.s.dayTrades.push(this.s.nyDate);
        p.openedToday = false;
      }
      p.qty += delta;
      if (p.qty === 0) p.avgPrice = 0;
      else if (Math.sign(p.qty) === Math.sign(delta)) {
        // Flipped through zero: remainder opens a new position at this price.
        p.avgPrice = price;
        p.openedToday = true;
      }
    }
    p.realizedToday -= commission;
    this.s.cash += -delta * price - commission;
    this.s.commissionsToday += commission;

    o.avgFillPrice = (o.avgFillPrice * o.filledQty + price * qty) / (o.filledQty + qty);
    o.filledQty += qty;
    o.status = o.filledQty >= o.qty ? 'filled' : 'partially_filled';

    const fill: Fill = { id: randomUUID(), orderId: o.id, symbol: o.symbol, side: o.side, qty, price, commission, ts };
    this.s.fills.push(fill);
    if (this.s.fills.length > MAX_FILLS_KEPT) this.s.fills.splice(0, this.s.fills.length - MAX_FILLS_KEPT);
    this.emit('fill', fill);

    if (o.status === 'filled') this.finish(o, 'filled');
    else this.touch(o);

    // Bracket entry fully filled: release the exit legs.
    if (o.status === 'filled' && o.legIds) {
      for (const id of o.legIds) {
        const leg = this.orders.get(id);
        if (leg?.status === 'held') this.activateLeg(leg, o.filledQty);
      }
    }
    // One-cancels-other: shrink or cancel siblings so exits never exceed the position.
    if (o.ocoGroup) {
      for (const sib of this.orders.values()) {
        if (sib.id === o.id || sib.ocoGroup !== o.ocoGroup || !OPEN.has(sib.status)) continue;
        if (o.status === 'filled') this.finish(sib, 'canceled');
        else {
          sib.qty = sib.filledQty + (o.qty - o.filledQty);
          this.touch(sib);
        }
      }
    }
    this.emit('account');
  }

  private commission(qty: number): number {
    const raw = qty * this.cfg.commissionPerShare;
    if (raw === 0 && this.cfg.minCommission === 0) return 0;
    return round2(Math.max(raw, this.cfg.minCommission));
  }

  private markPrice(symbol: string, fallback: number): number {
    const q = this.feed.getQuote(symbol);
    return q?.last || (q ? (q.bid + q.ask) / 2 : fallback);
  }

  private account(): Account {
    let longMv = 0;
    let shortMv = 0;
    let realized = 0;
    for (const [symbol, p] of Object.entries(this.s.positions)) {
      realized += p.realizedToday;
      if (p.qty === 0) continue;
      const mv = p.qty * this.markPrice(symbol, p.avgPrice);
      if (mv > 0) longMv += mv;
      else shortMv += mv;
    }
    const equity = this.s.cash + longMv + shortMv;
    const gross = longMv - shortMv;
    const margin = this.cfg.accountType === 'margin';
    const multiplier = equity >= PDT_EQUITY ? 4 : 2;
    const buyingPower = margin ? Math.max(0, equity * multiplier - gross) : Math.max(0, this.s.cash);
    const dayTradeCount = this.dayTradeCount();
    return {
      mode: 'paper',
      accountType: this.cfg.accountType,
      cash: round2(this.s.cash),
      equity: round2(equity),
      longMarketValue: round2(longMv),
      shortMarketValue: round2(shortMv),
      buyingPower: round2(buyingPower),
      dayStartEquity: round2(this.s.dayStartEquity),
      dayPnl: round2(equity - this.s.dayStartEquity),
      realizedPnlToday: round2(realized),
      commissionsToday: round2(this.s.commissionsToday),
      dayTradeCount,
      patternDayTrader: margin && dayTradeCount >= 4,
      tradingBlocked: false,
    };
  }

  private dayTradeCount(): number {
    const window = new Set(lastBusinessDays(this.s.nyDate, 5));
    return this.s.dayTrades.filter((d) => window.has(d)).length;
  }

  /** New trading day: expire DAY orders, reset daily P&L counters. */
  private rollDayIfNeeded(): void {
    const today = this.clock.nyDate();
    if (today === this.s.nyDate) return;
    for (const o of this.orders.values()) if (OPEN.has(o.status) && o.tif === 'day') this.finish(o, 'expired');
    // Drop finished orders from previous days; keep the blotter to the current session.
    for (const [id, o] of this.orders) if (!OPEN.has(o.status)) this.orders.delete(id);
    for (const [sym, p] of Object.entries(this.s.positions)) {
      p.realizedToday = 0;
      p.openedToday = false;
      if (p.qty === 0) delete this.s.positions[sym];
    }
    this.s.nyDate = today;
    this.s.commissionsToday = 0;
    this.s.dayStartEquity = this.account().equity;
    const window = new Set(lastBusinessDays(today, 5));
    this.s.dayTrades = this.s.dayTrades.filter((d) => window.has(d));
    this.persist(true);
    this.emit('account');
  }

  private persist(immediate = false): void {
    if (!this.store) return;
    this.s.orders = [...this.orders.values()];
    this.s.resting = [...this.resting];
    this.store.save(this.s, immediate);
  }
}

/** How many shares of `delta` increase exposure given current signed position `pos`. */
export function openingPart(pos: number, delta: number): number {
  if (pos === 0 || Math.sign(pos) === Math.sign(delta)) return Math.abs(delta);
  return Math.max(0, Math.abs(delta) - Math.abs(pos));
}

function validPrice(p: unknown): p is number {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return false;
  const step = p >= 1 ? 0.01 : 0.0001;
  return Math.abs(Math.round(p / step) * step - p) < 1e-9;
}

/** The given date plus the preceding business days (weekends skipped), `n` dates total. */
export function lastBusinessDays(nyDate: string, n: number): string[] {
  const [y, m, d] = nyDate.split('-').map(Number);
  const out: string[] = [];
  const t = new Date(Date.UTC(y, m - 1, d));
  while (out.length < n) {
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() - 1);
  }
  return out;
}
