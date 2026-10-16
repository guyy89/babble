// Shared domain types. These mirror the shapes used by real broker APIs (Alpaca in particular)
// so that swapping the paper broker for a live one does not ripple through the codebase.

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type TimeInForce = 'day' | 'gtc';
export type OrderStatus =
  | 'new' // accepted, waiting
  | 'held' // bracket child waiting for parent to fill
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  ts: number;
}

export interface Trade {
  symbol: string;
  price: number;
  size: number;
  ts: number;
}

export interface Bar {
  symbol: string;
  t: number; // bar start, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tif?: TimeInForce;
  /** Bracket legs. Activated once the entry order fills. */
  takeProfit?: { limitPrice: number };
  stopLoss?: { stopPrice: number };
  clientOrderId?: string;
}

export interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  ts: number;
  symbols: string[];
}

export interface Order {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  tif: TimeInForce;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  /** Broker commission charged so far (the per-order minimum is applied once per order). */
  commission?: number;
  createdAt: number;
  updatedAt: number;
  rejectReason?: string;
  /** Set once a stop / stop_limit order has been triggered. */
  triggered?: boolean;
  /** For bracket children: the entry order id. */
  parentId?: string;
  /** For bracket entries: the child order ids (take-profit, stop-loss). */
  legIds?: string[];
  /** Orders sharing an ocoGroup cancel each other when one fills. */
  ocoGroup?: string;
  /** Trailing stop: the stop follows the market at this distance (in $) and never moves back. */
  trailAmount?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  commission: number;
  /** Regulatory transaction fees (SEC Section 31 + FINRA TAF), charged on sales only. */
  fees: number;
  ts: number;
}

export interface Position {
  symbol: string;
  qty: number; // signed: negative = short
  avgPrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
}

export interface Account {
  mode: string;
  accountType: 'cash' | 'margin';
  marginModel: 'intraday' | 'pdt';
  cash: number;
  equity: number;
  longMarketValue: number;
  shortMarketValue: number;
  buyingPower: number;
  /** Equity the current positions require to be held. */
  maintenanceRequirement: number;
  /** Equity below the maintenance requirement: only reducing orders are accepted. */
  marginCall: boolean;
  dayStartEquity: number;
  dayPnl: number;
  realizedPnlToday: number;
  /** Commissions plus regulatory fees paid today. */
  commissionsToday: number;
  dayTradeCount: number; // rolling 5 business days
  /** Only meaningful under the legacy 'pdt' margin model. */
  patternDayTrader: boolean;
  tradingBlocked: boolean;
  blockReason?: string;
}

export interface ServerEvent {
  type: 'quote' | 'bar' | 'trade' | 'order' | 'fill' | 'account' | 'positions' | 'clock' | 'notice' | 'symbols';
  data: unknown;
}
