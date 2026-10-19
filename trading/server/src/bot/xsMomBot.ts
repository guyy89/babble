import { EventEmitter } from 'node:events';
import type { StateStore } from '../broker/stateStore.js';
import { buildJournal } from '../journal.js';
import { israelTime, nyMinute, OPEN_MINUTE } from '../strategy/orb.js';
import type { TradingService } from '../tradingService.js';
import type { Bar } from '../types.js';

// Forward paper test of the round-2 research candidate r2_xsmom, frozen exactly as the audit specified:
// at 09:45 New York, rank the day's liquid single stocks by (return from today's open) / (daily ATR%),
// buy the top K and short the bottom K, each leg sized from max(0.5 × ATR14, price × K/190) for the same
// $ risk, market orders, no stop, everything flattened 5 minutes before the close by the trading service.
// Pre-registered decision after 60 trading days: ≥ +17R confirms, ≤ 0R fails, a 25R drawdown stops it early.

export interface XsParams {
  K: number;
  /** Decision minute after the open (15 = 09:45 NY). */
  decMin: number;
  /** No entries later than this many minutes after the decision minute (e.g. after a restart). */
  lateMin: number;
  stopK: number;
  riskPerLeg: number;
  /** Size of the 'liquid' universe the research used (top N by 20-day average $ volume). */
  nLiquid: number;
  evalDays: number;
  confirmR: number;
  maxDrawdownR: number;
}

export const XS_PARAMS: XsParams = {
  K: 4, decMin: 15, lateMin: 4, stopK: 0.5, riskPerLeg: 200, nLiquid: 20, evalDays: 60, confirmR: 17, maxDrawdownR: 25,
};

/** One stock's inputs at the decision minute. */
export interface XsInput {
  symbol: string;
  name: string;
  prevClose: number;
  atr: number;
  /** 20-day average consolidated volume before today. */
  avgVolume: number;
  open: number;
  /** Latest price at the decision minute. */
  px: number;
}

export interface XsPick { symbol: string; side: 'long' | 'short'; qty: number; score: number; px: number; dist: number }

// The same exclusions as research/prepare.ts and strategies/r2_xsmom.ts.
const LEVERAGED = /\b(\d(\.\d)?x|2x|3x|ultra|leveraged?|inverse|bull|bear|daily target)\b/i;
const NOT_COMMON = /\b(warrants?|rights?|units?|preferred|notes?)\b/i;
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'IVV', 'VOO', 'GLD', 'TQQQ', 'SQQQ', 'SMH', 'SOXX', 'HYG', 'TLT', 'DIA', 'XLF', 'XLE', 'SOXL', 'SLV', 'GOOG']);
/** Names never eligible (leveraged products and non-common shares). */
export const XS_EXCLUDED = new RegExp(`${LEVERAGED.source}|${NOT_COMMON.source}`, 'i');
const isEtfName = (n: string) => /\bETF\b|\bTrust\b|ProShares|iShares|SPDR|\bFund\b|Direxion/i.test(n);

export function atr14(daily: Bar[]): number {
  const b = daily.slice(-15);
  if (b.length < 7) return NaN;
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / (b.length - 1);
}

