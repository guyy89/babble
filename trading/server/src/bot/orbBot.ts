import { EventEmitter } from 'node:events';
import type { StateStore } from '../broker/stateStore.js';
import { buildJournal } from '../journal.js';
import {
  breakout, completedBars, israelTime, nyMinute, OPEN_MINUTE, openingRange, planTrade, selectCandidates, sessionBars,
  type CandidateInput, type OrbParams, type Range, type Side,
} from '../strategy/orb.js';
import type { TradingService } from '../tradingService.js';

type CandState = 'waiting' | 'entered' | 'skipped' | 'closed';

export interface BotCandidate {
  symbol: string;
  name: string;
  gapPct: number;
  range?: Range;
  state: CandState;
  side?: Side;
  note?: string;
  /** NY minute of the last 5-minute bar already evaluated. */
  lastBar?: number;
  enteredAt?: number;
  breakevenDone?: boolean;
  result?: number;
}

export interface BotState {
  enabled: boolean;
  date: string;
  selected: boolean;
  candidates: BotCandidate[];
  trades: number;
  losses: number;
  log: { ts: number; msg: string }[];
}

export interface BotStatus extends BotState {
  phase: string;
  /** Today's key times in Israel time: open, selection, last entry. */
  times: { open: string; select: string; lastEntry: string };
  params: OrbParams;
  available: boolean;
  unavailableReason?: string;
}

const LOG_KEEP = 200;

/**
 * Runs the opening-range breakout on the paper account, with exactly the rules the backtest uses
 * (strategy/orb.ts). It only trades through TradingService, so every risk limit still applies.
 */
export class OrbBot extends EventEmitter {
  private s: BotState;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private selectFailures = 0;

  constructor(
    private readonly svc: TradingService,
    private readonly universe: () => Promise<CandidateInput[]>,
    private readonly params: OrbParams,
    private readonly store?: StateStore<BotState>,
    /** Why the robot can't run here (e.g. simulated data or a live broker), if it can't. */
    private readonly unavailable?: string,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.s = store?.load() ?? { enabled: false, date: '', selected: false, candidates: [], trades: 0, losses: 0, log: [] };
  }

