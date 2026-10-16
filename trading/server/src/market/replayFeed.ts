import type { Bar } from '../types.js';
import { BaseFeed } from './feed.js';

/** Virtual time for replays: starts at a given instant and runs at `speed`× real time (or is stepped manually). */
export class VirtualClock {
  private base: number;
  private realStart = Date.now();
  constructor(start: number, private speed = 1) {
    this.base = start;
  }
  now = (): number => (this.speed > 0 ? this.base + (Date.now() - this.realStart) * this.speed : this.base);
  /** Manual stepping (speed 0). */
  set(t: number): void {
    this.base = t;
    this.realStart = Date.now();
  }
}

interface Tick {
  t: number;
  price: number;
  size: number;
}

/**
 * Replays a recorded trading day from 1-minute bars as if it were live. Each minute becomes four
 * prints — open, then the low and high (in the order that matches the candle's direction), then
 * the close — with a one-cent quote around each. Bars before the replay time are history.
 */
export class ReplayFeed extends BaseFeed {
  readonly name = 'replay';
  private ticks = new Map<string, Tick[]>();
  private cursor = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    symbols: string[],
    readonly date: string,
    readonly clock: VirtualClock,
    private readonly load: (symbols: string[]) => Promise<Record<string, Bar[]>>,
    private readonly realtime: boolean,
  ) {
    super(symbols);
  }

  async start(): Promise<void> {
    await this.prepare(this.symbolList);
    if (this.realtime) this.timer = setInterval(() => this.pump(), 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  protected async onAdd(symbol: string): Promise<void> {
    await this.prepare([symbol]);
  }

  protected onRemove(symbol: string): void {
    this.ticks.delete(symbol);
    this.cursor.delete(symbol);
  }

  private async prepare(symbols: string[]): Promise<void> {
    if (!symbols.length) return;
    const data = await this.load(symbols);
    const now = this.clock.now();
    for (const s of symbols) {
      const bars = (data[s] ?? []).sort((a, b) => a.t - b.t);
      this.seedBars(s, bars.filter((b) => b.t + 60_000 <= now));
      const ticks: Tick[] = [];
      for (const b of bars.filter((x) => x.t + 60_000 > now)) {
        const path = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
        const size = Math.max(1, Math.round(b.v / 4));
        path.forEach((price, i) => ticks.push({ t: b.t + i * 15_000, price, size }));
      }
      this.ticks.set(s, ticks);
      this.cursor.set(s, 0);
      const last = bars.filter((b) => b.t + 60_000 <= now).at(-1);
      if (last) this.quoteAt(s, last.c, last.t + 59_000);
    }
  }

  /** Publish every recorded print up to the virtual clock. */
  pump(): void {
    const now = this.clock.now();
    for (const [s, ticks] of this.ticks) {
      let i = this.cursor.get(s) ?? 0;
      while (i < ticks.length && ticks[i].t <= now) {
        const k = ticks[i++];
        this.quoteAt(s, k.price, k.t);
        this.publishTrade({ symbol: s, price: k.price, size: k.size, ts: k.t });
      }
      this.cursor.set(s, i);
    }
  }

  private quoteAt(symbol: string, price: number, ts: number): void {
    const tick = price >= 1 ? 0.01 : 0.0001;
    const bid = Math.round((price - tick / 2) / tick) * tick;
    this.publishQuote({ symbol, bid: Number(bid.toFixed(4)), ask: Number((bid + tick).toFixed(4)), bidSize: 1000, askSize: 1000, last: price, ts });
  }

  /** True when every symbol has replayed all of its recorded prints. */
  finished(): boolean {
    return [...this.ticks].every(([s, t]) => (this.cursor.get(s) ?? 0) >= t.length);
  }
}
