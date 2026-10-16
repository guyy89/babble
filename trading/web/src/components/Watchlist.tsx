import { useEffect, useRef, useState } from 'react';
import { api, type Movers, type SymbolInfo } from '../api';
import { price } from '../format';
import type { Position, Quote } from '../store';
import { Scanner } from './Scanner';

interface Props {
  symbols: string[];
  names: Record<string, string>;
  quotes: Record<string, Quote>;
  positions: Position[];
  selected?: string;
  onSelect: (symbol: string) => void;
  onError: (message: string) => void;
}

const pct = (n: number) => `⁦${n > 0 ? '+' : ''}${n.toFixed(2)}%⁩`;

export function Watchlist({ symbols, names, quotes, positions, selected, onSelect, onError }: Props) {
  const [tab, setTab] = useState<'watch' | 'movers' | 'scan'>('watch');

  // Adding subscribes the symbol on the server; select it once it's in the list.
  const open = async (symbol: string) => {
    if (!symbols.includes(symbol)) {
      try {
        await api.watch(symbol);
      } catch (e) {
        return onError((e as Error).message);
      }
    }
    onSelect(symbol);
    setTab('watch');
  };

  return (
    <aside className="panel watchlist">
      <div className="tabs">
        <button className={tab === 'watch' ? 'on' : ''} onClick={() => setTab('watch')}>רשימת מעקב ({symbols.length})</button>
        <button className={tab === 'movers' ? 'on' : ''} onClick={() => setTab('movers')}>זזות היום</button>
        <button className={tab === 'scan' ? 'on' : ''} onClick={() => setTab('scan')}>סורק</button>
      </div>
      <SymbolSearch onPick={open} />
      {tab === 'watch' ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>מניה</th><th>ביקוש</th><th>היצע</th><th>אחרון</th><th /></tr></thead>
            <tbody>
              {symbols.map((s) => {
                const q = quotes[s];
                const pos = positions.find((p) => p.symbol === s && p.qty !== 0);
                return (
                  <tr key={s} className={s === selected ? 'sel' : ''} onClick={() => onSelect(s)}>
                    <td className="sym">
                      <b>{s}</b>{pos && <span className={`dot ${pos.qty > 0 ? 'up' : 'down'}`}>●</span>}
                      <div className="co" title={names[s]}>{names[s]}</div>
                    </td>
                    <td>{price(q?.bid)}</td>
                    <td>{price(q?.ask)}</td>
                    <td>{price(q?.last)}</td>
                    <td>
                      <button className="sm ghost" title="הסר מהרשימה"
                        onClick={(e) => { e.stopPropagation(); api.unwatch(s).catch((err) => onError(err.message)); }}>×</button>
                    </td>
                  </tr>
                );
              })}
              {symbols.length === 0 && <tr><td colSpan={5} className="muted">הרשימה ריקה. חפש מניה למעלה.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : tab === 'movers' ? (
        <MoversView onPick={open} />
      ) : (
        <Scanner onPick={open} />
      )}
    </aside>
  );
}

function SymbolSearch({ onPick }: { onPick: (symbol: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (!query) return setResults([]);
    const id = ++seq.current;
    const t = setTimeout(() => {
      api.search(query).then((r) => { if (id === seq.current) { setResults(r); setActive(0); } }).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (symbol: string) => {
    setQ('');
    setResults([]);
    onPick(symbol);
  };

  return (
    <div className="search">
      <input
        id="symbol-search"
        value={q}
        placeholder="חיפוש מניה: סימול או שם חברה"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && results[active]) pick(results[active].symbol);
          else if (e.key === 'Escape') { setQ(''); setResults([]); }
        }}
      />
      {q.trim() && (
        <div className="search-results">
          {results.map((r, i) => (
            <div key={r.symbol} className={`search-row ${i === active ? 'on' : ''}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(r.symbol); }}>
              <b>{r.symbol}</b>
              <span className="co">{r.name}</span>
              <span className="muted small">{r.exchange}</span>
            </div>
          ))}
          {results.length === 0 && <div className="search-row muted">לא נמצאו מניות</div>}
        </div>
      )}
    </div>
  );
}

function MoversView({ onPick }: { onPick: (symbol: string) => void }) {
  const [data, setData] = useState<Movers>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const load = () => api.movers().then((m) => { setData(m); setError(undefined); }).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="muted pad">{error}</div>;
  if (!data) return <div className="muted pad">טוען…</div>;

  const section = (title: string, rows: Movers['gainers'], showVolume = false) => (
    <>
      <tr className="group"><td colSpan={3}>{title}</td></tr>
      {rows.map((m) => (
        <tr key={title + m.symbol} onClick={() => onPick(m.symbol)} title="לחץ להוספה לרשימת המעקב">
          <td className="sym"><b>{m.symbol}</b><div className="co" title={m.name}>{m.name}</div></td>
          <td>{price(m.price)}</td>
          <td className={m.changePct > 0 ? 'up' : m.changePct < 0 ? 'down' : ''}>
            {pct(m.changePct)}
            {showVolume && m.volume ? <div className="muted small">{(m.volume / 1e6).toFixed(1)} מ׳ מניות</div> : null}
          </td>
        </tr>
      ))}
      {rows.length === 0 && <tr><td colSpan={3} className="muted">אין נתונים</td></tr>}
    </>
  );

  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>מניה</th><th>מחיר</th><th>שינוי היום</th></tr></thead>
        <tbody>
          {section('העולות הגדולות', data.gainers)}
          {section('היורדות הגדולות', data.losers)}
          {section('הכי נסחרות (מחזור)', data.actives, true)}
        </tbody>
      </table>
      <div className="muted small pad">מתעדכן כל דקה. רק מניות רגילות מעל $1 בבורסות המרכזיות.</div>
    </div>
  );
}
