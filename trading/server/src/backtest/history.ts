import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Bar } from '../types.js';

// Historical bars from Alpaca's market data API, cached on disk so re-runs are fast and free.

const REST = 'https://data.alpaca.markets/v2';

type ABar = { t: string; o: number; h: number; l: number; c: number; v: number };

export class AlpacaHistory {
  constructor(
    private readonly creds: { keyId: string; secretKey: string; feed: string },
    private readonly cacheDir: string,
  ) {}

  private async get<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': this.creds.keyId, 'APCA-API-SECRET-KEY': this.creds.secretKey } });
      if (res.status === 429 && attempt < 8) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // free plan: 200 requests/minute
        continue;
      }
      if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    }
  }

  private cached<T>(name: string, load: () => Promise<T>): Promise<T> {
    const file = resolve(this.cacheDir, name);
    if (existsSync(file)) return Promise.resolve(JSON.parse(readFileSync(file, 'utf8')) as T);
    return load().then((v) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(v));
      return v;
    });
  }

  /** Multi-symbol bars with pagination. */
  private async bars(symbols: string[], timeframe: string, start: string, endArg: string): Promise<Record<string, Bar[]>> {
    // A date-only end means the whole day; free plans may not query the last 15 minutes of consolidated
    // (SIP) data, so cap the end at 20 minutes ago.
    const endMs = Math.min(/T/.test(endArg) ? Date.parse(endArg) : Date.parse(`${endArg}T23:59:59Z`), Date.now() - 20 * 60_000);
    const end = new Date(endMs).toISOString();
    const out: Record<string, Bar[]> = {};
    let token: string | undefined;
    do {
      const qs = new URLSearchParams({
        symbols: symbols.join(','), timeframe, start, end, limit: '10000', feed: this.creds.feed, adjustment: 'split',
        ...(token ? { page_token: token } : {}),
      });
      const body = await this.get<{ bars: Record<string, ABar[]>; next_page_token: string | null }>(`${REST}/stocks/bars?${qs}`);
      for (const [s, list] of Object.entries(body.bars ?? {})) {
        (out[s] ??= []).push(...list.map((b) => ({ symbol: s, t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      }
      token = body.next_page_token ?? undefined;
    } while (token);
    return out;
  }

  /** Daily bars without the disk cache (the cache is keyed by symbol count, not by the symbol set). */
  async dailyUncached(symbols: string[], start: string, end: string): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    for (let i = 0; i < symbols.length; i += 200) Object.assign(out, await this.bars(symbols.slice(i, i + 200), '1Day', start, end));
    return out;
  }

  /** Daily bars for many symbols (chunked), cached per date range. A cached wider range is reused. */
  async daily(symbols: string[], start: string, end: string, onProgress?: (done: number, total: number) => void) {
    const covering = this.coveringDaily(symbols.length, start, end);
    if (covering) return covering;
    return this.cached(`daily-${this.creds.feed}-${start}-${end}-${symbols.length}.json`, async () => {
      const out: Record<string, Bar[]> = {};
      const chunk = 200;
      for (let i = 0; i < symbols.length; i += chunk) {
        Object.assign(out, await this.bars(symbols.slice(i, i + chunk), '1Day', start, end));
        onProgress?.(Math.min(i + chunk, symbols.length), symbols.length);
      }
      return out;
    });
  }

  /** An already-downloaded daily file for the same universe whose range contains [start, end], trimmed to it. */
  private coveringDaily(count: number, start: string, end: string): Record<string, Bar[]> | undefined {
    if (!existsSync(this.cacheDir)) return undefined;
    const re = new RegExp(`^daily-${this.creds.feed}-(\\d{4}-\\d{2}-\\d{2})-(\\d{4}-\\d{2}-\\d{2})-${count}\\.json$`);
    for (const f of readdirSync(this.cacheDir)) {
      const m = re.exec(f);
      if (!m || m[1] > start || m[2] < end) continue;
      const all = JSON.parse(readFileSync(resolve(this.cacheDir, f), 'utf8')) as Record<string, Bar[]>;
      const day = (t: number) => new Date(t).toISOString().slice(0, 10);
      return Object.fromEntries(Object.entries(all).map(([s, bars]) => [s, bars.filter((b) => day(b.t) >= start && day(b.t) <= end)]));
    }
    return undefined;
  }

  /** 1-minute bars for many symbols over a time window, uncached (the research dataset stores its own). */
  minutesRange(symbols: string[], start: string, end: string) {
    return this.bars(symbols, '1Min', start, end);
  }

  /** 1-minute bars for a few symbols on one New York date (pre- and post-market included). */
  async minutes(symbols: string[], date: string) {
    const key = [...symbols].sort().join('_');
    return this.cached(`min-${this.creds.feed}-${date}-${key}.json`, () =>
      this.bars(symbols, '1Min', `${date}T08:00:00Z`, `${date}T23:59:00Z`),
    );
  }
}
