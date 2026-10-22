import { useState } from 'react';
import { api, type XsStatus } from '../api';
import { money, pnlClass, price, signed } from '../format';

const time = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The momentum robot on the main screen: control, today's positions with live P&L, results and log. */
export function XsBotPanel({ status, onSelect }: { status?: XsStatus; onSelect: (s: string) => void }) {
  const [error, setError] = useState<string>();
  if (!status) return <div className="muted pad">טוען…</div>;
  const p = status.params;
  const s = status.summary;
  const toggle = () => api.setXsBot(!status.enabled).then(() => setError(undefined)).catch((e) => setError(e.message));
  const legs = status.today?.legs ?? [];
  const invested = legs.reduce((a, l) => a + (l.invested ?? 0), 0);
  const legsPnl = legs.reduce((a, l) => a + (l.pnl ?? 0), 0);
  // Only the current forward test (Guy: start fresh); earlier tests stay in the state file's archive.
  const history = status.days.filter((d) => d.done).map((d) => ({ ...d, archived: false })).reverse();

  return (
    <div className="bot">
      <div className="bot-head">
        <button className={status.enabled ? 'danger' : 'buy-btn'} disabled={!status.available || (!!status.halted && !status.enabled)} onClick={toggle}>
          {status.enabled ? 'כבה רובוט' : 'הפעל רובוט'}
        </button>
        <div>
          <b>{status.phase}</b>
          <div className="muted small">{s.verdict}</div>
        </div>
        {error && <span className="down small">{error}</span>}
      </div>

      <div className="acct pad">
        <Stat label="רובוט, יום אחרון" value={signed(s.todayPnl)} cls={pnlClass(s.todayPnl)} />
        <Stat label="מצטבר בבדיקה" value={`${signed(s.pnl)} (${s.r >= 0 ? '+' : ''}${s.r}R)`} cls={pnlClass(s.pnl)} />
        <Stat label="ימים בבדיקה" value={`${s.days} / ${p.evalDays}`} />
        <Stat label="ירידה מהשיא" value={`${s.drawdownR}R`} cls={pnlClass(s.drawdownR)} />
      </div>

      <div className="muted small pad">
        כל יום מסחר ב-{status.decisionTime} שעון ישראל: קנייה של {p.K} המניות הנזילות החזקות מהפתיחה ושורט של {p.K} החלשות,
        סיכון ${p.riskPerLeg} למניה, בלי סטופ.{p.dayTakeProfit ? ` כשהרווח היומי נטו מגיע ל-$${p.dayTakeProfit} הכל נסגר;` : ''} אחרת
        סגירה 5 דקות לפני סוף המסחר. סוחר באותו חשבון, והפוזיציות שלו מסומנות "רובוט". החלטה אחרי {p.evalDays} ימים: ‎+{p.confirmR}R ומעלה אושרה, 0 ומטה נכשלה, ירידה
        של {p.maxDrawdownR}R עוצרת.
      </div>

      <div className="bot-grid">
        <div>
          <div className="section-title">
            הפוזיציות {status.today ? `של ${status.today.date.split('-').reverse().slice(0, 2).join('/')}` : ''}
            {status.today?.takeProfit ? ' · נסגרו ביעד הרווח' : status.today?.done ? ' · היום הסתיים' : ''}
          </div>
          <table>
            <thead><tr><th>מניה</th><th>כיוון</th><th>כמות</th><th>מחיר כניסה</th><th>סכום מושקע</th><th>מחיר עכשיו</th><th>רווח/הפסד</th></tr></thead>
            <tbody>
              {legs.map((l) => (
                <tr key={l.symbol} onClick={() => onSelect(l.symbol)} title={l.note}>
                  <td><b>{l.symbol}</b>{l.note && <div className="muted small">{l.note}</div>}</td>
                  <td className={l.side === 'long' ? 'up' : 'down'}>{l.side === 'long' ? 'קנייה' : 'שורט'}</td>
                  <td>{l.qty}</td>
                  <td>{price(l.entry)}</td>
                  <td>{l.invested !== undefined ? money(l.invested) : '—'}</td>
                  <td>{l.open ? price(l.last) : 'נסגרה'}</td>
                  <td className={pnlClass(l.pnl ?? 0)}>{l.pnl === undefined ? '—' : signed(l.pnl)}</td>
                </tr>
              ))}
              {legs.length > 0 && (
                <tr>
                  <td><b>סה"כ</b></td><td /><td /><td />
                  <td><b>{money(invested)}</b></td><td />
                  <td className={pnlClass(legsPnl)}><b>{signed(legsPnl)}</b></td>
                </tr>
              )}
              {legs.length === 0 && <tr><td colSpan={7} className="muted">אין פוזיציות. הכניסה הבאה ב-{status.decisionTime} שעון ישראל ביום מסחר</td></tr>}
            </tbody>
          </table>

          <div className="section-title">תוצאות לפי יום</div>
          <table>
            <thead><tr><th>תאריך</th><th>פוזיציות</th><th>רווח/הפסד נטו</th><th>יחידות סיכון</th><th /></tr></thead>
            <tbody>
              {history.map((d) => (
                <tr key={`${d.date}-${d.archived}`} className={d.archived ? 'muted' : ''}>
                  <td>{d.date.split('-').reverse().join('/')}</td>
                  <td>{d.legs.length}</td>
                  <td className={pnlClass(d.pnl ?? 0)}>{signed(d.pnl ?? 0)}</td>
                  <td className={pnlClass(d.r ?? 0)}>{`${(d.r ?? 0) >= 0 ? '+' : ''}${d.r ?? 0}`}</td>
                  <td className="muted small">{[d.takeProfitAt ? 'יעד רווח' : '', d.archived ? 'לפני האיחוד (לא בספירה)' : ''].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={5} className="muted">עוד אין ימים שהסתיימו</td></tr>}
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

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b className={cls}>{value}</b>
    </div>
  );
}
