import { useMemo, useState } from 'react';
import { api } from './api';
import { Blotter } from './components/Blotter';
import { Chart, TIMEFRAMES, type Timeframe } from './components/Chart';
import { OrderTicket } from './components/OrderTicket';
import { money, pnlClass, price, signed } from './format';
import { useTradingStore } from './store';

export function App() {
  const { state, dismiss } = useTradingStore();
  const [selected, setSelected] = useState<string>();
  const [picked, setPicked] = useState<{ value: number; seq: number }>();
  const [timeframe, setTimeframe] = useState<Timeframe>(1);
  const [atrValue, setAtrValue] = useState<number | null>(null);

  const symbol = selected ?? state.symbols[0];
  const orders = useMemo(() => Object.values(state.orders).sort((a, b) => b.createdAt - a.createdAt), [state.orders]);
  const symbolOrders = useMemo(
    () => orders.filter((o) => o.symbol === symbol && ['new', 'partially_filled', 'held'].includes(o.status)),
    [orders, symbol],
  );
  const position = state.positions.find((p) => p.symbol === symbol);
  const a = state.account;

  const resetAccount = () => {
    if (confirm('Reset the paper account? All positions, orders and history will be erased.')) api.resetAccount();
  };

  const flattenAll = () => {
    if (confirm('Cancel all orders and close every position at market?')) api.flattenAll();
  };

  return (
    <div className="app">
      <header>
        <div className="brand">DayTrader</div>
        <span className={`badge ${state.broker === 'paper' ? 'paper' : 'live'}`}>
          {state.broker === 'paper' ? 'PAPER' : state.broker.toUpperCase()}
        </span>
        <span className="badge">data: {state.dataSource || '…'}</span>
        <span className={`badge ${state.clock?.isOpen ? 'open' : 'closed'}`}>
          {state.clock?.alwaysOpen ? 'SIM SESSION' : state.clock?.isOpen ? `OPEN · ${state.clock.minutesToClose}m to close` : 'MARKET CLOSED'}
        </span>
        {!state.connected && <span className="badge closed">DISCONNECTED</span>}
        <div className="spacer" />
        {a && (
          <div className="acct">
            <Stat label="Equity" value={money(a.equity)} />
            <Stat label="Day P&L" value={signed(a.dayPnl)} cls={pnlClass(a.dayPnl)} />
            <Stat label="Realized" value={signed(a.realizedPnlToday)} cls={pnlClass(a.realizedPnlToday)} />
            <Stat label="Fees today" value={money(a.commissionsToday)} />
            <Stat label="Buying power" value={money(a.buyingPower)} />
            {a.marginModel === 'pdt' && (
              <Stat label="Day trades (5d)" value={`${a.dayTradeCount}${a.equity < 25000 && a.accountType === 'margin' ? ' / 3' : ''}`} />
            )}
          </div>
        )}
        {state.broker === 'paper' && <button onClick={resetAccount}>Reset</button>}
        <button className="danger" onClick={flattenAll}>Flatten all</button>
      </header>

      {a?.tradingBlocked && <div className="banner">{a.blockReason}</div>}

      <aside className="panel watchlist">
        <div className="panel-title">Watchlist</div>
        <table>
          <thead><tr><th>Symbol</th><th>Bid</th><th>Ask</th><th>Last</th></tr></thead>
          <tbody>
            {state.symbols.map((s) => {
              const q = state.quotes[s];
              const pos = state.positions.find((p) => p.symbol === s && p.qty !== 0);
              return (
                <tr key={s} className={s === symbol ? 'sel' : ''} onClick={() => setSelected(s)}>
                  <td><b>{s}</b>{pos && <span className={`dot ${pos.qty > 0 ? 'up' : 'down'}`}>●</span>}</td>
                  <td>{price(q?.bid)}</td>
                  <td>{price(q?.ask)}</td>
                  <td>{price(q?.last)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </aside>

      <main className="panel chart-panel">
        <div className="panel-title">
          {symbol}
          <span className="tf">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} className={tf === timeframe ? 'sm on' : 'sm'} onClick={() => setTimeframe(tf)}>{tf}m</button>
            ))}
          </span>
          <span className="muted small">
            <span style={{ color: '#f0b90b' }}>VWAP</span> · <span style={{ color: '#4c8dff' }}>EMA 9</span> ·{' '}
            <span style={{ color: '#c77dff' }}>EMA 20</span> · RSI 14 · ATR 14: {atrValue === null ? '—' : price(atrValue)}
          </span>
          {position && position.qty !== 0 && (
            <span className={`pos-pill ${pnlClass(position.unrealizedPnl)}`}>
              {position.qty > 0 ? 'LONG' : 'SHORT'} {Math.abs(position.qty)} @ {price(position.avgPrice)} · {signed(position.unrealizedPnl)}
            </span>
          )}
        </div>
        {symbol && (
          <Chart symbol={symbol} timeframe={timeframe} orders={symbolOrders} position={position} onAtr={setAtrValue}
            onPickPrice={(value) => setPicked((p) => ({ value, seq: (p?.seq ?? 0) + 1 }))} />
        )}
      </main>

      {symbol && (
        <OrderTicket symbol={symbol} quote={state.quotes[symbol]} position={position} account={a}
          settings={state.settings} pickedPrice={picked} />
      )}

      <Blotter positions={state.positions} orders={orders} fills={state.fills} onSelect={setSelected} />

      <div className="toasts">
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
