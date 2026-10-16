import { orderCommission, regulatoryFees } from '../broker/fees.js';
import { config } from '../config.js';
import type { Bar } from '../types.js';
import { nyToUtc } from '../backtest/universe.js';
import { dailyBefore, loadDay } from './data.js';
import type { Costs, MinuteContext, ResearchTrade, Rules, Side, Signal, Strategy } from './types.js';

export const DEFAULT_RULES: Rules = {
  riskPerTrade: 50,
  maxPositionNotional: 10_000,
  buyingPower: 20_000,
  dailyLossLimit: 150,
  maxTrades: 3,
  maxLosses: 2,
  maxConcurrent: 2,
  lastEntryMinute: 15 * 60 + 30,
  flattenMinute: 15 * 60 + 55,
};

export const DEFAULT_COSTS: Costs = { slippagePct: 0.0005, minSlippage: 0.01, feeMultiplier: 1 };

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const r2 = (x: number) => Math.round(x * 100) / 100;

interface Pos {
  sig: Signal;
  side: Side;
  entry: number;
  qty: number;
  stop: number;
  initialStop: number;
  riskPerShare: number;
  target?: number;
  best: number;
  movedBe: boolean;
  entryTime: number;
  entryCost: number;
}

/**
 * Replays one day for one strategy. Deliberately pessimistic and identical for every strategy:
 *  - decisions at minute m see only bars that closed before m and fill at bar m's open ± slippage;
 *  - a bar touching both stop and target counts as a stop; a stop gapped through fills at the open;
 *  - breakeven/trailing moves use a bar's extreme only from the next bar on;
 *  - day rules: max trades, max losers, max concurrent positions, and no new entry whose worst case
 *    (realised + every open stop + this stop) could breach the daily loss limit.
 */
