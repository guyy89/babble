import { useEffect, useState } from 'react';
import { api, type NewsItem } from '../api';

const when = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const translateUrl = (text: string) => `https://translate.google.com/?sl=en&tl=iw&op=translate&text=${encodeURIComponent(text)}`;

/** Latest headlines for the selected symbol. Refreshes every two minutes. */
export function News({ symbol }: { symbol?: string }) {
  const [items, setItems] = useState<NewsItem[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!symbol) return;
    setItems(undefined);
    const load = () => api.news(symbol).then((n) => { setItems(n); setError(undefined); }).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [symbol]);

  if (!symbol) return <div className="muted pad">בחר מניה</div>;
  if (error) return <div className="muted pad">{error}</div>;
  if (!items) return <div className="muted pad">טוען חדשות…</div>;

  return (
    <div className="news">
      <div className="muted small pad">כותרות אחרונות על {symbol} ממקור החדשות (באנגלית, כפי שפורסמו). "תרגום" פותח את הכותרת בתרגום של גוגל.</div>
      {items.length === 0 && <div className="muted pad">אין חדשות אחרונות על {symbol}</div>}
      {items.map((n) => (
        <div key={n.id} className="news-item">
          <span className="muted small">{when.format(new Date(n.ts))}</span>
          <a href={n.url} target="_blank" rel="noreferrer" dir="ltr">{n.headline}</a>
          <a className="small" href={translateUrl(n.headline)} target="_blank" rel="noreferrer">תרגום</a>
        </div>
      ))}
    </div>
  );
}
