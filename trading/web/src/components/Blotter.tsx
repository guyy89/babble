import { useState } from 'react';
import { api } from '../api';
import { money, pnlClass, price, signed, time } from '../format';
import type { Fill, Order, Position } from '../store';

interface Props {
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  onSelect: (symbol: string) => void;
}

const OPEN = new Set(['new', 'partially_filled', 'held']);

export function Blotter({ positions, orders, fills, onSelect }: Props) {
  const [tab, setTab] = useState<'positions' | 'open' | 'orders' | 'fills'>('positions');
  const open = orders.filter((o) => OPEN.has(o.status));
  const openPositions = positions.filter((p) => p.qty !== 0);

  return (
    <div className="panel blotter">
      <div className="tabs">
        <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>Positions ({openPositions.length})</button>
        <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Working ({open.length})</button>
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>All orders</button>
        <button className={tab === 'fills' ? 'on' : ''} onClick={() => setTab('fills')}>Fills</button>
        <span className="spacer" />
        {tab === 'open' && open.length > 0 && <button className="danger" onClick={() => api.cancelAll()}>Cancel all</button>}
      </div>
      <div className="table-wrap">
        {tab === 'positions' && (
          <table>
            <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>Mkt value</th><th>Unrealized</th><th>Realized today</th><th /></tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol} onClick={() => onSelect(p.symbol)}>
                  <td><b>{p.symbol}</b></td>
                  <td className={p.qty < 0 ? 'down' : ''}>{p.qty}</td>
                  <td>{price(p.avgPrice)}</td>
                  <td>{price(p.marketPrice)}</td>
                  <td>{money(p.marketValue)}</td>
                  <td className={pnlClass(p.unrealizedPnl)}>{signed(p.unrealizedPnl)}</td>
                  <td className={pnlClass(p.realizedPnlToday)}>{signed(p.realizedPnlToday)}</td>
                  <td>{p.qty !== 0 && <button className="danger sm" onClick={(e) => { e.stopPropagation(); api.close(p.symbol); }}>Close</button>}</td>
                </tr>
              ))}
              {positions.length === 0 && <tr><td colSpan={8} className="muted">No positions</td></tr>}
            </tbody>
          </table>
        )}
        {(tab === 'open' || tab === 'orders') && (
          <OrdersTable orders={tab === 'open' ? open : orders} onSelect={onSelect} />
        )}
        {tab === 'fills' && (
          <table>
            <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Commission</th></tr></thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} onClick={() => onSelect(f.symbol)}>
                  <td>{time(f.ts)}</td><td><b>{f.symbol}</b></td>
                  <td className={f.side === 'buy' ? 'up' : 'down'}>{f.side.toUpperCase()}</td>
                  <td>{f.qty}</td><td>{price(f.price)}</td><td>{money(f.commission)}</td>
                </tr>
              ))}
              {fills.length === 0 && <tr><td colSpan={6} className="muted">No fills yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function OrdersTable({ orders, onSelect }: { orders: Order[]; onSelect: (s: string) => void }) {
  return (
    <table>
      <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Filled</th><th>Limit</th><th>Stop</th><th>Status</th><th /></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} onClick={() => onSelect(o.symbol)} title={o.rejectReason}>
            <td>{time(o.createdAt)}</td>
            <td><b>{o.symbol}</b></td>
            <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side.toUpperCase()}</td>
            <td>{o.parentId ? (o.type === 'stop' ? 'SL' : 'TP') : o.type.replace('_', ' ')}{o.legIds ? ' ⧉' : ''}</td>
            <td>{o.qty}</td>
            <td>{o.filledQty ? `${o.filledQty} @ ${price(o.avgFillPrice)}` : '—'}</td>
            <td>{price(o.limitPrice)}</td>
            <td>{price(o.stopPrice)}</td>
            <td className={`status ${o.status}`}>{o.status.replace('_', ' ')}{o.rejectReason ? ` — ${o.rejectReason}` : ''}</td>
            <td>{OPEN.has(o.status) && <button className="sm" onClick={(e) => { e.stopPropagation(); api.cancel(o.id); }}>Cancel</button>}</td>
          </tr>
        ))}
        {orders.length === 0 && <tr><td colSpan={10} className="muted">No orders</td></tr>}
      </tbody>
    </table>
  );
}
