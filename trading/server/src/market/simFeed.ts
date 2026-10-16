import type { Bar } from '../types.js';
import { BaseFeed } from './feed.js';

// Synthetic market: each symbol follows a geometric random walk with
// volatility clustering, a spread that widens when volatility spikes, and
// displayed sizes that vary per quote. Good enough to exercise every order path.

export const BASE_PRICES: Record<string, number> = {
  AAPL: 228, MSFT: 432, NVDA: 182, TSLA: 251, AMD: 162, SPY: 571, QQQ: 492, META: 590, AMZN: 188, GOOGL: 166,
};

interface SymState {
  price: number;
  vol: number; // per-tick stdev of log return
  baseVol: number;
}

const TICK_MS = 250;

export class SimFeed extends BaseFeed {
  readonly name = 'sim';
  private timer?: NodeJS.Timeout;
  private state = new Map<string, SymState>();

  constructor(symbols: string[], private readonly rng: () => number = Math.random) {
    super(symbols);
    for (const s of this.symbolList) this.initState(s);
  }

  private initState(s: string): void {
    const price = BASE_PRICES[s] ?? 20 + this.rng() * 180;
    // ~2% daily vol spread over a session of 250ms ticks
    const baseVol = 0.02 / Math.sqrt((6.5 * 3600 * 1000) / TICK_MS);
    this.state.set(s, { price, vol: baseVol, baseVol });
  }

  protected async onAdd(symbol: string): Promise<void> {
    this.initState(symbol);
    const now = Date.now();
    this.seedBars(symbol, this.generateHistory(symbol, now, 390));
    this.step(symbol, now);
  }

  protected onRemove(symbol: string): void {
    this.state.delete(symbol);
  }

  async start(): Promise<void> {
    const now = Date.now();
    for (const s of this.symbolList) {
      this.seedBars(s, this.generateHistory(s, now, 390));
      this.step(s, now);
    }
    this.timer = setInterval(() => {
      const ts = Date.now();
      for (const s of this.symbolList) this.step(s, ts);
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private gaussian(): number {
    const u = 1 - this.rng();
    const v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private nextPrice(st: SymState, scale = 1): number {
    // Mean-reverting volatility with occasional shocks.
    st.vol = st.vol + 0.02 * (st.baseVol - st.vol) + (this.rng() < 0.002 ? st.baseVol * 3 : 0);
    st.price = st.price * Math.exp(st.vol * Math.sqrt(scale) * this.gaussian());
    return st.price;
  }

  private generateHistory(symbol: string, now: number, minutes: number): Bar[] {
    const st = this.state.get(symbol)!;
    const ticksPerMinute = 60_000 / TICK_MS;
    const start = Math.floor(now / 60_000) * 60_000 - minutes * 60_000;
    const bars: Bar[] = [];
    const endPrice = st.price;
    for (let i = 0; i < minutes; i++) {
      const o = st.price;
      let h = o, l = o, c = o;
      // 12 sub-steps per minute keeps it cheap while producing realistic wicks
      for (let k = 0; k < 12; k++) {
        c = this.nextPrice(st, ticksPerMinute / 12);
        h = Math.max(h, c);
        l = Math.min(l, c);
      }
      bars.push({ symbol, t: start + i * 60_000, o, h, l, c, v: Math.round(2000 + this.rng() * 20000) });
    }
    // Rescale so the last close matches the configured starting price.
    const k = endPrice / st.price;
    for (const b of bars) {
      b.o = round2(b.o * k); b.h = round2(b.h * k); b.l = round2(b.l * k); b.c = round2(b.c * k);
    }
    st.price = endPrice;
    return bars;
  }

  private step(symbol: string, ts: number): void {
    const st = this.state.get(symbol)!;
    const mid = this.nextPrice(st);
    const tick = mid >= 1 ? 0.01 : 0.0001;
    const spreadTicks = Math.max(1, Math.round((st.vol / st.baseVol) * (1 + this.rng() * 2)));
    const half = (spreadTicks * tick) / 2;
    const bid = roundTo(mid - half, tick);
    const ask = Math.max(roundTo(mid + half, tick), roundTo(bid + tick, tick));
    const size = () => (1 + Math.floor(this.rng() * 8)) * 100;
    this.publishQuote({ symbol, bid, ask, bidSize: size(), askSize: size(), last: 0, ts });
    // Roughly a third of quote updates come with a print.
    if (this.rng() < 0.35) {
      const price = this.rng() < 0.5 ? bid : ask;
      this.publishTrade({ symbol, price, size: (1 + Math.floor(this.rng() * 5)) * 100, ts });
    }
  }
}

function roundTo(x: number, tick: number): number {
  return Number((Math.round(x / tick) * tick).toFixed(4));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
