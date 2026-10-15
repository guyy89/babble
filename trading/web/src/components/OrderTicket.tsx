import { useEffect, useState } from 'react';
import { api, type OrderRequest } from '../api';
import { money, price } from '../format';
import type { Account, Position, Quote } from '../store';

type OrderType = OrderRequest['type'];

interface Props {
  symbol: string;
  quote?: Quote;
  position?: Position;
  account?: Account;
  pickedPrice?: { value: number; seq: number };
}

const parse = (s: string) => (s.trim() === '' ? undefined : Number(s));
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function OrderTicket({ symbol, quote, position, account, pickedPrice }: Props) {
  const [qty, setQty] = useState('100');
  const [type, setType] = useState<OrderType>('limit');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [tif, setTif] = useState<'day' | 'gtc'>('day');
  const [bracket, setBracket] = useState(true);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [riskUsd, setRiskUsd] = useState('100');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

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
  const canBracket = type === 'market' || type === 'limit';

  const entryFor = (side: 'buy' | 'sell') =>
    parse(needsLimit ? limit : '') ?? parse(needsStop ? stop : '') ?? (side === 'buy' ? quote?.ask : quote?.bid);

  const entry = entryFor('buy') ?? mid;
  const q = Number(qty) || 0;
  const slN = parse(sl);
  const tpN = parse(tp);
  const riskPerShare = entry !== undefined && slN !== undefined ? Math.abs(entry - slN) : undefined;
  const rewardPerShare = entry !== undefined && tpN !== undefined ? Math.abs(tpN - entry) : undefined;

  const sizeFromRisk = () => {
    if (!riskPerShare) return;
    const n = Math.floor(Number(riskUsd) / riskPerShare);
    if (n > 0) setQty(String(n));
  };

  const submit = async (side: 'buy' | 'sell') => {
    const req: OrderRequest = { symbol, side, qty: Math.floor(q), type, tif };
    if (needsLimit) req.limitPrice = parse(limit);
    if (needsStop) req.stopPrice = parse(stop);
    if (bracket && canBracket) {
      if (tpN !== undefined) req.takeProfit = { limitPrice: tpN };
      if (slN !== undefined) req.stopLoss = { stopPrice: slN };
    }
    setBusy(true);
    try {
      const o = await api.submit(req);
      setResult(o.status === 'rejected'
        ? { ok: false, text: o.rejectReason ?? 'rejected' }
        : { ok: true, text: `${side.toUpperCase()} ${o.qty} ${symbol} — ${o.status.replace('_', ' ')}${o.filledQty ? ` @ ${price(o.avgFillPrice)}` : ''}` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Quick fill buttons for bracket levels, sized in cents from the entry.
  const offset = (field: 'tp' | 'sl', cents: number) => {
    if (entry === undefined) return;
    (field === 'tp' ? setTp : setSl)(r2(entry + cents / 100));
  };

  return (
    <div className="panel ticket">
      <div className="panel-title">Order — {symbol}</div>
      <div className="quote-strip">
        <span>Bid <b className="down">{price(quote?.bid)}</b> × {quote?.bidSize ?? '—'}</span>
        <span>Ask <b className="up">{price(quote?.ask)}</b> × {quote?.askSize ?? '—'}</span>
      </div>
      {position && position.qty !== 0 && (
        <div className="muted small">Position: {position.qty} @ {price(position.avgPrice)}</div>
      )}

      <div className="seg">
        {(['market', 'limit', 'stop', 'stop_limit'] as OrderType[]).map((t) => (
          <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{t.replace('_', ' ')}</button>
        ))}
      </div>

      <label>Shares
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      {needsStop && (
        <label>Stop price
          <input type="number" step={0.01} value={stop} placeholder={price(quote?.last)} onChange={(e) => setStop(e.target.value)} />
        </label>
      )}
      {needsLimit && (
        <label>Limit price
          <input type="number" step={0.01} value={limit} placeholder={price(mid)} onChange={(e) => setLimit(e.target.value)} />
        </label>
      )}
      <label>Time in force
        <select value={tif} onChange={(e) => setTif(e.target.value as 'day' | 'gtc')}>
          <option value="day">DAY</option>
          <option value="gtc">GTC</option>
        </select>
      </label>

      {canBracket && (
        <>
          <label className="check">
            <input type="checkbox" checked={bracket} onChange={(e) => setBracket(e.target.checked)} /> Bracket (take-profit / stop-loss)
          </label>
          {bracket && (
            <div className="bracket">
              <label>Take profit
                <input type="number" step={0.01} value={tp} onChange={(e) => setTp(e.target.value)} />
              </label>
              <div className="chips">
                {[10, 25, 50, 100].map((c) => <button key={c} onClick={() => offset('tp', c)}>+{c}¢</button>)}
              </div>
              <label>Stop loss
                <input type="number" step={0.01} value={sl} onChange={(e) => setSl(e.target.value)} />
              </label>
              <div className="chips">
                {[10, 25, 50, 100].map((c) => <button key={c} onClick={() => offset('sl', -c)}>−{c}¢</button>)}
              </div>
              <div className="muted small">Long-side offsets shown; for a short, swap the levels.</div>
              <div className="risk-row">
                <label>Risk $
                  <input type="number" value={riskUsd} onChange={(e) => setRiskUsd(e.target.value)} />
                </label>
                <button onClick={sizeFromRisk} disabled={!riskPerShare}>Size</button>
              </div>
            </div>
          )}
        </>
      )}

      <dl className="stats">
        <dt>Est. value</dt><dd>{entry ? money(q * entry) : '—'}</dd>
        <dt>Buying power</dt><dd>{money(account?.buyingPower)}</dd>
        {bracket && canBracket && riskPerShare !== undefined && <><dt>Risk</dt><dd className="down">{money(riskPerShare * q)}</dd></>}
        {bracket && canBracket && rewardPerShare !== undefined && <><dt>Reward</dt><dd className="up">{money(rewardPerShare * q)}</dd></>}
        {riskPerShare && rewardPerShare ? <><dt>R:R</dt><dd>1 : {(rewardPerShare / riskPerShare).toFixed(2)}</dd></> : null}
      </dl>

      <div className="actions">
        <button className="buy" disabled={busy || q <= 0} onClick={() => submit('buy')}>Buy</button>
        <button className="sell" disabled={busy || q <= 0} onClick={() => submit('sell')}>Sell</button>
      </div>
      {result && <div className={`result ${result.ok ? 'ok' : 'err'}`}>{result.text}</div>}
      <div className="muted small">Tip: click the chart to set a price.</div>
    </div>
  );
}
