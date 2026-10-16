import { orderCommission, regulatoryFees, type FeeSchedule } from '../broker/fees.js';
import type { JournalTrade } from '../journal.js';
import {
  breakout, completedBars, nyMinute, OPEN_MINUTE, openingRange, planTrade, sessionBars,
  type Candidate, type OrbParams, type Range, type TradePlan,
} from '../strategy/orb.js';
import type { Bar } from '../types.js';

export interface SimCosts {
  fees: FeeSchedule;
  /** Adverse slippage on market-style fills (entries, stops, flatten), as a fraction of price. */
  slippagePct: number;
  /** Minimum slippage per share in $ (a cent: you never get a better-than-touch fill). */
  minSlippage: number;
  /** Intraday buying power (equity × leverage). */
  buyingPower: number;
}

export interface DayResult {
  date: string;
  candidates: Candidate[];
  trades: JournalTrade[];
  /** Why fewer trades than allowed: rule that stopped the day, if any. */
  stoppedBy?: 'maxTrades' | 'maxLosses';
}

interface Open {
  symbol: string;
  plan: TradePlan;
  stop: number;
  movedToBreakeven: boolean;
  openedAt: number;
  entryCost: number;
}

/**
 * Replays one day minute by minute across all candidates together, so the day rules (trade cap,
 * loss cap, buying power) apply exactly as they would live. Deliberately pessimistic:
 *  - entries fill at the next minute's open plus slippage;
 *  - when a minute touches both stop and target, the stop is assumed to fill first;
 *  - a stop that gaps fills at the worse open price, plus slippage;
 *  - breakeven moves only take effect from the following minute.
 */
export function simulateDay(date: string, candidates: Candidate[], minuteBars: Record<string, Bar[]>, p: OrbParams, c: SimCosts): DayResult {
  const sessions = new Map(candidates.map((x) => [x.symbol, sessionBars(minuteBars[x.symbol] ?? [], date)]));
  const byMinute = new Map<string, Map<number, Bar>>();
  for (const [s, bars] of sessions) byMinute.set(s, new Map(bars.map((b) => [nyMinute(b.t), b])));

  const ranges = new Map<string, Range | undefined>();
  const entered = new Set<string>();
  const open = new Map<string, Open>();
  const trades: JournalTrade[] = [];
  let losses = 0;
  let stoppedBy: DayResult['stoppedBy'];

  const slip = (price: number) => Math.max(c.minSlippage, price * c.slippagePct);
  const r2 = (x: number) => Math.round(x * 100) / 100;

  const close = (o: Open, rawPrice: number, t: number) => {
    const exitSide = o.plan.side === 'long' ? 'sell' : 'buy';
    const qty = o.plan.qty;
    const exitCost = orderCommission(qty, qty * rawPrice, c.fees) + regulatoryFees(exitSide, qty, qty * rawPrice, c.fees);
    const gross = (rawPrice - o.plan.entry) * qty * (o.plan.side === 'long' ? 1 : -1);
    const costs = o.entryCost + exitCost;
    const net = r2(gross - costs);
    const risk = Math.abs(o.plan.entry - o.plan.stop) * qty;
    trades.push({
      symbol: o.symbol, direction: o.plan.side, openedAt: o.openedAt, closedAt: t, maxQty: qty,
      avgEntry: r2(o.plan.entry), avgExit: r2(rawPrice), grossPnl: r2(gross), costs: r2(costs), netPnl: net,
      initialRisk: r2(risk), r: risk > 0 ? Math.round((net / risk) * 100) / 100 : undefined, open: false,
    });
    open.delete(o.symbol);
    if (net < 0) losses++;
  };

  for (let m = OPEN_MINUTE; m < 16 * 60; m++) {
    // 1. Signals from 5-minute bars that completed at this minute → enter at this minute's open.
    if (m >= OPEN_MINUTE + p.orMinutes && (m - OPEN_MINUTE) % p.barMinutes === 0 && m <= p.lastEntryMinute) {
      for (const cand of candidates) {
        const s = cand.symbol;
        if (entered.has(s)) continue;
        if (trades.length + open.size >= p.maxTrades) { stoppedBy ??= 'maxTrades'; break; }
        if (losses >= p.maxLosses) { stoppedBy ??= 'maxLosses'; break; }
        const session = sessions.get(s)!;
        if (!ranges.has(s)) ranges.set(s, openingRange(session, p, m));
        const range = ranges.get(s);
        const bar = byMinute.get(s)!.get(m);
        if (!range || !bar) continue;
        const done = completedBars(session.filter((b) => nyMinute(b.t) < m), p, m);
        const last = done.at(-1);
        if (!last || last.endMinute !== m) continue;
        const side = breakout(last, range);
        if (!side) continue;
        const fill = side === 'long' ? bar.o + slip(bar.o) : bar.o - slip(bar.o);
        const plan = planTrade(side, r2(fill), range, p);
        if (!plan) continue;
        const notional = [...open.values()].reduce((a, o) => a + o.plan.qty * o.plan.entry, 0);
        if (notional + plan.qty * plan.entry > c.buyingPower) continue;
        entered.add(s);
        const entrySide = side === 'long' ? 'buy' : 'sell';
        const entryCost = orderCommission(plan.qty, plan.qty * plan.entry, c.fees) + regulatoryFees(entrySide, plan.qty, plan.qty * plan.entry, c.fees);
        open.set(s, { symbol: s, plan, stop: plan.stop, movedToBreakeven: false, openedAt: bar.t, entryCost });
      }
    }

    // 2. Manage open positions against this minute's bar.
    for (const o of [...open.values()]) {
      const bar = byMinute.get(o.symbol)!.get(m);
      if (!bar) continue;
      const long = o.plan.side === 'long';
      if (m >= p.flattenMinute) { close(o, long ? bar.o - slip(bar.o) : bar.o + slip(bar.o), bar.t); continue; }
      const stopHit = long ? bar.l <= o.stop : bar.h >= o.stop;
      const targetHit = long ? bar.h >= o.plan.target : bar.l <= o.plan.target;
      if (stopHit) {
        const px = long ? Math.min(o.stop, bar.o) - slip(o.stop) : Math.max(o.stop, bar.o) + slip(o.stop);
        close(o, px, bar.t);
        continue;
      }
      if (targetHit) { close(o, o.plan.target, bar.t); continue; }
      if (!o.movedToBreakeven && (long ? bar.h >= o.plan.breakeven : bar.l <= o.plan.breakeven)) {
        o.stop = o.plan.entry;
        o.movedToBreakeven = true;
      }
    }
  }
  // Anything still open (missing late bars) closes at its last known price.
  for (const o of [...open.values()]) {
    const last = sessions.get(o.symbol)!.at(-1);
    if (last) close(o, last.c, last.t);
  }
  return { date, candidates, trades, stoppedBy };
}
