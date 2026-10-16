// US equities regular-session clock (09:30–16:00 America/New_York, Mon–Fri).
// Exchange holidays and early closes are not modelled; the Alpaca /v2/clock endpoint
// should replace this once a live broker is connected.

export interface ClockState {
  isOpen: boolean;
  nyDate: string; // YYYY-MM-DD in New York
  minutesToClose: number | null;
  alwaysOpen: boolean;
  /** The clock's current time (virtual in replay mode). */
  now: number;
}

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

export function nyParts(now: number) {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday as string,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export class MarketClock {
  constructor(
    private readonly alwaysOpen: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  state(): ClockState {
    const now = this.now();
    const p = nyParts(now);
    if (this.alwaysOpen) return { isOpen: true, nyDate: p.date, minutesToClose: null, alwaysOpen: true, now };
    const weekday = p.weekday !== 'Sat' && p.weekday !== 'Sun';
    const isOpen = weekday && p.minuteOfDay >= OPEN_MIN && p.minuteOfDay < CLOSE_MIN;
    return {
      isOpen,
      nyDate: p.date,
      minutesToClose: isOpen ? CLOSE_MIN - p.minuteOfDay : null,
      alwaysOpen: false,
      now,
    };
  }

  nyDate(): string {
    return nyParts(this.now()).date;
  }
}
