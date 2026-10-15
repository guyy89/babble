import { useEffect, useReducer } from 'react';
import type { PublicSettings } from '../../server/src/api/server';
import type { Account, Bar, Fill, Order, Position, Quote } from '../../server/src/types';

export type { Account, Bar, Fill, Order, Position, PublicSettings, Quote };

export interface Clock {
  isOpen: boolean;
  nyDate: string;
  minutesToClose: number | null;
  alwaysOpen: boolean;
}

export interface Notice {
  level: 'info' | 'warn';
  message: string;
  ts: number;
}

export interface State {
  connected: boolean;
  dataSource: string;
  broker: string;
  settings?: PublicSettings;
  clock?: Clock;
  symbols: string[];
  quotes: Record<string, Quote>;
  account?: Account;
  positions: Position[];
  orders: Record<string, Order>;
  fills: Fill[];
  notices: Notice[];
}

type Action =
  | { type: 'connected'; value: boolean }
  | { type: 'snapshot'; data: any }
  | { type: 'quote'; data: Quote }
  | { type: 'order'; data: Order }
  | { type: 'fill'; data: Fill }
  | { type: 'account'; data: Account }
  | { type: 'positions'; data: Position[] }
  | { type: 'clock'; data: Clock }
  | { type: 'notice'; data: Notice }
  | { type: 'dismiss'; ts: number };

const initial: State = {
  connected: false, dataSource: '', broker: '', symbols: [], quotes: {}, positions: [], orders: {}, fills: [], notices: [],
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'connected':
      return { ...s, connected: a.value };
    case 'snapshot': {
      const d = a.data;
      return {
        ...s,
        dataSource: d.dataSource,
        broker: d.broker,
        settings: d.settings,
        clock: d.clock,
        symbols: d.symbols,
        quotes: Object.fromEntries((d.quotes as Quote[]).map((q) => [q.symbol, q])),
        account: d.account,
        positions: d.positions,
        orders: Object.fromEntries((d.orders as Order[]).map((o) => [o.id, o])),
        fills: d.fills,
      };
    }
    case 'quote':
      return { ...s, quotes: { ...s.quotes, [a.data.symbol]: a.data } };
    case 'order':
      return { ...s, orders: { ...s.orders, [a.data.id]: a.data } };
    case 'fill':
      return { ...s, fills: [a.data, ...s.fills].slice(0, 500) };
    case 'account':
      return { ...s, account: a.data };
    case 'positions':
      return { ...s, positions: a.data };
    case 'clock':
      return { ...s, clock: a.data };
    case 'notice':
      return { ...s, notices: [...s.notices, a.data].slice(-5) };
    case 'dismiss':
      return { ...s, notices: s.notices.filter((n) => n.ts !== a.ts) };
  }
}

// Bars are high-frequency and only the chart cares, so they bypass React state.
type BarListener = (bar: Bar) => void;
const barListeners = new Set<BarListener>();
export function onBar(fn: BarListener): () => void {
  barListeners.add(fn);
  return () => barListeners.delete(fn);
}

export function useTradingStore() {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => dispatch({ type: 'connected', value: true });
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'bar') barListeners.forEach((fn) => fn(msg.data));
        else dispatch(msg);
      };
      ws.onclose = () => {
        dispatch({ type: 'connected', value: false });
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  // Toasts clear themselves after a few seconds.
  useEffect(() => {
    if (state.notices.length === 0) return;
    const oldest = state.notices[0];
    const t = setTimeout(() => dispatch({ type: 'dismiss', ts: oldest.ts }), Math.max(0, oldest.ts + 6000 - Date.now()));
    return () => clearTimeout(t);
  }, [state.notices]);

  const dismiss = (ts: number) => dispatch({ type: 'dismiss', ts });
  return { state, dismiss };
}
