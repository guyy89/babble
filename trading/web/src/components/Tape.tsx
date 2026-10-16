import { useEffect, useState } from 'react';
import { price } from '../format';
import { onTrade, recentTrades, type Quote, type Trade } from '../store';

const time = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Time & sales for one symbol: every print, coloured by where it traded against the quote. */
export function Tape({ symbol, quote }: { symbol?: string; quote?: Quote }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!symbol) return;
    // Re-render at most ~4×/s; the store keeps the list.
    let pending = false;
    const off = onTrade((t) => {
      if (t.symbol !== symbol || pending) return;
      pending = true;
      setTimeout(() => { pending = false; setTick((x) => x + 1); }, 250);
    });
    return () => { off(); };
  }, [symbol]);

  if (!symbol) return <div className="muted pad">בחר מניה</div>;
  const trades = recentTrades(symbol);
  const side = (t: Trade) => (!quote ? '' : t.price >= quote.ask ? 'up' : t.price <= quote.bid ? 'down' : 'muted');

  return (
    <div>
      <div className="muted small pad">
        כל עסקה שבוצעה ב-{symbol}, החדשה למעלה. ירוק = נקנה במחיר ההיצע (קונים לוחצים), אדום = נמכר במחיר הביקוש (מוכרים לוחצים).
        בנתונים החינמיים מופיעות רק העסקאות מבורסה אחת, חלק קטן מכלל המסחר.
      </div>
      <table className="tape">
        <thead><tr><th>שעה</th><th>מחיר</th><th>כמות</th></tr></thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.ts}-${i}`} className={t.size >= 1000 ? 'big' : ''}>
              <td>{time.format(new Date(t.ts))}</td>
              <td className={side(t)}>{price(t.price)}</td>
              <td>{t.size.toLocaleString('en-US')}</td>
            </tr>
          ))}
          {trades.length === 0 && <tr><td colSpan={3} className="muted">ממתין לעסקאות… (מחוץ לשעות המסחר כמעט אין עסקאות)</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
