import type { BotStatus } from '../../server/src/bot/orbBot';
import type { Journal } from '../../server/src/journal';
import type { Movers } from '../../server/src/market/movers';
import type { ScanFilter, ScanRow } from '../../server/src/market/scanner';
import type { SymbolInfo } from '../../server/src/market/symbolDirectory';
import type { Bar, NewsItem, Order, OrderRequest } from '../../server/src/types';

export type { BotStatus, Journal, Movers, NewsItem, OrderRequest, ScanFilter, ScanRow, SymbolInfo };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  if (!res.ok && res.status !== 422) throw new Error(json.error ?? res.statusText);
  return json as T;
}

export const api = {
  bars: (symbol: string, tf?: 'day') => call<Bar[]>('GET', `/bars/${symbol}${tf ? `?tf=${tf}` : ''}`),
  modify: (id: string, changes: { limitPrice?: number; stopPrice?: number; trailAmount?: number | null }) =>
    call<Order>('PATCH', `/orders/${id}`, changes),
  journal: () => call<Journal>('GET', '/journal'),
  setBot: (enabled: boolean) => call<BotStatus>('POST', '/bot', { enabled }),
  scan: (f: ScanFilter) =>
    call<ScanRow[]>('GET', `/scan?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
  news: (symbol: string) => call<NewsItem[]>('GET', `/news/${encodeURIComponent(symbol)}`),
  submit: (req: OrderRequest) => call<Order>('POST', '/orders', req),
  cancel: (id: string) => call<Order>('DELETE', `/orders/${id}`),
  cancelAll: () => call<void>('DELETE', '/orders'),
  close: (symbol: string) => call<Order | null>('DELETE', `/positions/${symbol}`),
  flattenAll: () => call<void>('DELETE', '/positions'),
  resetAccount: () => call<unknown>('POST', '/account/reset'),
  search: (q: string) => call<SymbolInfo[]>('GET', `/search?q=${encodeURIComponent(q)}`),
  movers: () => call<Movers>('GET', '/movers'),
  watch: (symbol: string) => call<unknown>('POST', '/watchlist', { symbol }),
  unwatch: (symbol: string) => call<unknown>('DELETE', `/watchlist/${encodeURIComponent(symbol)}`),
};
