import { useEffect, useState } from 'react';
import { api, type ScanFilter, type ScanRow } from '../api';
import { price } from '../format';
import { usePref } from '../prefs';

const pct = (n: number) => `⁦${n > 0 ? '+' : ''}${n.toFixed(1)}%⁩`;
const vol = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} מ׳` : `${Math.round(v / 1e3)} א׳`);

interface Form {
  minPrice: string;
  maxPrice: string;
  minVolumeM: string;
  minChangePct: string;
  minGapPct: string;
  direction: 'any' | 'up' | 'down';
  sort: 'change' | 'gap' | 'volume';
}

const DEFAULT_FORM: Form = { minPrice: '2', maxPrice: '', minVolumeM: '1', minChangePct: '3', minGapPct: '', direction: 'any', sort: 'change' };

/** Filters the day's ~200 most active stocks. Re-runs every minute while open. */
export function Scanner({ onPick }: { onPick: (symbol: string) => void }) {
  const [form, setForm] = usePref<Form>('scanner.form', DEFAULT_FORM);
  const [rows, setRows] = useState<ScanRow[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = () => {
    const n = (s: string) => (s.trim() === '' ? undefined : Number(s));
    const f: ScanFilter = {
      minPrice: n(form.minPrice), maxPrice: n(form.maxPrice),
      minVolume: n(form.minVolumeM) === undefined ? undefined : n(form.minVolumeM)! * 1e6,
      minChangePct: n(form.minChangePct), minGapPct: n(form.minGapPct), direction: form.direction, sort: form.sort,
    };
    setBusy(true);
    api.scan(f).then((r) => { setRows(r); setError(undefined); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  useEffect(() => {
    run();
    const t = setInterval(run, 60_000);
    return () => clearInterval(t);
  }, [JSON.stringify(form)]);

  const field = (k: keyof Form, label: string, ph = '') => (
    <label>{label}<input type="number" value={form[k]} placeholder={ph} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
  );

  return (
    <div className="table-wrap scanner">
      <div className="scan-form">
        {field('minPrice', 'מחיר מ-$')}
        {field('maxPrice', 'עד $', 'ללא')}
        {field('minVolumeM', 'מחזור מינ׳ (מיליון מניות)')}
        {field('minChangePct', 'שינוי היום מינ׳ %')}
        {field('minGapPct', 'פער פתיחה מינ׳ %', 'ללא')}
        <label>כיוון
          <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Form['direction'] })}>
            <option value="any">הכל</option><option value="up">עולות</option><option value="down">יורדות</option>
          </select>
        </label>
        <label>מיון לפי
          <select value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value as Form['sort'] })}>
            <option value="change">שינוי היום</option><option value="gap">פער פתיחה</option><option value="volume">מחזור</option>
          </select>
        </label>
        <button className="sm" onClick={() => setForm(DEFAULT_FORM)}>איפוס</button>
      </div>
      {error && <div className="muted pad">{error}</div>}
      <table>
        <thead><tr><th>מניה</th><th>מחיר</th><th>שינוי</th><th>פער</th><th>מחזור</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.symbol} onClick={() => onPick(r.symbol)} title="לחץ להוספה לרשימת המעקב">
              <td className="sym"><b>{r.symbol}</b><div className="co" title={r.name}>{r.name}</div></td>
              <td>{price(r.price)}</td>
              <td className={r.changePct > 0 ? 'up' : 'down'}>{pct(r.changePct)}</td>
              <td className={r.gapPct > 0 ? 'up' : r.gapPct < 0 ? 'down' : ''}>{pct(r.gapPct)}</td>
              <td>{vol(r.volume)}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={5} className="muted">אין מניות שעומדות בתנאים</td></tr>}
          {!rows && !error && <tr><td colSpan={5} className="muted">{busy ? 'סורק…' : ''}</td></tr>}
        </tbody>
      </table>
      <div className="muted small pad">סורק את כ-200 המניות הנסחרות ביותר היום. מתעדכן כל דקה.</div>
    </div>
  );
}
