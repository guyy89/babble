import { EventEmitter } from 'node:events';
import type { Account, Fill, Order, OrderRequest, OrderStatus, OrderType, Position, Side } from '../types.js';
import type { Broker, OrderChanges } from './broker.js';
import { BrokerError } from './broker.js';
import { regulatoryFees, type FeeSchedule } from './fees.js';

// Executes through Alpaca's trading API (the paper endpoint by default): orders, fills, positions and the
// account come from Alpaca; the screen, risk checks and robots are unchanged. Alpaca's paper account does not
// deduct the pass-through regulatory fees, so they are computed here (FeeSchedule) and shown as costs.

interface Creds { keyId: string; secretKey: string }

type AOrder = {
  id: string; client_order_id?: string; symbol: string; side: Side; qty?: string | null; type: string; order_type?: string;
  limit_price?: string | null; stop_price?: string | null; trail_price?: string | null; time_in_force: string; status: string;
  filled_qty: string; filled_avg_price?: string | null; created_at: string; updated_at?: string; legs?: AOrder[] | null;
};
type APosition = { symbol: string; qty: string; side: 'long' | 'short'; avg_entry_price: string; current_price?: string; market_value?: string; unrealized_pl?: string };
type AAccount = Record<string, string | boolean | number | null | undefined>;
type AActivity = { id: string; order_id: string; symbol: string; side: string; qty: string; price: string; transaction_time: string };

const OPEN = new Set<OrderStatus>(['new', 'partially_filled', 'held']);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const nyDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));

function mapStatus(s: string): OrderStatus {
  switch (s) {
    case 'partially_filled': return 'partially_filled';
    case 'filled': return 'filled';
    case 'held': return 'held';
    case 'rejected': return 'rejected';
    case 'canceled': case 'replaced': return 'canceled';
    case 'expired': case 'done_for_day': return 'expired';
    default: return 'new'; // new, accepted, pending_new, pending_cancel, pending_replace, accepted_for_bidding, calculated…
  }
}

export class AlpacaBroker extends EventEmitter implements Broker {
  readonly name = 'alpaca-paper';
  private orders = new Map<string, Order>();
  private fills: Fill[] = []; // oldest first
  private account?: AAccount;
  private positions: APosition[] = [];
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly creds: Creds,
    private readonly fees: FeeSchedule,
    private readonly baseUrl = 'https://paper-api.alpaca.markets',
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await this.refresh();
    const since = new Date(this.now() - 6 * 86400_000).toISOString();
    for (const o of await this.api<AOrder[]>('GET', `/v2/orders?status=all&nested=true&limit=500&after=${since}`)) this.store(o);
    await this.loadFills(since);
    this.connect();
    // Account and positions (prices move them) are polled; orders and fills arrive on the stream.
    this.timer = setInterval(() => void this.refresh().then(() => this.emit('account')).catch((e) => console.error('[alpaca broker]', e)), 3000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
  }

  // ---------------------------------------------------------------- queries

  async getAccount(): Promise<Account> {
    const a = this.account ?? {};
    const equity = num(a.equity) ?? 0;
    const today = nyDate(this.now());
    const feesToday = this.fills.filter((f) => nyDate(f.ts) === today).reduce((s, f) => s + f.fees + f.commission, 0);
    const realized = this.realizedToday();
    const realizedTotal = [...realized.values()].reduce((s, v) => s + v, 0);
    const maintenance = num(a.maintenance_margin) ?? 0;
    return {
      mode: 'alpaca-paper',
      accountType: (num(a.multiplier) ?? 1) > 1 ? 'margin' : 'cash',
      marginModel: 'intraday',
      cash: num(a.cash) ?? 0,
      equity,
      longMarketValue: num(a.long_market_value) ?? 0,
      shortMarketValue: num(a.short_market_value) ?? 0,
      buyingPower: num(a.buying_power) ?? 0,
      maintenanceRequirement: maintenance,
      marginCall: equity < maintenance,
      dayStartEquity: num(a.last_equity) ?? equity,
      // Net of the regulatory fees Alpaca's paper account does not deduct.
      dayPnl: round2(equity - (num(a.last_equity) ?? equity) - feesToday),
      realizedPnlToday: round2(realizedTotal),
      commissionsToday: round2(feesToday),
      dayTradeCount: num(a.daytrade_count) ?? 0,
      patternDayTrader: a.pattern_day_trader === true,
      tradingBlocked: a.trading_blocked === true || a.account_blocked === true,
      blockReason: a.trading_blocked === true || a.account_blocked === true ? 'אלפקה חסמה מסחר בחשבון' : undefined,
    };
  }