/** The basket for one day, interleaved long #1, short #1, long #2, … (empty when too few stocks qualify). */
export function selectBasket(rows: XsInput[], p: XsParams): XsPick[] {
  const liquid = rows
    .filter((r) => r.open >= 5 && !LEVERAGED.test(r.name) && !NOT_COMMON.test(r.name))
    .sort((a, b) => b.avgVolume * b.open - a.avgVolume * a.open)
    .slice(0, p.nLiquid);
  const scored = liquid
    .filter((r) => !ETF.has(r.symbol) && !isEtfName(r.name) && r.atr > 0 && r.prevClose > 0 && r.px > 0)
    .map((r) => ({ r, score: (r.px / r.open - 1) / (r.atr / r.prevClose) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length < 2 * p.K + 2) return [];
  const pick = (x: (typeof scored)[number], side: 'long' | 'short'): XsPick => {
    const dist = Math.max(p.stopK * x.r.atr, x.r.px * (p.K / 190));
    const qty = Math.min(Math.floor(p.riskPerLeg / dist), Math.floor((200 * p.riskPerLeg) / x.r.px));
    return { symbol: x.r.symbol, side, qty, score: x.score, px: x.r.px, dist };
  };
  const top = scored.slice(0, p.K), bottom = scored.slice(-p.K).reverse();
  const out: XsPick[] = [];
  for (let i = 0; i < p.K; i++) out.push(pick(top[i], 'long'), pick(bottom[i], 'short'));
  return out.filter((x) => x.qty > 0);
}

export interface XsLeg {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  score: number;
  decisionPx: number;
  orderId?: string;
  fillPx?: number;
  pnl?: number;
  note?: string;
}

export interface XsDay {
  date: string;
  decidedAt: number;
  legs: XsLeg[];
  done: boolean;
  /** Net of costs, in $ and in R (= $ / risk per leg). */
  pnl?: number;
  r?: number;
}

export interface XsState {
  enabled: boolean;
  days: XsDay[];
  halted?: string;
  log: { ts: number; msg: string }[];
}

export interface XsStatus extends XsState {
  phase: string;
  params: XsParams;
  decisionTime: string;
  available: boolean;
  unavailableReason?: string;
  summary: { days: number; pnl: number; r: number; peakR: number; drawdownR: number; openPnl: number; verdict: string };
  account?: { equity: number; dayPnl: number };
}

const LOG_KEEP = 300;

/** Daily data the bot needs before the decision: prev close, ATR and consolidated average volume. */
export type XsPrepare = () => Promise<Omit<XsInput, 'open' | 'px'>[]>;
/** Today's open and the latest price for the given symbols (from live snapshots). */
export type XsPrices = (symbols: string[]) => Promise<Record<string, { open: number; px: number }>>;

export class XsMomBot extends EventEmitter {
  private s: XsState;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private prep?: { date: string; rows: Omit<XsInput, 'open' | 'px'>[] };
  private prepFailures = 0;
  private missedDate?: string;
  private prepFailDate?: string;

  constructor(
    private readonly svc: TradingService,
    private readonly prepare: XsPrepare,
    private readonly prices: XsPrices,
    private readonly p: XsParams = XS_PARAMS,
    private readonly store?: StateStore<XsState>,
    private readonly unavailable?: string,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.s = store?.load() ?? { enabled: false, days: [], log: [] };
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.store?.save(this.s, true);
  }

  setEnabled(on: boolean): void {
    if (on && this.unavailable) throw new Error(this.unavailable);
    if (on && this.s.halted) throw new Error(`הבדיקה נעצרה: ${this.s.halted}`);
    if (this.s.enabled === on) return;
    this.s.enabled = on;
    this.log(on ? 'הרובוט הופעל' : 'הרובוט כובה. פוזיציות פתוחות ייסגרו אוטומטית 5 דקות לפני סוף המסחר');
  }

  async status(): Promise<XsStatus> {
    const done = this.s.days.filter((d) => d.done);
    let cum = 0, peak = 0;
    for (const d of done) { cum += d.r ?? 0; peak = Math.max(peak, cum); }
    const pnl = done.reduce((a, d) => a + (d.pnl ?? 0), 0);
    const today = this.s.days.find((d) => d.date === this.svc.clock.nyDate() && !d.done);
    let openPnl = 0;
    if (today) {
      const pos = await this.svc.broker.getPositions();
      for (const l of today.legs) openPnl += pos.find((x) => x.symbol === l.symbol)?.unrealizedPnl ?? 0;
    }
    const acct = await this.svc.broker.getAccount();
    return {
      ...this.s, phase: this.phase(), params: this.p, decisionTime: israelTime(OPEN_MINUTE + this.p.decMin, this.now()),
      available: !this.unavailable, unavailableReason: this.unavailable,
      summary: { days: done.length, pnl: round2(pnl), r: round2(cum), peakR: round2(peak), drawdownR: round2(cum - peak), openPnl: round2(openPnl), verdict: this.verdict(done.length, cum) },
      account: { equity: acct.equity, dayPnl: acct.dayPnl },
    };
  }

  private verdict(days: number, r: number): string {
    if (this.s.halted) return `נכשלה: ${this.s.halted}`;
    if (days < this.p.evalDays) return `בבדיקה: ${days} מתוך ${this.p.evalDays} ימי מסחר`;
    if (r >= this.p.confirmR) return `אושרה: ${round2(r)}R אחרי ${days} ימים (הסף +${this.p.confirmR}R)`;
    if (r <= 0) return `נכשלה: ${round2(r)}R אחרי ${days} ימים`;
    return `לא הוכרע (${round2(r)}R): ממשיכים עד ${2 * this.p.evalDays} ימים`;
  }

  private phase(): string {
    if (this.unavailable) return this.unavailable;
    if (this.s.halted) return `נעצר: ${this.s.halted}`;
    if (!this.s.enabled) return 'כבוי';
    const clock = this.svc.clock.state();
    if (!clock.isOpen) return `ממתין ליום המסחר הבא (החלטה ב-${israelTime(OPEN_MINUTE + this.p.decMin, this.now())} שעון ישראל)`;
    const m = nyMinute(this.now());
    const day = this.s.days.find((d) => d.date === clock.nyDate);
    if (!day) return m < OPEN_MINUTE + this.p.decMin ? `ממתין לרגע ההחלטה (${israelTime(OPEN_MINUTE + this.p.decMin, this.now())})` : 'היום לא נכנס (הוחמץ חלון הכניסה)';
    if (!day.legs.length) return 'היום אין עסקאות';
    return day.done ? 'היום הסתיים' : `מחזיק ${day.legs.length} פוזיציות עד הסגירה`;
  }

  /** An outside event worth keeping in the robot's log (e.g. the data stream was reconnected). */
  note(msg: string): void {
    this.log(msg);
  }

  private log(msg: string): void {
    this.s.log.unshift({ ts: this.now(), msg });
    if (this.s.log.length > LOG_KEEP) this.s.log.length = LOG_KEEP;
    this.changed();
  }

  private changed(): void {
    this.store?.save(this.s);
    this.emit('changed');
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } catch (err) {
      this.log(`שגיאה: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    // Results are settled even when the robot is switched off, so a day that was traded is always counted.
    await this.settle();
    if (!this.s.enabled || this.unavailable || this.s.halted) return;
    const clock = this.svc.clock.state();
    if (!clock.isOpen) return;
    const m = nyMinute(this.now());
    const decision = OPEN_MINUTE + this.p.decMin;
    if (m < OPEN_MINUTE + 1 || this.s.days.some((d) => d.date === clock.nyDate)) return;

    if (this.prep?.date !== clock.nyDate) {
      if (this.prepFailDate !== clock.nyDate) { this.prepFailDate = clock.nyDate; this.prepFailures = 0; }
      if (this.prepFailures >= 5) return;
      try {
        this.prep = { date: clock.nyDate, rows: await this.prepare() };
        this.prepFailures = 0;
        this.log(`נתוני הימים הקודמים נטענו עבור ${this.prep.rows.length} מניות`);
      } catch (err) {
        this.prepFailures++;
        this.log(`טעינת נתוני הימים הקודמים נכשלה (ניסיון ${this.prepFailures}/5): ${(err as Error).message}`);
        return;
      }
    }
    if (m < decision) return;
    if (m > decision + this.p.lateMin) {
      // Missed days (e.g. the system wasn't running at the decision minute) are not counted.
      if (this.missedDate !== clock.nyDate) {
        this.missedDate = clock.nyDate;
        this.log(`חלון הכניסה (${israelTime(decision, this.now())}) הוחמץ היום, למשל כי המערכת לא רצה. היום לא נספר`);
      }
      return;
    }
    await this.decide(clock.nyDate);
  }

  private async decide(date: string): Promise<void> {
    const rows = this.prep!.rows;
    const px = await this.prices(rows.map((r) => r.symbol));
    const inputs: XsInput[] = rows.flatMap((r) => (px[r.symbol] ? [{ ...r, ...px[r.symbol] }] : []));
    const basket = selectBasket(inputs, this.p);
    const day: XsDay = { date, decidedAt: this.now(), legs: [], done: false };
    this.s.days.push(day);
    if (!basket.length) {
      day.done = true; day.pnl = 0; day.r = 0;
      this.log('לא היו מספיק מניות מתאימות היום. אין עסקאות (היום נספר כאפס)');
      return;
    }
    this.log(`ההחלטה: קנייה ${basket.filter((b) => b.side === 'long').map((b) => b.symbol).join(', ')} · שורט ${basket.filter((b) => b.side === 'short').map((b) => b.symbol).join(', ')}`);
    for (const b of basket) {
      const leg: XsLeg = { symbol: b.symbol, side: b.side, qty: b.qty, score: round2(b.score), decisionPx: b.px };
      day.legs.push(leg);
      try {
        await this.svc.addSymbol(b.symbol);
        const order = await this.svc.submitOrder({
          symbol: b.symbol, side: b.side === 'long' ? 'buy' : 'sell', qty: b.qty, type: 'market', tif: 'day',
          clientOrderId: `xs-${date}-${b.symbol}`,
        });
        leg.orderId = order.id;
        if (order.status === 'rejected') leg.note = `נדחתה: ${order.rejectReason}`;
      } catch (err) {
        leg.note = `לא נשלחה: ${(err as Error).message}`;
      }
      this.log(`${b.symbol}: ${b.side === 'long' ? 'קנייה' : 'שורט'} ${b.qty} מניות סביב ${b.px}${leg.note ? ` — ${leg.note}` : ''}`);
    }
    this.changed();
  }

  /** After the close (or once the positions are flat), record each open day's net result. */
  private async settle(): Promise<void> {
    const open = this.s.days.filter((d) => !d.done && d.legs.length);
    if (!open.length) return;
    const clock = this.svc.clock.state();
    const orders = await this.svc.broker.getOrders('all');
    const positions = await this.svc.broker.getPositions();
    let touched = false;
    for (const day of open) {
      for (const leg of day.legs) {
        const o = leg.orderId ? orders.find((x) => x.id === leg.orderId) : undefined;
        if (o && o.filledQty > 0 && leg.fillPx === undefined) { leg.fillPx = o.avgFillPrice; touched = true; }
      }
      const stillOpen = day.legs.some((l) => positions.some((p) => p.symbol === l.symbol && p.qty !== 0));
      const finished = day.date < clock.nyDate || (!stillOpen && (clock.minutesToClose ?? 0) <= 5) || !clock.isOpen;
      if (!finished || stillOpen) continue;
      const journal = buildJournal((await this.svc.broker.getFills()).reverse(), orders);
      let total = 0;
      for (const leg of day.legs) {
        const t = journal.trades.find((x) => x.symbol === leg.symbol && !x.open && x.openedAt >= day.decidedAt - 60_000 && x.openedAt < day.decidedAt + 6.5 * 3600_000);
        leg.pnl = t ? round2(t.netPnl) : 0;
        total += leg.pnl;
      }
      day.done = true;
      day.pnl = round2(total);
      day.r = round2(total / this.p.riskPerLeg);
      touched = true;
      this.log(`יום ${day.date} הסתיים: ${total >= 0 ? 'רווח' : 'הפסד'} של $${Math.abs(total).toFixed(2)} נטו (${day.r}R)`);
      this.checkStop();
    }
    if (touched) this.changed();
  }

  private checkStop(): void {
    let cum = 0, peak = 0, dd = 0;
    const done = this.s.days.filter((d) => d.done);
    for (const d of done) { cum += d.r ?? 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
    if (dd <= -this.p.maxDrawdownR && !this.s.halted) {
      this.s.halted = `ירידה של ${round2(-dd)}R מהשיא (הגבול שנקבע מראש: ${this.p.maxDrawdownR}R)`;
      this.s.enabled = false;
      this.log(`הבדיקה נעצרה אוטומטית: ${this.s.halted}`);
    }
    if (done.length === this.p.evalDays) this.log(`הושלמו ${done.length} ימי מסחר. התוצאה: ${this.verdict(done.length, cum)}`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
