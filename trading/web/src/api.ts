import type { Bar, Order, OrderRequest } from '../../server/src/types';

export type { OrderRequest };

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
  bars: (symbol: string) => call<Bar[]>('GET', `/bars/${symbol}`),
  submit: (req: OrderRequest) => call<Order>('POST', '/orders', req),
  cancel: (id: string) => call<Order>('DELETE', `/orders/${id}`),
  cancelAll: () => call<void>('DELETE', '/orders'),
  close: (symbol: string) => call<Order | null>('DELETE', `/positions/${symbol}`),
  flattenAll: () => call<void>('DELETE', '/positions'),
};
