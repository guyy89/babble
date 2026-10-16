import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  private async bars(symbols: string[], timeframe: string, start: string, end: string): Promise<Record<string, Bar[]>> {
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

  /** Daily bars for many symbols (chunked), cached per date range. */
  async daily(symbols: string[], start: string, end: string, onProgress?: (done: number, total: number) => void) {
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

  /** 1-minute bars for a few symbols on one New York date (pre- and post-market included). */
  async minutes(symbols: string[], date: string) {
    const key = [...symbols].sort().join('_');
    return this.cached(`min-${this.creds.feed}-${date}-${key}.json`, () =>
      this.bars(symbols, '1Min', `${date}T08:00:00Z`, `${date}T23:59:00Z`),
    );
  }
}
