import type { Bar, NewsItem } from '../types.js';
import { BaseFeed } from './feed.js';

// Real-time US equities data from Alpaca's market data API (free tier = IEX feed).
// Docs: https://docs.alpaca.markets/docs/real-time-stock-pricing-data

interface AlpacaCreds {
  keyId: string;
  secretKey: string;
  feed: string; // 'iex' (free) or 'sip' (paid)
}

const REST = 'https://data.alpaca.markets/v2';
/** During market hours, no quote or trade for this long means the stream is dead. */
const STALE_MS = 90_000;

export class AlpacaFeed extends BaseFeed {
  readonly name = 'alpaca';
  private ws?: WebSocket;
  private stopped = false;
  private reconnectDelay = 1000;
  private lastData = Date.now();
  private watchdog?: NodeJS.Timeout;
  private resubscribes = 0;
  private confirmed = new Set<string>();
  private confirmTimer?: NodeJS.Timeout;

  /**
   * marketOpen: while it returns true, a stream that delivers no quote or trade for STALE_MS is treated
   * as dead and replaced, because a half-open connection never fires 'close' (seen live on 2026-10-19:
   * prices froze for six hours). Emits 'reconnect' (message) when that happens.
   */
  constructor(symbols: string[], private readonly creds: AlpacaCreds, private readonly marketOpen: () => boolean = () => false) {
    super(symbols);
    if (!creds.keyId || !creds.secretKey) {
      throw new Error('DATA_SOURCE=alpaca requires ALPACA_KEY_ID and ALPACA_SECRET_KEY');
    }
  }

  private headers() {
    return { 'APCA-API-KEY-ID': this.creds.keyId, 'APCA-API-SECRET-KEY': this.creds.secretKey };
  }

  async start(): Promise<void> {
    await Promise.all(this.symbolList.map((s) => this.loadHistory(s)));
    await this.loadSnapshots(this.symbolList);
    this.connect();
    this.watchdog = setInterval(() => void this.checkStale(), 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.ws?.close();
  }

  private checkConfirmed(): void {
    const missing = this.symbolList.filter((s) => !this.confirmed.has(s));
    if (!missing.length) return;
    if (this.resubscribes < 2) {
      this.resubscribes++;
      this.emit('notice', `אלפקה לא שולחת מחירים עבור ${missing.join(', ')}. נרשם אליהן שוב`);
      this.sendIfOpen(JSON.stringify({ action: 'subscribe', quotes: missing, trades: missing }));
    } else {
      this.emit('notice', `אלפקה לא שולחת מחירים עבור ${missing.join(', ')} (ייתכן שהגענו לתקרת המניות בחשבון החינמי). כדאי להסיר מניות מרשימת המעקב`);
    }
  }

  private async checkStale(): Promise<void> {
    if (this.stopped || !this.symbolList.length || !this.marketOpen()) return;
    const silentMs = Date.now() - this.lastData;
    if (silentMs < STALE_MS) return;
    const msg = `לא הגיעו מחירים חיים ${Math.round(silentMs / 1000)} שניות. מתחבר מחדש לאלפקה`;
    console.warn(`[alpaca] no data for ${Math.round(silentMs / 1000)}s, replacing the stream`);
    this.emit('reconnect', msg);
    this.lastData = Date.now(); // give the new connection a full window before trying again
    const old = this.ws;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      try { old.close(); } catch { /* already dead */ }
    }
    this.connect();
    try {
      await this.loadSnapshots(this.symbolList); // bring every price up to date right away
    } catch (err) {
      console.error('[alpaca] snapshot refresh failed', err);
    }
  }

  private async loadHistory(symbol: string): Promise<void> {
    const start = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();
    const url = `${REST}/stocks/${symbol}/bars?timeframe=1Min&limit=1000&sort=desc&feed=${this.creds.feed}&start=${start}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Alpaca bars ${symbol}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> | null };
    const bars: Bar[] = (body.bars ?? [])
      .map((b) => ({ symbol, t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      .reverse();
    this.seedBars(symbol, bars);
  }

  private daily = new Map<string, { at: number; bars: Bar[] }>();

  /** About 15 months of daily bars from the REST API, cached for a minute (today's bar keeps moving). */
  async dailyBars(symbol: string): Promise<Bar[]> {
    const hit = this.daily.get(symbol);
    if (hit && Date.now() - hit.at < 60_000) return hit.bars;
    const start = new Date(Date.now() - 460 * 24 * 3600_000).toISOString().slice(0, 10);
    const url = `${REST}/stocks/${symbol}/bars?timeframe=1Day&limit=1000&adjustment=split&feed=${this.creds.feed}&start=${start}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Alpaca daily bars ${symbol}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> | null };
    const bars = (body.bars ?? []).map((b) => ({ symbol, t: Date.parse(b.t.slice(0, 10) + 'T00:00:00Z'), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    this.daily.set(symbol, { at: Date.now(), bars });
    return bars;
  }

  /** Latest news headlines for a symbol (Benzinga via Alpaca, included in the free plan). */
  async news(symbol: string): Promise<NewsItem[]> {
    const res = await fetch(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(symbol)}&limit=20`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Alpaca news ${symbol}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { news: Array<{ id: number; headline: string; summary: string; source: string; url: string; created_at: string; symbols: string[] }> };
    return body.news.map((n) => ({ id: n.id, headline: n.headline, summary: n.summary, source: n.source, url: n.url, ts: Date.parse(n.created_at), symbols: n.symbols }));
  }

  /** Snapshots for many symbols (chunked); used by the scanner. */
  async snapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const out: Record<string, Snapshot> = {};
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const res = await fetch(`${REST}/stocks/snapshots?symbols=${chunk.join(',')}&feed=${this.creds.feed}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`Alpaca snapshots: ${res.status} ${await res.text()}`);
      Object.assign(out, await res.json());
    }
    return out;
  }

