import { useState } from 'react';
import { api, type BotStatus } from '../api';
import { price, signed } from '../format';

const time = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const STATE: Record<string, string> = { waiting: 'ממתינה לפריצה', entered: 'בעסקה', skipped: 'דולגה', closed: 'העסקה נסגרה' };

/** Control and live status of the opening-range breakout robot. */
export function BotPanel({ status, onSelect }: { status?: BotStatus; onSelect: (s: string) => void }) {
  const [error, setError] = useState<string>();
  if (!status) return <div className="muted pad">טוען…</div>;
  const p = status.params;
  const toggle = () => api.setBot(!status.enabled).then(() => setError(undefined)).catch((e) => setError(e.message));

  return (
    <div className="bot">
      <div className="bot-head">
        <button className={status.enabled ? 'danger' : 'buy-btn'} disabled={!status.available} onClick={toggle}>
          {status.enabled ? 'כבה רובוט' : 'הפעל רובוט'}
        </button>
        <div>
          <b>{status.phase}</b>
          <div className="muted small">
            היום: {status.trades}/{p.maxTrades} עסקאות · {status.losses}/{p.maxLosses} הפסדים
          </div>
        </div>
        {error && <span className="down small">{error}</span>}
      </div>

      <div className="muted small pad">
        האסטרטגיה: פריצת טווח הפתיחה. ב-{status.times.select} שעון ישראל הרובוט בוחר עד {p.candidates} מניות במחיר ${p.minPrice}–${p.maxPrice},
        עם פער פתיחה של {p.minGapPct}% ומעלה, בלי קרנות ממונפות. נכנס כשנר של {p.barMinutes} דקות נסגר מחוץ לטווח של
        {' '}{p.orMinutes} הדקות הראשונות, בכיוון של הממוצע המשוקלל. סטופ בצד השני של הטווח (באמצע אם הטווח רחב מ-{p.wideRangePct}%),
        סיכון ${p.riskPerTrade}, יעד פי {p.rr}, סטופ לנקודת הכניסה ברווח של פי {p.breakevenAtR}. עד {p.maxTrades} עסקאות,
        עוצר אחרי {p.maxLosses} הפסדים, בלי כניסות אחרי {status.times.lastEntry}. הכול נסגר 5 דקות לפני סוף המסחר. פועל רק בחשבון התרגול.
      </div>

      <div className="bot-grid">
        <div>
          <div className="section-title">המניות של היום</div>
          <table>
            <thead><tr><th>מניה</th><th>פער פתיחה</th><th>טווח פתיחה</th><th>מצב</th><th>תוצאה</th></tr></thead>
            <tbody>
              {status.candidates.map((c) => (
                <tr key={c.symbol} onClick={() => onSelect(c.symbol)}>
                  <td className="sym"><b>{c.symbol}</b><div className="co">{c.name}</div></td>
                  <td className={c.gapPct > 0 ? 'up' : 'down'}>{`⁦${c.gapPct > 0 ? '+' : ''}${c.gapPct}%⁩`}</td>
                  <td>{c.range ? `${price(c.range.low)} – ${price(c.range.high)}` : '—'}</td>
                  <td title={c.note}>
                    {STATE[c.state] ?? c.state}{c.side ? ` (${c.side === 'long' ? 'לונג' : 'שורט'})` : ''}
                    {c.note && <div className="muted small">{c.note}</div>}
                  </td>
                  <td className={c.result === undefined ? '' : c.result >= 0 ? 'up' : 'down'}>{c.result === undefined ? '—' : signed(c.result)}</td>
                </tr>
              ))}
              {status.candidates.length === 0 && <tr><td colSpan={5} className="muted">המניות ייבחרו ב-{status.times.select} שעון ישראל, אחרי טווח הפתיחה</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <div className="section-title">יומן הרובוט</div>
          <div className="bot-log">
            {status.log.map((l, i) => (
              <div key={i}><span className="muted">{time.format(new Date(l.ts))}</span> {l.msg}</div>
            ))}
            {status.log.length === 0 && <div className="muted">עדיין אין פעולות</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