  async getPositions(): Promise<Position[]> {
    const realized = this.realizedToday();
    const out: Position[] = this.positions.map((p) => {
      const qty = Math.abs(Number(p.qty)) * (p.side === 'short' ? -1 : 1);
      return {
        symbol: p.symbol, qty, avgPrice: Number(p.avg_entry_price), marketPrice: num(p.current_price) ?? Number(p.avg_entry_price),
        marketValue: num(p.market_value) ?? 0, unrealizedPnl: num(p.unrealized_pl) ?? 0, realizedPnlToday: round2(realized.get(p.symbol) ?? 0),
      };
    });
    // Like the paper broker: symbols closed today still show their realized result.
    for (const [symbol, r] of realized) {
      if (r !== 0 && !out.some((p) => p.symbol === symbol)) {
        out.push({ symbol, qty: 0, avgPrice: 0, marketPrice: 0, marketValue: 0, unrealizedPnl: 0, realizedPnlToday: round2(r) });
      }
    }
    return out;
  }

  async getOrders(scope: 'open' | 'all' = 'all'): Promise<Order[]> {
    const list = [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    return scope === 'open' ? list.filter((o) => OPEN.has(o.status)) : list;
  }

  async getFills(): Promise<Fill[]> {
    return [...this.fills].reverse();
  }

  // ---------------------------------------------------------------- commands

  async submitOrder(req: OrderRequest): Promise<Order> {
    const body: Record<string, unknown> = {
      symbol: req.symbol, qty: String(req.qty), side: req.side, type: req.type, time_in_force: req.tif ?? 'day',
      limit_price: req.limitPrice, stop_price: req.stopPrice, client_order_id: req.clientOrderId,
    };
    if (req.takeProfit && req.stopLoss) body.order_class = 'bracket';
    else if (req.takeProfit || req.stopLoss) body.order_class = 'oto';
    if (req.takeProfit) body.take_profit = { limit_price: req.takeProfit.limitPrice };
    if (req.stopLoss) body.stop_loss = { stop_price: req.stopLoss.stopPrice };
    try {
      const o = await this.api<AOrder>('POST', '/v2/orders', body);
      const order = this.store(o);
      this.emit('order', order);
      return order;
    } catch (err) {
      const now = this.now();
      const rejected: Order = {
        id: `rej-${now}`, clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side, qty: req.qty, type: req.type, tif: req.tif ?? 'day',
        limitPrice: req.limitPrice, stopPrice: req.stopPrice, status: 'rejected', rejectReason: `אלפקה: ${(err as Error).message}`,
        filledQty: 0, avgFillPrice: 0, createdAt: now, updatedAt: now,
      };
      this.orders.set(rejected.id, rejected);
      this.emit('order', rejected);
      return rejected;
    }
  }

  async cancelOrder(id: string): Promise<Order> {
    await this.api('DELETE', `/v2/orders/${id}`);
    return this.store(await this.api<AOrder>('GET', `/v2/orders/${id}?nested=true`));
  }

  async modifyOrder(id: string, changes: OrderChanges): Promise<Order> {
    const body: Record<string, unknown> = { limit_price: changes.limitPrice, stop_price: changes.stopPrice };
    if (changes.trailAmount !== undefined && changes.trailAmount !== null) body.trail = changes.trailAmount;
    const o = this.store(await this.api<AOrder>('PATCH', `/v2/orders/${id}`, body));
    this.emit('order', o);
    return o;
  }

  async cancelAll(): Promise<void> {
    await this.api('DELETE', '/v2/orders');
  }

  async closePosition(symbol: string): Promise<Order | undefined> {
    // Open orders on the symbol (e.g. a bracket's stop) would hold the shares, so they go first.
    for (const o of await this.getOrders('open')) {
      if (o.symbol === symbol) await this.api('DELETE', `/v2/orders/${o.id}`).catch(() => undefined);
    }
    try {
      const o = this.store(await this.api<AOrder>('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`));
      this.emit('order', o);
      return o;
    } catch (err) {
      if (/position does not exist|404/i.test((err as Error).message)) return undefined;
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    await this.api('DELETE', '/v2/positions?cancel_orders=true');
    await this.refresh();
    this.emit('account');
  }

  // ---------------------------------------------------------------- internals

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'APCA-API-KEY-ID': this.creds.keyId, 'APCA-API-SECRET-KEY': this.creds.secretKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* plain text */ }
      throw new BrokerError(`${res.status} ${msg}`, res.status === 404 ? 404 : 422);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async refresh(): Promise<void> {
    const [account, positions] = await Promise.all([this.api<AAccount>('GET', '/v2/account'), this.api<APosition[]>('GET', '/v2/positions')]);
    this.account = account;
    this.positions = positions;
  }

  private async loadFills(since: string): Promise<void> {
    let pageToken: string | undefined;
    const seen = new Set(this.fills.flatMap((f) => [f.id, this.fillKey(f)]));
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ after: since, direction: 'asc', page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const list = await this.api<AActivity[]>('GET', `/v2/account/activities/FILL?${qs}`);
      for (const a of list) {
        const f = this.makeFill(a.id, a.order_id, a.symbol, a.side.startsWith('sell') ? 'sell' : 'buy', Number(a.qty), Number(a.price), Date.parse(a.transaction_time));
        if (seen.has(a.id) || seen.has(this.fillKey(f))) continue;
        seen.add(a.id);
        seen.add(this.fillKey(f));
        this.fills.push(f);
      }
      if (list.length < 100) break;
      pageToken = list[list.length - 1].id;
    }
    this.fills.sort((a, b) => a.ts - b.ts);
  }

  /** The same execution reported by the stream and by the activity log. */
  private fillKey(f: Fill): string {
    return `${f.orderId}|${f.qty}|${f.price}|${Math.round(f.ts / 1000)}`;
  }

  private makeFill(id: string, orderId: string, symbol: string, side: Side, qty: number, price: number, ts: number): Fill {
    return { id, orderId, symbol, side, qty, price, commission: 0, fees: regulatoryFees(side, qty, qty * price, this.fees), ts };
  }

  /** Realized P&L per symbol for today (New York date), net of fees, by average cost, from the fills. */
  private realizedToday(): Map<string, number> {
    const today = nyDate(this.now());
    const pos = new Map<string, { qty: number; avg: number }>();
    const out = new Map<string, number>();
    for (const f of this.fills) {
      const p = pos.get(f.symbol) ?? { qty: 0, avg: 0 };
      const delta = f.side === 'buy' ? f.qty : -f.qty;
      let realized = 0;
      if (p.qty === 0 || Math.sign(p.qty) === Math.sign(delta)) {
        p.avg = (p.avg * Math.abs(p.qty) + f.price * f.qty) / (Math.abs(p.qty) + f.qty);
        p.qty += delta;
      } else {
        const closing = Math.min(Math.abs(delta), Math.abs(p.qty));
        realized = closing * (f.price - p.avg) * Math.sign(p.qty);
        p.qty += delta;
        if (Math.sign(p.qty) === Math.sign(delta) && p.qty !== 0) p.avg = f.price; // flipped through zero
        if (p.qty === 0) p.avg = 0;
      }
      pos.set(f.symbol, p);
      if (nyDate(f.ts) === today) out.set(f.symbol, (out.get(f.symbol) ?? 0) + realized - f.fees - f.commission);
    }
    return out;
  }

  private store(a: AOrder, parentId?: string): Order {
    const type = (a.order_type ?? a.type) as string;
    const order: Order = {
      id: a.id, clientOrderId: a.client_order_id, symbol: a.symbol, side: a.side, qty: num(a.qty) ?? 0,
      type: (type === 'trailing_stop' ? 'stop' : type) as OrderType,
      limitPrice: num(a.limit_price), stopPrice: num(a.stop_price), tif: a.time_in_force === 'gtc' ? 'gtc' : 'day',
      status: mapStatus(a.status), filledQty: num(a.filled_qty) ?? 0, avgFillPrice: num(a.filled_avg_price) ?? 0,
      createdAt: Date.parse(a.created_at), updatedAt: Date.parse(a.updated_at ?? a.created_at),
      parentId, legIds: a.legs?.length ? a.legs.map((l) => l.id) : undefined,
      trailAmount: num(a.trail_price), commission: 0,
    };
    const prev = this.orders.get(a.id);
    if (prev?.initialStopPrice !== undefined) order.initialStopPrice = prev.initialStopPrice;
    else if (parentId && order.stopPrice !== undefined && type !== 'limit') order.initialStopPrice = order.stopPrice;
    this.orders.set(a.id, order);
    for (const leg of a.legs ?? []) this.store(leg, a.id);
    return order;
  }

  private connect(): void {
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/stream`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: this.creds.keyId, secret: this.creds.secretKey }));
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: { stream?: string; data?: Record<string, unknown> };
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.stream === 'authorization' && (msg.data as { status?: string })?.status === 'authorized') {
        ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
      } else if (msg.stream === 'trade_updates' && msg.data) {
        this.onTradeUpdate(msg.data as { event: string; order: AOrder; price?: string; qty?: string; timestamp?: string; execution_id?: string });
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      setTimeout(() => {
        // Anything missed while disconnected is caught up from the REST activity log.
        void this.loadFills(new Date(this.now() - 86400_000).toISOString()).catch(() => undefined);
        this.connect();
      }, 3000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private onTradeUpdate(u: { event: string; order: AOrder; price?: string; qty?: string; timestamp?: string; execution_id?: string }): void {
    const order = this.store(u.order);
    if ((u.event === 'fill' || u.event === 'partial_fill') && u.price && u.qty) {
      const id = u.execution_id ?? `${u.order.id}-${u.timestamp}`;
      const fill = this.makeFill(id, u.order.id, u.order.symbol, u.order.side, Number(u.qty), Number(u.price), Date.parse(u.timestamp ?? new Date().toISOString()));
      if (!this.fills.some((f) => f.id === id || this.fillKey(f) === this.fillKey(fill))) {
        this.fills.push(fill);
        this.emit('fill', fill);
      }
      void this.refresh().then(() => this.emit('account')).catch(() => undefined);
    }
    this.emit('order', order);
  }
}
