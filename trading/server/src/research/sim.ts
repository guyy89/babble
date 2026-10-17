import { orderCommission, regulatoryFees } from '../broker/fees.js';
import type { Bar } from '../types.js';
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

/**
 * Rules for an account sized to a risk tier: 1% risk per trade (equity = 100 × risk), 4× intraday buying
 * power, at most 2× equity in one position. Overrides (e.g. from a grid) win; 0 disables a limit.
 */
export function rulesForRisk(riskPerTrade: number, overrides: Partial<Rules> = {}): Rules {
  const equity = riskPerTrade * 100;
  return {
    ...DEFAULT_RULES,
    riskPerTrade,
    buyingPower: equity * 4,
    maxPositionNotional: equity * 2,
    dailyLossLimit: riskPerTrade * 3,
    ...overrides,
  };
}

/**
 * Gappers (often small caps): 0.05% of price per market fill. Large liquid names and index ETFs trade a
 * cent wide, so 0.01%. Never less than one cent.
 */
export const DEFAULT_COSTS: Costs = { slippagePct: 0.0005, liquidSlippagePct: 0.0001, minSlippage: 0.01, feeMultiplier: 1 };

export const COST_MODEL = process.env.COST_MODEL === 'alpaca' ? 'alpaca' : 'ibkr';

// Fixed here (not read from .env, which configures the app's own paper account) so research results never
// depend on how the app happens to be configured. Rates as of 2026-10.
const REGULATORY = { secFeePerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 };
export const IBKR_FEES = { commissionPerShare: 0.005, minCommission: 1, maxCommissionPct: 0.01, ...REGULATORY };
export const ALPACA_FEES = { commissionPerShare: 0, minCommission: 0, maxCommissionPct: 0, ...REGULATORY };

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const TICK = 0.01;
const r2 = (x: number) => Math.round(x * 100) / 100;
const unlimited = (x: number) => !(x > 0) || !Number.isFinite(x);

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
  entryType: 'market' | 'limit';
}

interface Pending {
  sig: Signal;
  expires: number;
}

/**
 * Replays one day for one strategy. Deliberately pessimistic and identical for every strategy:
 *  - decisions at minute m see only bars that closed before m; market entries fill at bar m's open ± slippage;
 *  - limit entries fill only when price trades THROUGH the limit by a cent (no queue priority), at the better of
 *    limit and open, and the fill bar is then checked against the stop (stop assumed to come after the fill);
 *  - a bar touching both stop and target counts as a stop; a gapped stop fills at the open (worse), a gapped
 *    target at the open (better); breakeven/trailing moves apply from the next bar;
 *  - day rules (0 = unlimited): max trades, max losers (a loser is a trade losing over 0.25R, so scratches don't
 *    count), max concurrent positions incl. pending limits, and a worst-case daily-loss guard
 *    (realised + every open stop + the new stop).
 */
