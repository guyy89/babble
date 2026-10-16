import { useState } from 'react';
import { api } from '../api';
import { money, pnlClass, price, signed, time } from '../format';
import { orderKind, SIDE, STATUS } from '../he';
import type { Fill, Order, Position, Quote } from '../store';
import type { BotStatus } from '../api';
import { BotPanel } from './BotPanel';
import { Journal } from './Journal';
import { News } from './News';
import { Tape } from './Tape';

interface Props {
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  onSelect: (symbol: string) => void;
  symbol?: string;
  quote?: Quote;
  bot?: BotStatus;
}

type Tab = 'positions' | 'open' | 'orders' | 'fills' | 'journal' | 'tape' | 'news' | 'bot';

const OPEN = new Set(['new', 'partially_filled', 'held']);

export function Blotter({ positions, orders, fills, onSelect, symbol, quote, bot }: Props) {
  const [tab, setTab] = useState<Tab>('positions');
  const open = orders.filter((o) => OPEN.has(o.status));
  const openPositions = positions.filter((p) => p.qty !== 0);

  return (
    <div className="panel blotter">
      <div className="tabs">
        <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>פוזיציות ({openPositions.length})</button>
        <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>פקודות פתוחות ({open.length})</button>
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>כל הפקודות</button>
        <button className={tab === 'fills' ? 'on' : ''} onClick={() => setTab('fills')}>ביצועים</button>
        <button className={tab === 'journal' ? 'on' : ''} onClick={() => setTab('journal')}>יומן מסחר</button>
        <button className={tab === 'tape' ? 'on' : ''} onClick={() => setTab('tape')}>סרט עסקאות</button>
        <button className={tab === 'news' ? 'on' : ''} onClick={() => setTab('news')}>חדשות</button>
        <button className={`${tab === 'bot' ? 'on' : ''} ${bot?.enabled ? 'bot-on' : ''}`} onClick={() => setTab('bot')}>
          רובוט{bot?.enabled ? ' (פעיל)' : ''}
        </button>
        <span className="spacer" />
        {tab === 'open' && open.length > 0 && <button className="danger" onClick={() => api.cancelAll()}>בטל הכל</button>}
      </div>
      <div className="table-wrap">
        {tab === 'positions' && (
          <table>
            <thead><tr><th>מניה</th><th>כמות</th><th>מחיר ממוצע</th><th>אחרון</th><th>שווי</th><th>רווח פתוח</th><th>ממומש היום</th><th /></tr></thead>
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
                  <td>{p.qty !== 0 && <button className="danger sm" onClick={(e) => { e.stopPropagation(); api.close(p.symbol); }}>סגור</button>}</td>
                </tr>
              ))}
              {positions.length === 0 && <tr><td colSpan={8} className="muted">אין פוזיציות</td></tr>}
            </tbody>
          </table>
        )}
        {(tab === 'open' || tab === 'orders') && (
          <OrdersTable orders={tab === 'open' ? open : orders} onSelect={onSelect} />
        )}
        {tab === 'journal' && <Journal refreshKey={fills[0]?.id ?? ''} onSelect={onSelect} />}
        {tab === 'tape' && <Tape symbol={symbol} quote={quote} />}
        {tab === 'news' && <News symbol={symbol} />}
        {tab === 'bot' && <BotPanel status={bot} onSelect={onSelect} />}
        {tab === 'fills' && (
          <table>
            <thead><tr><th>שעה</th><th>מניה</th><th>צד</th><th>כמות</th><th>מחיר</th><th>עמלה</th><th>אגרות רגולציה</th></tr></thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} onClick={() => onSelect(f.symbol)}>
                  <td>{time(f.ts)}</td><td><b>{f.symbol}</b></td>
                  <td className={f.side === 'buy' ? 'up' : 'down'}>{SIDE[f.side]}</td>
                  <td>{f.qty}</td><td>{price(f.price)}</td><td>{money(f.commission)}</td><td>{f.fees ? money(f.fees) : '—'}</td>
                </tr>
              ))}
              {fills.length === 0 && <tr><td colSpan={7} className="muted">אין ביצועים עדיין</td></tr>}
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
      <thead><tr><th>שעה</th><th>מניה</th><th>צד</th><th>סוג</th><th>כמות</th><th>בוצע</th><th>לימיט</th><th>סטופ</th><th>סטטוס</th><th /></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} onClick={() => onSelect(o.symbol)} title={o.rejectReason}>
            <td>{time(o.createdAt)}</td>
            <td><b>{o.symbol}</b></td>
            <td className={o.side === 'buy' ? 'up' : 'down'}>{SIDE[o.side]}</td>
            <td>{orderKind(o)}{o.legIds ? ' ⧉' : ''}</td>
            <td>{o.qty}</td>
            <td>{o.filledQty ? `${o.filledQty} במחיר ${price(o.avgFillPrice)}` : '—'}</td>
            <td>{price(o.limitPrice)}</td>
            <td>{price(o.stopPrice)}</td>
            <td className={`status ${o.status}`}>{STATUS[o.status]}{o.rejectReason ? `: ${o.rejectReason}` : ''}</td>
            <td>{OPEN.has(o.status) && <button className="sm" onClick={(e) => { e.stopPropagation(); api.cancel(o.id); }}>בטל</button>}</td>
          </tr>
        ))}
        {orders.length === 0 && <tr><td colSpan={10} className="muted">אין פקודות</td></tr>}
      </tbody>
    </table>
  );
}
