import { useEffect, useState } from 'react';
import { roundTripCost } from '../../../server/src/broker/fees';
import { api, type OrderRequest } from '../api';
import { money, price } from '../format';
import { ORDER_TYPE, SIDE, STATUS } from '../he';
import type { Account, Position, PublicSettings, Quote } from '../store';

type OrderType = OrderRequest['type'];

interface Props {
  symbol: string;
  quote?: Quote;
  position?: Position;
  account?: Account;
  settings?: PublicSettings;
  pickedPrice?: { value: number; seq: number };
}

const parse = (s: string) => (s.trim() === '' ? undefined : Number(s));
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function OrderTicket({ symbol, quote, position, account, settings, pickedPrice }: Props) {
  const maxRisk = settings?.risk.maxRiskPerTrade ?? 0;
  const stopRequired = maxRisk > 0;

  const [qty, setQty] = useState('100');
  const [type, setType] = useState<OrderType>('limit');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [tif, setTif] = useState<'day' | 'gtc'>('day');
  const [bracket, setBracket] = useState(true);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [riskUsd, setRiskUsd] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  // Default the sizing input to the account's risk-per-trade limit once settings arrive.
  useEffect(() => {
    if (maxRisk > 0) setRiskUsd((v) => v || String(maxRisk));
  }, [maxRisk]);

  // Reset prices when switching symbols so we never submit another symbol's levels.
  useEffect(() => {
    setLimit(''); setStop(''); setTp(''); setSl(''); setResult(undefined);
  }, [symbol]);

  // Clicking the chart fills the most relevant empty price field.
  useEffect(() => {
    if (!pickedPrice) return;
    const v = r2(pickedPrice.value);
    if (type === 'stop' || type === 'stop_limit') setStop(v);
    else setLimit(v);
  }, [pickedPrice]);

  const mid = quote ? (quote.bid + quote.ask) / 2 : undefined;
  const needsLimit = type === 'limit' || type === 'stop_limit';
  const needsStop = type === 'stop' || type === 'stop_limit';
  const useBracket = bracket || stopRequired;

  const slN = parse(sl);
  const tpN = parse(tp);
  // Direction follows the stop-loss when one is set (stop below entry = long), otherwise assume long.
  const explicitEntry = parse(needsLimit ? limit : '') ?? parse(needsStop ? stop : '');
  const longGuess = slN === undefined || mid === undefined || slN < (explicitEntry ?? mid);
  const entry = explicitEntry ?? (longGuess ? quote?.ask : quote?.bid) ?? mid;

  const q = Number(qty) || 0;
  const fees = settings?.fees && entry ? roundTripCost(q, entry, settings.fees) : 0;
  const riskPerShare = useBracket && entry !== undefined && slN !== undefined ? Math.abs(entry - slN) : undefined;
  const rewardPerShare = useBracket && entry !== undefined && tpN !== undefined ? Math.abs(tpN - entry) : undefined;
  const priceRisk = riskPerShare !== undefined ? riskPerShare * q : undefined;
  const totalRisk = priceRisk !== undefined ? priceRisk + fees : undefined;
  const netReward = rewardPerShare !== undefined ? rewardPerShare * q - fees : undefined;
  const overLimit = stopRequired && priceRisk !== undefined && priceRisk > maxRisk + 1e-6;

  const sizeFromRisk = () => {
    if (!riskPerShare || !entry) return;
    let budget = Number(riskUsd);
    if (stopRequired) budget = Math.min(budget, maxRisk);
    // Largest size whose loss to the stop, plus round-trip fees, stays inside the budget.
    let n = Math.floor(budget / riskPerShare);
    while (n > 0 && n * riskPerShare + (settings?.fees ? roundTripCost(n, entry, settings.fees) : 0) > budget) n--;
    // ...and never more than the order/position caps or buying power allow.
    const r = settings?.risk;
    const held = Math.abs(position?.qty ?? 0) * entry;
    const caps: [number, string][] = [
      [r?.maxOrderNotional || Infinity, 'גודל פקודה מקסימלי'],
      [r?.maxPositionNotional ? r.maxPositionNotional - held : Infinity, 'גודל פוזיציה מקסימלי'],
      [account?.buyingPower ?? Infinity, 'כוח הקנייה'],
    ];
    let capped: string | undefined;
    for (const [value, label] of caps) {
      const maxShares = Math.floor(Math.max(0, value) / entry);
      if (maxShares < n) { n = maxShares; capped = label; }
    }
    if (n > 0) setQty(String(n));
    setResult(capped ? { ok: true, text: `הכמות הוגבלה ל-${n} מניות בגלל ${capped}` } : undefined);
  };

  const submit = async (side: 'buy' | 'sell') => {
    const req: OrderRequest = { symbol, side, qty: Math.floor(q), type, tif };
    if (needsLimit) req.limitPrice = parse(limit);
    if (needsStop) req.stopPrice = parse(stop);
    if (useBracket) {
      if (tpN !== undefined) req.takeProfit = { limitPrice: tpN };
      if (slN !== undefined) req.stopLoss = { stopPrice: slN };
    }
    setBusy(true);
    try {
      const o = await api.submit(req);
      setResult(o.status === 'rejected'
        ? { ok: false, text: o.rejectReason ?? 'הפקודה נדחתה' }
        : { ok: true, text: `${SIDE[side]} ${o.qty} ${symbol}: ${STATUS[o.status]}${o.filledQty ? ` במחיר ${price(o.avgFillPrice)}` : ''}` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Quick-set bracket levels a number of cents from the entry. Long: TP above, SL below; short: mirrored.
  const offset = (field: 'tp' | 'sl', cents: number, long: boolean) => {
    if (entry === undefined) return;
    const dir = (field === 'tp' ? 1 : -1) * (long ? 1 : -1);
    (field === 'tp' ? setTp : setSl)(r2(entry + (dir * cents) / 100));
  };

  return (
    <div className="panel ticket">
      <div className="panel-title">פקודה: {symbol}</div>
      <div className="quote-strip">
        <span>ביקוש <b className="down">{price(quote?.bid)}</b> × {quote?.bidSize ?? '—'}</span>
        <span>היצע <b className="up">{price(quote?.ask)}</b> × {quote?.askSize ?? '—'}</span>
      </div>
      {position && position.qty !== 0 && (
        <div className="muted small">פוזיציה: {position.qty} מניות במחיר {price(position.avgPrice)}</div>
      )}

      <div className="seg">
        {(['market', 'limit', 'stop', 'stop_limit'] as OrderType[]).map((t) => (
          <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{ORDER_TYPE[t]}</button>
        ))}
      </div>

      <label>כמות מניות
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      {needsStop && (
        <label>מחיר הפעלת סטופ
          <input type="number" step={0.01} value={stop} placeholder={price(quote?.last)} onChange={(e) => setStop(e.target.value)} />
        </label>
      )}
      {needsLimit && (
        <label>מחיר לימיט
          <input type="number" step={0.01} value={limit} placeholder={price(mid)} onChange={(e) => setLimit(e.target.value)} />
        </label>
      )}
      <label>תוקף הפקודה
        <select value={tif} onChange={(e) => setTif(e.target.value as 'day' | 'gtc')}>
          <option value="day">עד סוף היום</option>
          <option value="gtc">עד ביטול</option>
        </select>
      </label>

      <label className="check">
        <input type="checkbox" checked={useBracket} disabled={stopRequired} onChange={(e) => setBracket(e.target.checked)} />
        יעד רווח וסטופ{stopRequired && <span className="muted small"> (סטופ חובה)</span>}
      </label>
      {useBracket && (
        <div className="bracket">
          <label>יעד רווח: מחיר למימוש הרווח
            <input type="number" step={0.01} value={tp} onChange={(e) => setTp(e.target.value)} />
          </label>
          <div className="chips">
            {[10, 25, 50, 100].map((c) => <button key={c} title="לונג" onClick={() => offset('tp', c, true)}>+{c}¢</button>)}
          </div>
          <label>סטופ: מחיר ליציאה בהפסד
            <input type="number" step={0.01} value={sl} onChange={(e) => setSl(e.target.value)} />
          </label>
          <div className="chips">
            {[10, 25, 50, 100].map((c) => <button key={c} title="לונג" onClick={() => offset('sl', c, true)}>−{c}¢</button>)}
          </div>
          <div className="chips">
            <button onClick={() => { offset('tp', 50, false); offset('sl', 25, false); }}>לשורט: יעד 50¢ מתחת, סטופ 25¢ מעל</button>
          </div>
          <div className="risk-row">
            <label>סיכון בדולרים{stopRequired ? ` (עד ${maxRisk})` : ''}
              <input type="number" value={riskUsd} onChange={(e) => setRiskUsd(e.target.value)} />
            </label>
            <button onClick={sizeFromRisk} disabled={!riskPerShare}>חשב כמות</button>
          </div>
        </div>
      )}

      <dl className="stats">
        <dt>שווי משוער</dt><dd>{entry ? money(q * entry) : '—'}</dd>
        <dt>עמלות קנייה ומכירה</dt><dd>{settings?.fees ? money(fees) : '—'}</dd>
        <dt>כוח קנייה</dt><dd>{money(account?.buyingPower)}</dd>
        {totalRisk !== undefined && <><dt>סיכון כולל עמלות</dt><dd className="down">{money(totalRisk)}</dd></>}
        {netReward !== undefined && <><dt>רווח אחרי עמלות</dt><dd className="up">{money(netReward)}</dd></>}
        {totalRisk && netReward !== undefined ? <><dt>יחס סיכון לרווח</dt><dd>1 : {(netReward / totalRisk).toFixed(2)}</dd></> : null}
      </dl>
      {overLimit && <div className="result err">הסיכון עד הסטופ ({money(priceRisk)}) גבוה מהמגבלה של {money(maxRisk)}. לחץ על "חשב כמות".</div>}

      <div className="actions">
        <button className="buy" disabled={busy || q <= 0} onClick={() => submit('buy')}>קנייה</button>
        <button className="sell" disabled={busy || q <= 0} onClick={() => submit('sell')}>מכירה</button>
      </div>
      {result && <div className={`result ${result.ok ? 'ok' : 'err'}`}>{result.text}</div>}
      <div className="muted small">טיפ: לחיצה על הגרף ממלאת את המחיר.</div>
    </div>
  );
}
