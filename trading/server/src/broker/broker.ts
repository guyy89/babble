import type { EventEmitter } from 'node:events';
import type { Account, Fill, Order, OrderRequest, Position } from '../types.js';

/**
 * A broker executes orders and owns account state. Everything above this interface
 * (risk checks, API, UI) is broker-agnostic, so moving from the paper simulator to a
 * live broker is a matter of adding another implementation.
 *
 * Events: 'order' (Order), 'fill' (Fill), 'account' (void — state changed)
 */
export interface Broker extends EventEmitter {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getOrders(scope?: 'open' | 'all'): Promise<Order[]>;
  getFills(): Promise<Fill[]>;
  /** Resolves with the order even when it was rejected — check order.status. */
  submitOrder(req: OrderRequest): Promise<Order>;
  cancelOrder(id: string): Promise<Order>;
  modifyOrder(id: string, changes: OrderChanges): Promise<Order>;
  cancelAll(): Promise<void>;
  closePosition(symbol: string): Promise<Order | undefined>;
  closeAll(): Promise<void>;
}

/** Price changes for a working order. trailAmount: null removes trailing. */
export interface OrderChanges {
  limitPrice?: number;
  stopPrice?: number;
  trailAmount?: number | null;
}

export class BrokerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