  /** intervalMs: how often to act, in real time (every 5 s live; faster in a sped-up replay). */
  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.store?.save(this.s, true);
  }

  status(): BotStatus {
    const t = this.now();
    const times = {
      open: israelTime(OPEN_MINUTE, t), select: israelTime(OPEN_MINUTE + this.params.orMinutes, t), lastEntry: israelTime(this.params.lastEntryMinute, t),
    };
    return { ...this.s, phase: this.phase(), times, params: this.params, available: !this.unavailable, unavailableReason: this.unavailable };
  }

  setEnabled(on: boolean): void {
    if (on && this.unavailable) throw new Error(this.unavailable);
    if (this.s.enabled === on) return;
    this.s.enabled = on;
    this.log(on ? 'הרובוט הופעל' : 'הרובוט כובה. פוזיציות פתוחות נשארות עם הסטופ והיעד שלהן');
    void this.tick();
  }

  private phase(): string {
    if (this.unavailable) return this.unavailable;
    if (!this.s.enabled) return 'כבוי';
    const clock = this.svc.clock.state();
    if (!clock.isOpen) return `ממתין לפתיחת המסחר (${israelTime(OPEN_MINUTE, this.now())} שעון ישראל)`;
    const m = nyMinute(this.now());
    if (m < OPEN_MINUTE + this.params.orMinutes) return `אוסף את טווח הפתיחה (עד ${israelTime(OPEN_MINUTE + this.params.orMinutes, this.now())})`;
    if (!this.s.selected) return 'בוחר מניות…';
    if (this.s.losses >= this.params.maxLosses) return `נעצר להיום אחרי ${this.s.losses} הפסדים`;
    if (this.s.trades >= this.params.maxTrades) return `ביצע ${this.s.trades} עסקאות, המקסימום להיום`;
    if (m > this.params.lastEntryMinute) return `אחרי ${israelTime(this.params.lastEntryMinute, this.now())}: אין כניסות חדשות, רק ניהול פוזיציות`;
    return 'עוקב אחרי פריצות';
  }

  private log(msg: string): void {
    this.s.log.unshift({ ts: this.now(), msg });
    if (this.s.log.length > LOG_KEEP) this.s.log.length = LOG_KEEP;
    this.changed();
  }

  private changed(): void {
    this.store?.save(this.s);
    this.emit('status', this.status());
  }

  /** One step of the robot (runs every 5 seconds; public for tests). */
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
    const clock = this.svc.clock.state();
    if (this.s.date !== clock.nyDate) {
      const keep = this.s.enabled;
      this.s = { enabled: keep, date: clock.nyDate, selected: false, candidates: [], trades: 0, losses: 0, log: this.s.log };
      this.selectFailures = 0;
      this.changed();
    }
    if (!this.s.enabled || this.unavailable || !clock.isOpen) return;
    const minute = nyMinute(this.now());
    if (minute < OPEN_MINUTE + this.params.orMinutes) return;

    if (!this.s.selected) await this.select();
    if (!this.s.selected) return;

    await this.trackResults();
    await this.manageBreakeven();
    if (minute > this.params.lastEntryMinute || this.s.trades >= this.params.maxTrades || this.s.losses >= this.params.maxLosses) return;

    for (const c of this.s.candidates) {
      if (c.state !== 'waiting') continue;
      if (this.s.trades >= this.params.maxTrades || this.s.losses >= this.params.maxLosses) break;
      const session = sessionBars(this.svc.feed.getBars(c.symbol), clock.nyDate);
      c.range ??= openingRange(session, this.params, minute);
      if (!c.range) continue;
      const last = completedBars(session, this.params, minute).at(-1);
      if (!last || last.endMinute === c.lastBar) continue;
      c.lastBar = last.endMinute;
      // Act only on a bar that just closed; never on a breakout from earlier in the day (e.g. after a restart).
      if (minute - last.endMinute > 1) continue;
      const side = breakout(last, c.range);
      if (!side) continue;
      await this.enter(c, side);
    }
    this.changed();
  }

  private async select(): Promise<void> {
    if (this.selectFailures >= 5) return;
    try {
      const rows = await this.universe();
      const picked = selectCandidates(rows, this.params);
      this.s.candidates = picked.map((p) => ({ symbol: p.symbol, name: p.name, gapPct: Math.round(p.gapPct * 10) / 10, state: 'waiting' }));
      this.s.selected = true;
      this.log(picked.length
        ? `נבחרו ${picked.length} מניות: ${picked.map((p) => `${p.symbol} (${p.gapPct > 0 ? '+' : ''}${p.gapPct.toFixed(1)}%)`).join(', ')}`
        : 'אף מניה לא עמדה בכללים היום. אין עסקאות.');
      for (const p of picked) {
        try {
          await this.svc.addSymbol(p.symbol);
        } catch (err) {
          const c = this.s.candidates.find((x) => x.symbol === p.symbol)!;
          c.state = 'skipped';
          c.note = `לא נטענו נתונים: ${(err as Error).message}`;
        }
      }
    } catch (err) {
      this.selectFailures++;
      this.log(`בחירת המניות נכשלה (ניסיון ${this.selectFailures}/5): ${(err as Error).message}`);
    }
  }

  private async enter(c: BotCandidate, side: Side): Promise<void> {
    const q = this.svc.feed.getQuote(c.symbol);
    if (!q) return;
    const ref = side === 'long' ? q.ask : q.bid;
    const plan = planTrade(side, ref, c.range!, this.params);
    if (!plan) {
      c.state = 'skipped';
      c.note = 'הטווח צר מדי לחישוב כמות';
      this.log(`${c.symbol}: פריצה, אבל אי אפשר לחשב כמות. מדלג`);
      return;
    }
    const order = await this.svc.submitOrder({
      symbol: c.symbol, side: side === 'long' ? 'buy' : 'sell', qty: plan.qty, type: 'market', tif: 'day',
      stopLoss: { stopPrice: plan.stop }, takeProfit: { limitPrice: plan.target }, clientOrderId: `orb-${this.s.date}-${c.symbol}`,
    });
    if (order.status === 'rejected') {
      c.state = 'skipped';
      c.note = order.rejectReason;
      this.log(`${c.symbol}: הכניסה נדחתה: ${order.rejectReason}`);
      return;
    }
    c.state = 'entered';
    c.side = side;
    c.enteredAt = this.now();
    this.s.trades++;
    this.log(`${c.symbol}: ${side === 'long' ? 'קנייה' : 'שורט'} ${plan.qty} מניות סביב ${ref}. סטופ ${plan.stop}, יעד ${plan.target}`);
  }

  /** Once price reaches 1R in our favour, move the stop to the entry price. */
  private async manageBreakeven(): Promise<void> {
    const positions = await this.svc.broker.getPositions();
    const open = await this.svc.broker.getOrders('open');
    for (const c of this.s.candidates) {
      if (c.state !== 'entered' || c.breakevenDone) continue;
      const pos = positions.find((p) => p.symbol === c.symbol && p.qty !== 0);
      const q = this.svc.feed.getQuote(c.symbol);
      if (!pos || !q || !c.range) continue;
      const stopLeg = open.find((o) => o.symbol === c.symbol && o.type === 'stop' && !o.triggered);
      if (!stopLeg?.stopPrice) continue;
      const risk = Math.abs(pos.avgPrice - stopLeg.stopPrice);
      const long = pos.qty > 0;
      const reached = long ? q.bid >= pos.avgPrice + risk * this.params.breakevenAtR : q.ask <= pos.avgPrice - risk * this.params.breakevenAtR;
      if (!reached) continue;
      const be = Math.round(pos.avgPrice * 100) / 100;
      try {
        await this.svc.broker.modifyOrder(stopLeg.id, { stopPrice: be });
        c.breakevenDone = true;
        this.log(`${c.symbol}: הרווח הגיע לגובה הסיכון, הסטופ הועבר לנקודת הכניסה (${be})`);
      } catch (err) {
        this.log(`${c.symbol}: לא הצלחתי להזיז את הסטופ: ${(err as Error).message}`);
      }
    }
  }

  /** Count finished robot trades as wins/losses (net of costs), from the same journal the UI shows. */
  private async trackResults(): Promise<void> {
    const entered = this.s.candidates.filter((c) => c.state === 'entered');
    if (!entered.length) return;
    const journal = buildJournal(await this.svc.broker.getFills(), await this.svc.broker.getOrders('all'));
    for (const c of entered) {
      const t = journal.trades.find((x) => x.symbol === c.symbol && !x.open && x.openedAt >= (c.enteredAt ?? 0) - 60_000);
      if (!t) continue;
      c.state = 'closed';
      c.result = t.netPnl;
      if (t.netPnl < 0) this.s.losses++;
      this.log(`${c.symbol}: העסקה נסגרה ב-${t.netPnl >= 0 ? 'רווח' : 'הפסד'} של $${Math.abs(t.netPnl).toFixed(2)} אחרי עמלות`);
    }
  }
}
