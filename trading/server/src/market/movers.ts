import type { MarketDataFeed } from './feed.js';
import type { SymbolDirectory } from './symbolDirectory.js';

export interface Mover {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  volume?: number;
}

export interface Movers {
  gainers: Mover[];
  losers: Mover[];
  actives: Mover[];
  updatedAt: number;
}

const TOP = 10;
const CACHE_MS = 60_000;
// Warrants, rights and units dominate the raw gainers list but aren't what a day trader is looking for.
const NOT_COMMON = /\b(warrants?|rights?|units?)\b/i;
const MIN_PRICE = 1;

/** Today's top gainers, losers and most active stocks from Alpaca's screener, filtered to listed common stock. */
export function alpacaMovers(creds: { keyId: string; secretKey: string; feed: string }, directory: SymbolDirectory) {
  const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Alpaca screener: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const listed = (symbol: string) => {
    const info = directory.get(symbol);
    return info && !NOT_COMMON.test(info.name) ? info : undefined;
  };

  let cache: Movers | undefined;
  return async (): Promise<Movers> => {
    if (cache && Date.now() - cache.updatedAt < CACHE_MS) return cache;

    type Row = { symbol: string; price: number; percent_change: number };
    const [movers, actives] = await Promise.all([
      get<{ gainers: Row[]; losers: Row[] }>('https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50'),
      get<{ most_actives: { symbol: string; volume: number }[] }>(
        'https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=50',
      ),
    ]);
    const toMover = (r: Row): Mover | undefined => {
      const info = listed(r.symbol);
      return info && r.price >= MIN_PRICE ? { symbol: r.symbol, name: info.name, price: r.price, changePct: r.percent_change } : undefined;
    };

    // Most-actives only carries volume; price and change come from one snapshot request.
    const activeRows = actives.most_actives.filter((a) => listed(a.symbol));
    type Snap = { latestTrade?: { p: number }; dailyBar?: { c: number }; prevDailyBar?: { c: number } };
    const snaps = activeRows.length
      ? await get<Record<string, Snap>>(
          `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${activeRows.map((a) => a.symbol).join(',')}&feed=${creds.feed}`,
        )
      : {};
    const activeMovers = activeRows.flatMap((a): Mover[] => {
      const s = snaps[a.symbol];
      const price = s?.latestTrade?.p ?? s?.dailyBar?.c;
      const prev = s?.prevDailyBar?.c;
      if (!price || price < MIN_PRICE) return [];
      return [{ symbol: a.symbol, name: listed(a.symbol)!.name, price, changePct: prev ? ((price - prev) / prev) * 100 : 0, volume: a.volume }];
    });

    cache = {
      gainers: movers.gainers.map(toMover).filter((m): m is Mover => !!m).slice(0, TOP),
      losers: movers.losers.map(toMover).filter((m): m is Mover => !!m).slice(0, TOP),
      actives: activeMovers.slice(0, TOP),
      updatedAt: Date.now(),
    };
    return cache;
  };
}

/** Simulated market: rank the streamed symbols by their move over the generated session. */
export function simMovers(feed: MarketDataFeed, directory: SymbolDirectory) {
  return async (): Promise<Movers> => {
    const rows = feed.symbols().flatMap((symbol): Mover[] => {
      const bars = feed.getBars(symbol);
      const q = feed.getQuote(symbol);
      if (!bars.length || !q) return [];
      const changePct = ((q.last - bars[0].o) / bars[0].o) * 100;
      const volume = bars.reduce((v, b) => v + b.v, 0);
      return [{ symbol, name: directory.get(symbol)?.name ?? symbol, price: q.last, changePct, volume }];
    });
    const by = (f: (m: Mover) => number) => [...rows].sort((a, b) => f(b) - f(a)).slice(0, TOP);
    return {
      gainers: by((m) => m.changePct).filter((m) => m.changePct > 0),
      losers: by((m) => -m.changePct).filter((m) => m.changePct < 0),
      actives: by((m) => m.volume ?? 0),
      updatedAt: Date.now(),
    };
  };
}
