import type { Fill, Order } from './types.js';

/** One round trip: from flat, through any adds and partial exits, back to flat. */
export interface JournalTrade {
  symbol: string;
  direction: 'long' | 'short';
  openedAt: number;
  closedAt?: number;
  /** Largest position size reached during the trade. */
  maxQty: number;
  avgEntry: number;
  avgExit: number;
  /** Price P&L before costs. */
  grossPnl: number;
  /** Commissions plus regulatory fees on every fill of the trade. */
  costs: number;
  netPnl: number;
  /** Planned loss to the initial stop (from the entry's bracket stop-loss), when there was one. */
  initialRisk?: number;
  /** netPnl in units of initialRisk. */
  r?: number;
  open: boolean;
}

export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  netPnl: number;
}

export interface JournalStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossPnl: number;
  costs: number;
  avgWin: number;
  avgLoss: number;
  /** Gross wins / gross losses (net of costs). Infinity when there are no losses. */
  profitFactor: number;
  /** Average net P&L per trade. */
  expectancy: number;
  avgR?: number;
  largestWin: number;
  largestLoss: number;
}

export interface Journal {
  trades: JournalTrade[];
  stats: JournalStats;
  byHour: Bucket[];
  bySymbol: Bucket[];
  byDay: Bucket[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/**
 * Rebuilds round-trip trades from the fill history and summarises them. Pass fills oldest first:
 * fills with the same timestamp keep their input order (the sort is stable).
 */
export function buildJournal(fills: Fill[], orders: Order[]): Journal {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const open = new Map<string, JournalTrade & { qty: number; entryQty: number; exitQty: number }>();
  const trades: JournalTrade[] = [];

  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    let remaining = f.qty;
    const delta = f.side === 'buy' ? 1 : -1;
    // A fill can close one trade and open the next (flip through zero); split its costs by quantity.
    while (remaining > 0) {
      let t = open.get(f.symbol);
      if (!t) {
        t = {
          symbol: f.symbol, direction: delta > 0 ? 'long' : 'short', openedAt: f.ts, maxQty: 0, avgEntry: 0, avgExit: 0,
          grossPnl: 0, costs: 0, netPnl: 0, open: true, qty: 0, entryQty: 0, exitQty: 0,
        };
        const entry = byId.get(f.orderId);
        const sl = entry?.legIds?.map((id) => byId.get(id)).find((o) => o?.type === 'stop');
        const initialStop = sl?.initialStopPrice ?? sl?.stopPrice;
        if (initialStop !== undefined) t.initialRisk = round2(Math.abs(f.price - initialStop) * (entry?.qty ?? f.qty));
        open.set(f.symbol, t);
      }
      const adding = (t.direction === 'long') === (delta > 0);
      const q = adding ? remaining : Math.min(remaining, t.qty);
      const share = q / f.qty;
      t.costs += (f.commission + f.fees) * share;
      if (adding) {
        t.avgEntry = (t.avgEntry * t.entryQty + f.price * q) / (t.entryQty + q);
        t.entryQty += q;
        t.qty += q;
        t.maxQty = Math.max(t.maxQty, t.qty);
      } else {
        t.avgExit = (t.avgExit * t.exitQty + f.price * q) / (t.exitQty + q);
        t.exitQty += q;
        t.qty -= q;
        t.grossPnl += (f.price - t.avgEntry) * q * (t.direction === 'long' ? 1 : -1);
        if (t.qty === 0) {
          t.open = false;
          t.closedAt = f.ts;
          open.delete(f.symbol);
          trades.push(finish(t));
        }
      }
      remaining -= q;
    }
  }
  for (const t of open.values()) trades.push(finish(t));

  const closed = trades.filter((t) => !t.open);
  return {
    trades: trades.sort((a, b) => b.openedAt - a.openedAt),
    stats: stats(closed),
    byHour: bucket(closed, (t) => `${nyHour.format(new Date(t.openedAt))}:00`),
    bySymbol: bucket(closed, (t) => t.symbol).sort((a, b) => b.netPnl - a.netPnl),
    byDay: bucket(closed, (t) => nyDate.format(new Date(t.closedAt!))).reverse(),
  };
}

function finish<T extends JournalTrade>(t: T): JournalTrade {
  const { qty: _q, entryQty: _e, exitQty: _x, ...rest } = t as T & { qty: number; entryQty: number; exitQty: number };
  const out: JournalTrade = {
    ...rest,
    avgEntry: round2(t.avgEntry),
    avgExit: round2(t.avgExit),
    grossPnl: round2(t.grossPnl),
    costs: round2(t.costs),
    netPnl: round2(t.grossPnl - t.costs),
  };
  if (!t.open && t.initialRisk && t.initialRisk > 0) out.r = Math.round((out.netPnl / t.initialRisk) * 100) / 100;
  return out;
}

export function stats(closed: JournalTrade[]): JournalStats {
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl <= 0);
  const sum = (xs: JournalTrade[], f: (t: JournalTrade) => number) => xs.reduce((a, t) => a + f(t), 0);
  const grossWin = sum(wins, (t) => t.netPnl);
  const grossLoss = -sum(losses, (t) => t.netPnl);
  const withR = closed.filter((t) => t.r !== undefined);
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    netPnl: round2(sum(closed, (t) => t.netPnl)),
    grossPnl: round2(sum(closed, (t) => t.grossPnl)),
    costs: round2(sum(closed, (t) => t.costs)),
    avgWin: wins.length ? round2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? Infinity : 0,
    expectancy: closed.length ? round2(sum(closed, (t) => t.netPnl) / closed.length) : 0,
    avgR: withR.length ? Math.round((sum(withR, (t) => t.r!) / withR.length) * 100) / 100 : undefined,
    largestWin: round2(Math.max(0, ...closed.map((t) => t.netPnl))),
    largestLoss: round2(Math.min(0, ...closed.map((t) => t.netPnl))),
  };
}

export function bucket(closed: JournalTrade[], key: (t: JournalTrade) => string): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const t of closed) {
    const k = key(t);
    const b = m.get(k) ?? { key: k, trades: 0, wins: 0, netPnl: 0 };
    b.trades++;
    if (t.netPnl > 0) b.wins++;
    b.netPnl = round2(b.netPnl + t.netPnl);
    m.set(k, b);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}
