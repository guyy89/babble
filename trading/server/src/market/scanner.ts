import type { MarketDataFeed } from './feed.js';
import type { SymbolDirectory } from './symbolDirectory.js';

export interface ScanRow {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  /** Today's open versus yesterday's close. */
  gapPct: number;
  volume: number;
  high: number;
  low: number;
}

export interface ScanFilter {
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  /** Minimum absolute % change today. */
  minChangePct?: number;
  /** Minimum absolute opening gap %. */
  minGapPct?: number;
  direction?: 'up' | 'down' | 'any';
  sort?: 'change' | 'gap' | 'volume';
}

const NOT_COMMON = /\b(warrants?|rights?|units?)\b/i;
const CACHE_MS = 60_000;

type ABar = { o: number; h: number; l: number; c: number; v: number };
type Snap = { latestTrade?: { p: number }; dailyBar?: ABar; prevDailyBar?: ABar };

/**
 * Scans the day's most active stocks (top 100 by volume and top 100 by trade count from Alpaca's
 * screener). Only those lists carry consolidated volume; the free IEX snapshot volume is a small
 * fraction of the market, so symbols without a consolidated figure are left out rather than mixed in.
 */
export function alpacaScanner(
  creds: { keyId: string; secretKey: string },
  directory: SymbolDirectory,
  snapshots: (symbols: string[]) => Promise<Record<string, Snap>>,
) {
  const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Alpaca screener: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  let cache: { at: number; rows: ScanRow[] } | undefined;

  const universe = async (): Promise<ScanRow[]> => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const [byVolume, byTrades] = await Promise.all([
      get<{ most_actives: { symbol: string; volume: number }[] }>('https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=100'),
      get<{ most_actives: { symbol: string; volume: number }[] }>('https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=trades&top=100'),
    ]);
    const volume = new Map<string, number>();
    for (const a of [...byVolume.most_actives, ...byTrades.most_actives]) volume.set(a.symbol, Math.max(volume.get(a.symbol) ?? 0, a.volume));
    const symbols = [...volume.keys()]
      .filter((s) => {
        const info = directory.get(s);
        return info && !NOT_COMMON.test(info.name);
      });
    const snaps = await snapshots(symbols);
    const rows = symbols.flatMap((symbol): ScanRow[] => {
      const s = snaps[symbol];
      const day = s?.dailyBar;
      const prev = s?.prevDailyBar?.c;
      const price = s?.latestTrade?.p ?? day?.c;
      if (!day || !prev || !price) return [];
      return [{
        symbol, name: directory.get(symbol)!.name, price,
        changePct: ((price - prev) / prev) * 100, gapPct: ((day.o - prev) / prev) * 100,
        volume: volume.get(symbol)!, high: day.h, low: day.l,
      }];
    });
    cache = { at: Date.now(), rows };
    return rows;
  };

  return async (f: ScanFilter) => applyFilter(await universe(), f);
}

/** Simulated market: scan whatever the synthetic feed is streaming. */
export function simScanner(feed: MarketDataFeed, directory: SymbolDirectory) {
  return async (f: ScanFilter) => {
    const rows = await Promise.all(feed.symbols().map(async (symbol): Promise<ScanRow[]> => {
      const daily = await feed.dailyBars(symbol);
      const q = feed.getQuote(symbol);
      const day = daily.at(-1);
      const prev = daily.at(-2)?.c;
      if (!day || !prev || !q) return [];
      return [{
        symbol, name: directory.get(symbol)?.name ?? symbol, price: q.last,
        changePct: ((q.last - prev) / prev) * 100, gapPct: ((day.o - prev) / prev) * 100, volume: day.v, high: day.h, low: day.l,
      }];
    }));
    return applyFilter(rows.flat(), f);
  };
}

export function applyFilter(rows: ScanRow[], f: ScanFilter): ScanRow[] {
  const dir = f.direction ?? 'any';
  const signOk = (x: number) => (dir === 'up' ? x > 0 : dir === 'down' ? x < 0 : true);
  const out = rows.filter((r) =>
    (f.minPrice === undefined || r.price >= f.minPrice) &&
    (f.maxPrice === undefined || r.price <= f.maxPrice) &&
    (f.minVolume === undefined || r.volume >= f.minVolume) &&
    (f.minChangePct === undefined || Math.abs(r.changePct) >= f.minChangePct) &&
    (f.minGapPct === undefined || Math.abs(r.gapPct) >= f.minGapPct) &&
    signOk(f.sort === 'gap' ? r.gapPct : r.changePct),
  );
  const key = f.sort === 'gap' ? (r: ScanRow) => Math.abs(r.gapPct) : f.sort === 'volume' ? (r: ScanRow) => r.volume : (r: ScanRow) => Math.abs(r.changePct);
  return out.sort((a, b) => key(b) - key(a)).slice(0, 50);
}