  protected async onAdd(symbol: string): Promise<void> {
    await this.loadHistory(symbol);
    await this.loadSnapshots([symbol]);
    this.sendIfOpen(JSON.stringify({ action: 'subscribe', quotes: [symbol], trades: [symbol] }));
  }

  protected onRemove(symbol: string): void {
    this.sendIfOpen(JSON.stringify({ action: 'unsubscribe', quotes: [symbol], trades: [symbol] }));
  }

  /** Before the stream is authenticated, the subscribe-on-auth handler covers newly added symbols. */
  private sendIfOpen(msg: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
  }

  private async loadSnapshots(symbols: string[]): Promise<void> {
    if (!symbols.length) return;
    const url = `${REST}/stocks/snapshots?symbols=${symbols.join(',')}&feed=${this.creds.feed}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Alpaca snapshots: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Record<string, { latestQuote?: AQuote; latestTrade?: { p: number } }>;
    for (const [symbol, snap] of Object.entries(body)) {
      const q = snap.latestQuote;
      if (!q) continue;
      this.publishQuote({
        symbol, bid: q.bp, ask: q.ap, bidSize: q.bs, askSize: q.as,
        last: snap.latestTrade?.p ?? (q.bp + q.ap) / 2, ts: Date.parse(q.t),
      });
    }
  }

  private connect(): void {
    const ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${this.creds.feed}`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'auth', key: this.creds.keyId, secret: this.creds.secretKey }));
    };
    ws.onmessage = (ev) => {
      const msgs = JSON.parse(String(ev.data)) as AlpacaMsg[];
      for (const m of msgs) this.handle(m);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      console.warn(`[alpaca] stream closed, reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    };
    ws.onerror = (e) => console.error('[alpaca] stream error', (e as ErrorEvent).message ?? e);
  }

  private handle(m: AlpacaMsg): void {
    switch (m.T) {
      case 'success':
        if (m.msg === 'authenticated') {
          this.reconnectDelay = 1000;
          this.lastData = Date.now();
          this.resubscribes = 0;
          if (this.symbolList.length) this.ws?.send(JSON.stringify({ action: 'subscribe', quotes: this.symbolList, trades: this.symbolList }));
        }
        break;
      case 'error':
        console.error(`[alpaca] ${m.code}: ${m.msg}`);
        this.emit('notice', `שגיאה מאלפקה (${m.code}): ${m.msg}`);
        break;
      case 'subscription':
        // Alpaca confirms the full list it is actually streaming; anything missing gets no prices
        // (e.g. 405 "symbol limit exceeded" on the free plan). Checked once things settle, since a
        // burst of subscribe/unsubscribe messages produces a confirmation for each.
        this.confirmed = new Set(m.quotes ?? []);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.confirmTimer = setTimeout(() => this.checkConfirmed(), 3000);
        break;
      case 'q':
        this.lastData = Date.now();
        if (m.bp > 0 && m.ap > 0) {
          this.publishQuote({ symbol: m.S, bid: m.bp, ask: m.ap, bidSize: m.bs, askSize: m.as, last: 0, ts: Date.parse(m.t) });
        }
        break;
      case 't':
        this.lastData = Date.now();
        this.publishTrade({ symbol: m.S, price: m.p, size: m.s, ts: Date.parse(m.t) });
        break;
    }
  }
}

interface AQuote { bp: number; ap: number; bs: number; as: number; t: string }
type ABar = { t?: string; o: number; h: number; l: number; c: number; v: number };
export interface Snapshot { latestTrade?: { p: number }; dailyBar?: ABar; prevDailyBar?: ABar }
type AlpacaMsg =
  | { T: 'success'; msg: string }
  | { T: 'error'; code: number; msg: string }
  | ({ T: 'q'; S: string } & AQuote)
  | { T: 't'; S: string; p: number; s: number; t: string }
  | { T: 'subscription'; quotes?: string[]; trades?: string[] };
