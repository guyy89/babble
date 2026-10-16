import { useMemo, useState } from 'react';
import { api } from './api';
import { Blotter } from './components/Blotter';
import { Chart, TIMEFRAMES, type Timeframe } from './components/Chart';
import { OrderTicket } from './components/OrderTicket';
import { Watchlist } from './components/Watchlist';
import { money, pnlClass, price, signed } from './format';
import { useTradingStore } from './store';

export function App() {
  const { state, dismiss } = useTradingStore();
  const [selected, setSelected] = useState<string>();
  const [picked, setPicked] = useState<{ value: number; seq: number }>();
  const [timeframe, setTimeframe] = useState<Timeframe>(1);
  const [atrValue, setAtrValue] = useState<number | null>(null);

  const [localError, setLocalError] = useState<{ message: string; ts: number }>();

  // A removed symbol can't stay selected.
  const symbol = selected && state.symbols.includes(selected) ? selected : state.symbols[0];
  const orders = useMemo(() => Object.values(state.orders).sort((a, b) => b.createdAt - a.createdAt), [state.orders]);
  const symbolOrders = useMemo(
    () => orders.filter((o) => o.symbol === symbol && ['new', 'partially_filled', 'held'].includes(o.status)),
    [orders, symbol],
  );
  const position = state.positions.find((p) => p.symbol === symbol);
  const a = state.account;

  const resetAccount = () => {
    if (confirm('לאפס את החשבון המדומה? כל הפוזיציות, הפקודות וההיסטוריה יימחקו.')) api.resetAccount();
  };

  const flattenAll = () => {
    if (confirm('לבטל את כל הפקודות ולסגור את כל הפוזיציות במחיר השוק?')) api.flattenAll();
  };

  return (
    <div className="app">
      <header>
        <div className="brand">מסחר יומי</div>
        <span className={`badge ${state.broker === 'paper' ? 'paper' : 'live'}`}>
          {state.broker === 'paper' ? 'מדומה' : 'כסף אמיתי'}
        </span>
        <span className="badge">נתונים: {state.dataSource === 'sim' ? 'מדומים' : state.dataSource === 'alpaca' ? 'אלפקה' : state.dataSource || '…'}</span>
        <span className={`badge ${state.clock?.isOpen ? 'open' : 'closed'}`}>
          {state.clock?.alwaysOpen ? 'שוק מדומה, פתוח תמיד' : state.clock?.isOpen ? `השוק פתוח · ${state.clock.minutesToClose} דק׳ לסגירה` : 'השוק סגור'}
        </span>
        {!state.connected && <span className="badge closed">אין חיבור לשרת</span>}
        <div className="spacer" />
        {a && (
          <div className="acct">
            <Stat label="הון" value={money(a.equity)} />
            <Stat label="רווח/הפסד היום" value={signed(a.dayPnl)} cls={pnlClass(a.dayPnl)} />
            <Stat label="ממומש" value={signed(a.realizedPnlToday)} cls={pnlClass(a.realizedPnlToday)} />
            <Stat label="עמלות היום" value={money(a.commissionsToday)} />
            <Stat label="כוח קנייה" value={money(a.buyingPower)} />
            {a.marginModel === 'pdt' && (
              <Stat label="עסקאות יומיות (5 ימים)" value={`${a.dayTradeCount}${a.equity < 25000 && a.accountType === 'margin' ? ' / 3' : ''}`} />
            )}
          </div>
        )}
        {state.broker === 'paper' && <button onClick={resetAccount}>איפוס חשבון</button>}
        <button className="danger" onClick={flattenAll}>סגור הכל</button>
      </header>

      {a?.tradingBlocked && <div className="banner">{a.blockReason}</div>}

      <Watchlist symbols={state.symbols} names={state.names} quotes={state.quotes} positions={state.positions}
        selected={symbol} onSelect={setSelected} onError={(message) => setLocalError({ message, ts: Date.now() })} />

      <main className="panel chart-panel">
        <div className="panel-title">
          <span>{symbol} <span className="co-title">{symbol && state.names[symbol]}</span></span>
          <span className="tf">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} className={tf === timeframe ? 'sm on' : 'sm'} onClick={() => setTimeframe(tf)}>{tf} דק׳</button>
            ))}
          </span>
          <span className="muted small">
            <span style={{ color: '#f0b90b' }}>ממוצע משוקלל נפח</span> · <span style={{ color: '#4c8dff' }}>ממוצע נע 9</span> ·{' '}
            <span style={{ color: '#c77dff' }}>ממוצע נע 20</span> · חוזק יחסי 14 (למטה) · תנודתיות ממוצעת לנר: {atrValue === null ? '—' : price(atrValue)}
          </span>
          {position && position.qty !== 0 && (
            <span className={`pos-pill ${pnlClass(position.unrealizedPnl)}`}>
              {position.qty > 0 ? 'לונג' : 'שורט'} {Math.abs(position.qty)} מניות במחיר {price(position.avgPrice)} · {signed(position.unrealizedPnl)}
            </span>
          )}
        </div>
        {symbol && (
          <Chart symbol={symbol} timeframe={timeframe} orders={symbolOrders} position={position} onAtr={setAtrValue}
            onPickPrice={(value) => setPicked((p) => ({ value, seq: (p?.seq ?? 0) + 1 }))} />
        )}
      </main>

      {symbol && (
        <OrderTicket symbol={symbol} companyName={state.names[symbol]} quote={state.quotes[symbol]} position={position} account={a}
          settings={state.settings} pickedPrice={picked} />
      )}

      <Blotter positions={state.positions} orders={orders} fills={state.fills} onSelect={setSelected} />

      <div className="toasts">
        {localError && (
          <div className="toast warn" onClick={() => setLocalError(undefined)}>{localError.message}</div>
        )}
        {state.notices.map((n) => (
          <div key={n.ts} className={`toast ${n.level}`} onClick={() => dismiss(n.ts)}>{n.message}</div>
        ))}
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