export function simulateStrategyDay<P extends object>(date: string, strategy: Strategy<P>, params: P, rules: Rules, costs: Costs): ResearchTrade[] {
  const day = loadDay(date);
  const ctxBase = { date, meta: day.meta, dailyBefore: (s: string) => dailyBefore(s, date) };
  const watch = strategy.universe(ctxBase, params).filter((s) => day.bars.has(s));
  const byMinute = new Map<string, Map<number, Bar>>();
  for (const s of watch) byMinute.set(s, new Map(day.bars.get(s)!.map((x) => [x.minute, x.bar])));
  const closedSoFar = new Map<string, Bar[]>(watch.map((s) => [s, []]));

  const openUtc = nyToUtc(date, OPEN);
  const minuteOf = (t: number) => OPEN + Math.floor((t - openUtc) / 60_000);
  const open = new Map<string, Pos>();
  const traded = new Set<string>();
  const state = new Map<string, unknown>();
  const trades: ResearchTrade[] = [];
  let realised = 0;
  let losers = 0;
  let entries = 0;

  const fees = config.paper.fees;
  const slip = (px: number) => Math.max(costs.minSlippage, px * costs.slippagePct);
  const legCost = (side: 'buy' | 'sell', qty: number, px: number) =>
    (orderCommission(qty, qty * px, fees) + regulatoryFees(side, qty, qty * px, fees)) * costs.feeMultiplier;

  const exit = (s: string, p: Pos, px: number, t: number, reason: ResearchTrade['exitReason']) => {
    const dir = p.side === 'long' ? 1 : -1;
    const gross = (px - p.entry) * p.qty * dir;
    const c = p.entryCost + legCost(p.side === 'long' ? 'sell' : 'buy', p.qty, px);
    const net = gross - c;
    const risk = p.riskPerShare * p.qty;
    trades.push({
      date, symbol: s, side: p.side, tag: p.sig.tag, entryTime: p.entryTime, exitTime: t, entry: r2(p.entry), exit: r2(px),
      qty: p.qty, risk: r2(risk), gross: r2(gross), costs: r2(c), net: r2(net), r: risk > 0 ? Math.round((net / risk) * 100) / 100 : 0, exitReason: reason,
    });
    realised += net;
    if (net < 0) losers++;
    open.delete(s);
  };

  for (let m = OPEN + 1; m < CLOSE; m++) {
    // Bars that closed at m-1 become visible.
    for (const s of watch) {
      const b = byMinute.get(s)!.get(m - 1);
      if (b) closedSoFar.get(s)!.push(b);
    }

    // 1. Entries at this minute's open.
    if (m <= rules.lastEntryMinute) {
      const ctx: MinuteContext = { ...ctxBase, minute: m, bars: (s) => closedSoFar.get(s) ?? [], open: new Set(open.keys()), traded, state, minuteOf };
      for (const sig of strategy.onMinute(ctx, params)) {
        if (open.has(sig.symbol) || !closedSoFar.has(sig.symbol)) continue;
        if (entries >= rules.maxTrades || losers >= rules.maxLosses || open.size >= rules.maxConcurrent) break;
        const bar = byMinute.get(sig.symbol)!.get(m);
        if (!bar) continue;
        const long = sig.side === 'long';
        const entry = long ? bar.o + slip(bar.o) : bar.o - slip(bar.o);
        const riskPerShare = long ? entry - sig.stop : sig.stop - entry;
        if (!(riskPerShare >= 0.02)) continue;
        const qty = Math.min(Math.floor(rules.riskPerTrade / riskPerShare), Math.floor(rules.maxPositionNotional / entry));
        if (qty < 1) continue;
        const openNotional = [...open.values()].reduce((a, p) => a + p.qty * p.entry, 0);
        if (openNotional + qty * entry > rules.buyingPower) continue;
        const openRisk = [...open.values()].reduce((a, p) => a + Math.max(0, (p.side === 'long' ? p.entry - p.stop : p.stop - p.entry)) * p.qty, 0);
        if (realised - openRisk - riskPerShare * qty < -rules.dailyLossLimit) continue;
        const entryCost = legCost(long ? 'buy' : 'sell', qty, entry);
        open.set(sig.symbol, {
          sig, side: sig.side, entry, qty, stop: sig.stop, initialStop: sig.stop, riskPerShare,
          target: sig.targetR ? entry + (long ? 1 : -1) * sig.targetR * riskPerShare : undefined,
          best: entry, movedBe: false, entryTime: bar.t, entryCost,
        });
        traded.add(sig.symbol);
        entries++;
      }
    }

    // 2. Manage open positions on this minute's bar.
    for (const [s, p] of [...open]) {
      const bar = byMinute.get(s)!.get(m);
      if (!bar) continue;
      const long = p.side === 'long';
      if (m >= rules.flattenMinute || (p.sig.exitMinute !== undefined && m >= p.sig.exitMinute)) {
        exit(s, p, long ? bar.o - slip(bar.o) : bar.o + slip(bar.o), bar.t, m >= rules.flattenMinute ? 'flatten' : 'time');
        continue;
      }
      if (long ? bar.l <= p.stop : bar.h >= p.stop) {
        const px = long ? Math.min(p.stop, bar.o) - slip(p.stop) : Math.max(p.stop, bar.o) + slip(p.stop);
        const reason = p.stop === p.initialStop ? 'stop' : p.movedBe && Math.abs(p.stop - p.entry) < 1e-9 ? 'breakeven' : 'trail';
        exit(s, p, px, bar.t, reason);
        continue;
      }
      if (p.target !== undefined && (long ? bar.h >= p.target : bar.l <= p.target)) {
        exit(s, p, p.target, bar.t, 'target');
        continue;
      }
      // Stop adjustments take effect from the next bar.
      p.best = long ? Math.max(p.best, bar.h) : Math.min(p.best, bar.l);
      const gainR = ((p.best - p.entry) * (long ? 1 : -1)) / p.riskPerShare;
      if (p.sig.breakevenAtR !== undefined && !p.movedBe && gainR >= p.sig.breakevenAtR) {
        p.movedBe = true;
        p.stop = long ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
      }
      if (p.sig.trailR !== undefined) {
        const trail = long ? p.best - p.sig.trailR * p.riskPerShare : p.best + p.sig.trailR * p.riskPerShare;
        p.stop = long ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
      }
    }
  }
  // Positions on symbols with no late bars close at their last price.
  for (const [s, p] of [...open]) {
    const last = closedSoFar.get(s)!.at(-1);
    if (last) exit(s, p, last.c, last.t, 'flatten');
  }
  return trades;
}
