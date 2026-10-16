import { EventEmitter } from 'node:events';
import type { Bar, Quote, Trade } from '../types.js';

export interface MarketDataFeed extends EventEmitter {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  symbols(): string[];
  /** Start streaming a symbol (loads its history first). No-op if already subscribed. */
  addSymbol(symbol: string): Promise<void>;
  removeSymbol(symbol: string): void;
  getQuote(symbol: string): Quote | undefined;
  getBars(symbol: string): Bar[];
  // Events: 'quote' (Quote), 'trade' (Trade), 'bar' (Bar — emitted on every update of the current bar)
}

const MINUTE = 60_000;
const MAX_BARS = 2000;

/** Shared quote/trade cache plus 1-minute bar aggregation. */
export abstract class BaseFeed extends EventEmitter implements MarketDataFeed {
  abstract readonly name: string;
  protected quotes = new Map<string, Quote>();
  protected bars = new Map<string, Bar[]>();

  protected symbolList: string[];

  constructor(symbols: string[]) {
    super();
    this.symbolList = [...new Set(symbols)];
    for (const s of this.symbolList) this.bars.set(s, []);
  }

  abstract start(): Promise<void>;
  abstract stop(): void;

  symbols(): string[] {
    return [...this.symbolList];
  }

  async addSymbol(symbol: string): Promise<void> {
    if (this.symbolList.includes(symbol)) return;
    this.symbolList.push(symbol);
    this.bars.set(symbol, []);
    try {
      await this.onAdd(symbol);
    } catch (err) {
      this.removeSymbol(symbol);
      throw err;
    }
  }

  removeSymbol(symbol: string): void {
    if (!this.symbolList.includes(symbol)) return;
    this.symbolList = this.symbolList.filter((s) => s !== symbol);
    this.bars.delete(symbol);
    this.quotes.delete(symbol);
    this.onRemove(symbol);
  }

  /** Feed-specific subscribe/unsubscribe hooks for symbols added after start(). */
  protected async onAdd(_symbol: string): Promise<void> {}
  protected onRemove(_symbol: string): void {}

  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  getBars(symbol: string): Bar[] {
    return this.bars.get(symbol) ?? [];
  }

  protected seedBars(symbol: string, history: Bar[]): void {
    this.bars.set(symbol, history.slice(-MAX_BARS));
  }

  protected publishQuote(q: Quote): void {
    const prev = this.quotes.get(q.symbol);
    if (!q.last) q.last = prev?.last ?? (q.bid + q.ask) / 2;
    this.quotes.set(q.symbol, q);
    this.emit('quote', q);
  }

  protected publishTrade(t: Trade): void {
    const q = this.quotes.get(t.symbol);
    if (q) q.last = t.price;
    this.emit('trade', t);
    this.updateBar(t.symbol, t.price, t.size, t.ts);
  }

  private updateBar(symbol: string, price: number, size: number, ts: number): void {
    const list = this.bars.get(symbol);
    if (!list) return;
    const t = Math.floor(ts / MINUTE) * MINUTE;
    let bar = list[list.length - 1];
    if (!bar || bar.t < t) {
      bar = { symbol, t, o: price, h: price, l: price, c: price, v: 0 };
      list.push(bar);
      if (list.length > MAX_BARS) list.shift();
    } else if (bar.t > t) {
      return; // out-of-order print for an old minute; ignore
    }
    bar.h = Math.max(bar.h, price);
    bar.l = Math.min(bar.l, price);
    bar.c = price;
    bar.v += size;
    this.emit('bar', { ...bar });
  }
}