export function simulateStrategyDay<P extends object>(date: string, strategy: Strategy<P>, params: P, rules: Rules, costs: Costs): ResearchTrade[] {
  const day = loadDay(date);
  const ctxBase = { date, meta: day.meta, dailyBefore: (s: string) => dailyBefore(s, date) };
  const watch = strategy.universe(ctxBase, params).filter((s) => day.bars.has(s));
  const byMinute = day.byMinute;
  const closedSoFar = new Map<string, Bar[]>(watch.map((s) => [s, []]));
  const liquid = (s: string) => (day.meta[s]?.tags ?? []).some((t) => t === 'liquid' || t === 'index');

  const openUtc = day.openUtc;
  const minuteOf = (t: number) => OPEN + Math.floor((t - openUtc) / 60_000);
  const open = new Map<string, Pos>();
  const pending = new Map<string, Pending>();
  const traded = new Set<string>();
  const state = new Map<string, unknown>();
  const trades: ResearchTrade[] = [];
  let realised = 0;
  let losers = 0;
  let entries = 0;

  // COST_MODEL=alpaca: commission-free broker (regulatory sale fees still apply). Default: IBKR Pro Fixed.
  const fees = COST_MODEL === 'alpaca' ? ALPACA_FEES : IBKR_FEES;
  const slip = (s: string, px: number) => Math.max(costs.minSlippage, px * (liquid(s) ? costs.liquidSlippagePct : costs.slippagePct));
  const legCost = (side: 'buy' | 'sell', qty: number, px: number) =>
    (orderCommission(qty, qty * px, fees) + regulatoryFees(side, qty, qty * px, fees)) * costs.feeMultiplier;
  const openRisk = () => [...open.values()].reduce((a, p) => a + Math.max(0, (p.side === 'long' ? p.entry - p.stop : p.stop - p.entry)) * p.qty, 0);
  const capacityLeft = () =>
    (unlimited(rules.maxTrades) || entries + pending.size < rules.maxTrades) &&
    (unlimited(rules.maxLosses) || losers < rules.maxLosses) &&
    (unlimited(rules.maxConcurrent) || open.size + pending.size < rules.maxConcurrent);

  const exit = (s: string, p: Pos, px: number, t: number, reason: ResearchTrade['exitReason']) => {
    const dir = p.side === 'long' ? 1 : -1;
    const gross = (px - p.entry) * p.qty * dir;
    const c = p.entryCost + legCost(p.side === 'long' ? 'sell' : 'buy', p.qty, px);
    const net = gross - c;
    const risk = p.riskPerShare * p.qty;
    trades.push({
      date, symbol: s, side: p.side, tag: p.sig.tag, entryTime: p.entryTime, exitTime: t, entry: r2(p.entry), exit: r2(px),
      qty: p.qty, risk: r2(risk), gross: r2(gross), costs: r2(c), net: r2(net), r: risk > 0 ? Math.round((net / risk) * 100) / 100 : 0,
      exitReason: reason, entryType: p.entryType,
    });
    realised += net;
    if (net < -0.25 * risk) losers++;
    open.delete(s);
  };

  /** Size and open a position at `entry`; returns false when the risk/size/buying-power/daily-loss checks fail. */
  const openPosition = (s: string, sig: Signal, entry: number, t: number, entryType: 'market' | 'limit'): boolean => {
    const long = sig.side === 'long';
    const riskPerShare = long ? entry - sig.stop : sig.stop - entry;
    // Too-tight stops start the trade ~1R down after a cent of slippage each way: require a real distance.
    if (!(riskPerShare >= Math.max(0.02, 4 * costs.minSlippage, entry * 0.0015))) return false;
    const qty = Math.min(Math.floor(rules.riskPerTrade / riskPerShare), Math.floor(rules.maxPositionNotional / entry));
    if (qty < 1) return false;
    const openNotional = [...open.values()].reduce((a, p) => a + p.qty * p.entry, 0);
    if (openNotional + qty * entry > rules.buyingPower) return false;
    if (!unlimited(rules.dailyLossLimit) && realised - openRisk() - riskPerShare * qty < -rules.dailyLossLimit) return false;
    open.set(s, {
      sig, side: sig.side, entry, qty, stop: sig.stop, initialStop: sig.stop, riskPerShare,
      target: sig.targetR ? entry + (long ? 1 : -1) * sig.targetR * riskPerShare : undefined,
      best: entry, movedBe: false, entryTime: t, entryCost: legCost(long ? 'buy' : 'sell', qty, entry), entryType,
    });
    traded.add(s);
    entries++;
    return true;
  };

  /** Stop / target / stop-adjustment handling for one bar. `fillBar`: the position was opened inside this bar. */
  const manage = (s: string, p: Pos, bar: Bar, m: number, fillBar: boolean) => {
    const long = p.side === 'long';
    if (!fillBar && (m >= rules.flattenMinute || (p.sig.exitMinute !== undefined && m >= p.sig.exitMinute))) {
      exit(s, p, long ? bar.o - slip(s, bar.o) : bar.o + slip(s, bar.o), bar.t, m >= rules.flattenMinute ? 'flatten' : 'time');
      return;
    }
    if (!p.sig.noStop && (long ? bar.l <= p.stop : bar.h >= p.stop)) {
      const worst = fillBar ? p.stop : long ? Math.min(p.stop, bar.o) : Math.max(p.stop, bar.o);
      const px = long ? worst - slip(s, p.stop) : worst + slip(s, p.stop);
      const reason = p.stop === p.initialStop ? 'stop' : p.movedBe && Math.abs(p.stop - p.entry) < 1e-9 ? 'breakeven' : 'trail';
      exit(s, p, px, bar.t, reason);
      return;
    }
    if (fillBar) return; // the rest of the fill bar is not credited
    if (p.target !== undefined && (long ? bar.h >= p.target : bar.l <= p.target)) {
      exit(s, p, long ? Math.max(p.target, bar.o) : Math.min(p.target, bar.o), bar.t, 'target');
      return;
    }
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
  };

  for (let m = OPEN + 1; m < CLOSE; m++) {
    for (const s of watch) {
      const b = byMinute.get(s)!.get(m - 1);
      if (b) closedSoFar.get(s)!.push(b);
    }

    // 1. New decisions at this minute.
    if (m <= rules.lastEntryMinute) {
      const ctx: MinuteContext = {
        ...ctxBase, minute: m, bars: (s) => closedSoFar.get(s) ?? [], open: new Set([...open.keys(), ...pending.keys()]), traded, state, minuteOf,
      };
      for (const sig of strategy.onMinute(ctx, params)) {
        if (open.has(sig.symbol) || pending.has(sig.symbol) || !closedSoFar.has(sig.symbol)) continue;
        if (!capacityLeft()) break;
        if (sig.entryLimit !== undefined) {
          pending.set(sig.symbol, { sig, expires: m + (sig.limitTtl ?? 10) });
          traded.add(sig.symbol);
          continue;
        }
        const bar = byMinute.get(sig.symbol)!.get(m);
        if (!bar) continue;
        const px = sig.side === 'long' ? bar.o + slip(sig.symbol, bar.o) : bar.o - slip(sig.symbol, bar.o);
        openPosition(sig.symbol, sig, px, bar.t, 'market');
      }
    }

    // 2. Pending limit orders: fill only on a trade-through. A limit fill handles its own bar (stop check only).
    const limitFilled = new Set<string>();
    for (const [s, pd] of [...pending]) {
      if (m >= pd.expires || m >= rules.flattenMinute) { pending.delete(s); continue; }
      const bar = byMinute.get(s)!.get(m);
      if (!bar) continue;
      const lim = pd.sig.entryLimit!;
      const long = pd.sig.side === 'long';
      // Trade-through by at least a cent (with a float tolerance: 19.90 - 0.01 is 19.889999… in binary).
      if (long ? bar.l <= lim - TICK + 1e-9 : bar.h >= lim + TICK - 1e-9) {
        pending.delete(s);
        const px = long ? Math.min(lim, bar.o) : Math.max(lim, bar.o);
        if (openPosition(s, pd.sig, px, bar.t, 'limit')) {
          limitFilled.add(s);
          manage(s, open.get(s)!, bar, m, true);
        }
      }
    }

    // 3. Manage open positions on this minute's bar (market entries included: their entry bar counts in full).
    for (const [s, p] of [...open]) {
      if (limitFilled.has(s)) continue;
      const bar = byMinute.get(s)!.get(m);
      if (!bar) continue;
      manage(s, p, bar, m, false);
    }
  }
  for (const [s, p] of [...open]) {
    const last = closedSoFar.get(s)!.at(-1);
    if (last) exit(s, p, p.side === 'long' ? last.c - slip(s, last.c) : last.c + slip(s, last.c), last.t, 'flatten');
  }
  return trades;
}
