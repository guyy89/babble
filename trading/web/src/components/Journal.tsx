import { useEffect, useState } from 'react';
import { api, type Journal as JournalData } from '../api';
import { money, pnlClass, price, signed } from '../format';

const nyDateTime = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} דק׳` : `${Math.floor(m / 60)} ש׳ ${m % 60} דק׳`;
};

/** Trade journal and statistics, rebuilt on the server from the fill history. Reloads when fills change. */
export function Journal({ refreshKey, onSelect }: { refreshKey: string; onSelect: (s: string) => void }) {
  const [data, setData] = useState<JournalData>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.journal().then((j) => { setData(j); setError(undefined); }).catch((e) => setError(e.message));
  }, [refreshKey]);

  if (error) return <div className="muted pad">{error}</div>;
  if (!data) return <div className="muted pad">טוען…</div>;
  const s = data.stats;

  return (
    <div className="journal">
      <div className="cards">
        <Card label="עסקאות סגורות" value={String(s.trades)} />
        <Card label="אחוז הצלחה" value={s.trades ? pct(s.winRate) : '—'} hint={`${s.wins} רווח · ${s.losses} הפסד`} />
        <Card label="רווח נקי" value={signed(s.netPnl)} cls={pnlClass(s.netPnl)} hint={`לפני עמלות ${signed(s.grossPnl)}`} />
        <Card label="עמלות ששולמו" value={money(s.costs)} />
        <Card label="רווח ממוצע" value={s.wins ? money(s.avgWin) : '—'} cls="up" />
        <Card label="הפסד ממוצע" value={s.losses ? money(s.avgLoss) : '—'} cls="down" />
        <Card label="יחס רווח להפסד" value={s.trades ? (s.profitFactor === null || !Number.isFinite(s.profitFactor) ? '∞' : s.profitFactor.toFixed(2)) : '—'}
          hint="סך הרווחים חלקי סך ההפסדים. מעל 1 = מרוויח" />
        <Card label="תוחלת לעסקה" value={s.trades ? signed(s.expectancy) : '—'} cls={pnlClass(s.expectancy)} hint="כמה מרוויחים בממוצע על כל עסקה" />
        <Card label="ממוצע ביחידות סיכון" value={s.avgR === undefined || s.avgR === null ? '—' : `${s.avgR > 0 ? '+' : ''}${s.avgR}`}
          hint="רווח העסקה חלקי הסיכון שתכננת עד הסטופ" />
      </div>
      {s.trades === 0 && <div className="muted pad">עדיין אין עסקאות סגורות. היומן מתמלא אוטומטית מכל קנייה ומכירה.</div>}
      <div className="journal-grid">
        <div>
          <div className="section-title">עסקאות</div>
          <table>
            <thead><tr><th>מניה</th><th>כיוון</th><th>כניסה</th><th>מחיר כניסה</th><th>מחיר יציאה</th><th>כמות</th><th>משך</th><th>עמלות</th><th>רווח נקי</th><th>יחידות סיכון</th></tr></thead>
            <tbody>
              {data.trades.map((t, i) => (
                <tr key={i} onClick={() => onSelect(t.symbol)}>
                  <td><b>{t.symbol}</b></td>
                  <td className={t.direction === 'long' ? 'up' : 'down'}>{t.direction === 'long' ? 'לונג' : 'שורט'}</td>
                  <td>{nyDateTime.format(new Date(t.openedAt))}</td>
                  <td>{price(t.avgEntry)}</td>
                  <td>{t.open ? 'פתוחה' : price(t.avgExit)}</td>
                  <td>{t.maxQty}</td>
                  <td>{t.closedAt ? duration(t.closedAt - t.openedAt) : '—'}</td>
                  <td>{money(t.costs)}</td>
                  <td className={pnlClass(t.netPnl)}>{t.open ? '—' : signed(t.netPnl)}</td>
                  <td>{t.r === undefined ? '—' : `${t.r > 0 ? '+' : ''}${t.r}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <BucketTable title="לפי שעה (שעון ניו יורק)" rows={data.byHour} />
        <BucketTable title="לפי מניה" rows={data.bySymbol} />
        <BucketTable title="לפי יום" rows={data.byDay} />
      </div>
    </div>
  );
}

function Card({ label, value, cls = '', hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="card" title={hint}>
      <span>{label}</span>
      <b className={cls}>{value}</b>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: JournalData['byHour'] }) {
  return (
    <div>
      <div className="section-title">{title}</div>
      <table>
        <thead><tr><th>{title.startsWith('לפי שעה') ? 'שעה' : title.startsWith('לפי מניה') ? 'מניה' : 'תאריך'}</th><th>עסקאות</th><th>הצלחה</th><th>רווח נקי</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td><td>{r.trades}</td><td>{pct(r.wins / r.trades)}</td>
              <td className={pnlClass(r.netPnl)}>{signed(r.netPnl)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">אין נתונים</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
