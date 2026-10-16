import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Blotter } from './components/Blotter';
import { TIMEFRAMES, type Timeframe } from './components/Chart';
import { ChartArea } from './components/ChartArea';
import { OrderTicket, typingInField } from './components/OrderTicket';
import { Watchlist } from './components/Watchlist';
import { money, pnlClass, price, signed } from './format';
import { DEFAULT_INDICATORS, usePref, type DrawnLines, type IndicatorConfig, type PriceAlert } from './prefs';
import { useTradingStore } from './store';

const OPEN = ['new', 'partially_filled', 'held'];

export function App() {
  const { state, dismiss } = useTradingStore();
  const [picked, setPicked] = useState<{ value: number; seq: number }>();
  const [localNotice, setLocalNotice] = useState<{ message: string; ts: number; level: 'info' | 'warn' }>();
  const [help, setHelp] = useState(false);
  const [atr, setAtr] = useState<number | null>(null);

  const [timeframe, setTimeframe] = usePref<{ tf: Timeframe }>('chart.timeframe', { tf: 1 });
  const [indicators, setIndicators] = usePref<IndicatorConfig>('chart.indicators', DEFAULT_INDICATORS);
  const [lines, setLines] = usePref<DrawnLines>('chart.lines', {});
  const [alerts, setAlerts] = usePref<PriceAlert[]>('alerts', []);
  const [layout, setLayout] = usePref<{ mode: 'single' | 'grid'; cells: string[]; active: number }>('chart.layout', {
    mode: 'single', cells: [], active: 0,
  });

  // Chart cells hold symbols; anything no longer on the watchlist falls back to the first watchlist symbol.
  const cells = [0, 1, 2, 3].map((i) => {
    const s = layout.cells[i];
    return s && state.symbols.includes(s) ? s : state.symbols[i];
  });
  const symbol = cells[layout.active] ?? state.symbols[0];
  const selectSymbol = (s: string) => {
    const next = [...cells];
    next[layout.active] = s;
    setLayout({ ...layout, cells: next as string[] });
  };

  const orders = useMemo(() => Object.values(state.orders).sort((a, b) => b.createdAt - a.createdAt), [state.orders]);
  const openOrders = useMemo(() => orders.filter((o) => OPEN.includes(o.status)), [orders]);
  const position = state.positions.find((p) => p.symbol === symbol);
  const a = state.account;
  const notify = (message: string, level: 'info' | 'warn' = 'warn') => setLocalNotice({ message, ts: Date.now(), level });
  useEffect(() => {
    if (!localNotice) return;
    const t = setTimeout(() => setLocalNotice(undefined), 8000);
    return () => clearTimeout(t);
  }, [localNotice]);

  // ---------------------------------------------------------------- price alerts

  const addAlert = (s: string, value: number) => {
    const last = state.quotes[s]?.last;
    if (!last) return notify(`אין מחיר עדכני ל-${s}`);
    const alert: PriceAlert = { id: crypto.randomUUID(), symbol: s, price: value, dir: value >= last ? 'above' : 'below', createdAt: Date.now() };
    setAlerts([...alerts, alert]);
    notify(`נקבעה התראה: ${s} ${alert.dir === 'above' ? 'עולה מעל' : 'יורדת מתחת ל'} ${price(value)}`, 'info');
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    } catch { /* notifications unavailable */ }
  };

  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  useEffect(() => {
    const fired = alertsRef.current.filter((al) => {
      const last = state.quotes[al.symbol]?.last;
      return last !== undefined && (al.dir === 'above' ? last >= al.price : last <= al.price);
    });
    if (!fired.length) return;
    setAlerts(alertsRef.current.filter((al) => !fired.includes(al)));
    for (const al of fired) {
      const msg = `התראה: ${al.symbol} ${al.dir === 'above' ? 'עלתה מעל' : 'ירדה מתחת ל'} ${price(al.price)} (עכשיו ${price(state.quotes[al.symbol]?.last)})`;
      notify(msg, 'warn');
      beep();
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification('מסחר יומי', { body: msg });
      } catch { /* notifications unavailable */ }
    }
  }, [state.quotes]);

  // ---------------------------------------------------------------- app-level shortcuts

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.key === 'Escape') return setHelp(false);
    if (typingInField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); return setHelp((h) => !h); }
    if (e.code === 'Slash') { e.preventDefault(); return document.getElementById('symbol-search')?.focus(); }
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      const i = state.symbols.indexOf(symbol);
      const next = state.symbols[(i + (e.code === 'ArrowDown' ? 1 : -1) + state.symbols.length) % state.symbols.length];
      if (next) selectSymbol(next);
      return;
    }
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (digit) { e.preventDefault(); setTimeframe({ tf: TIMEFRAMES[Number(digit[1]) - 1] }); return; }
    if (e.code === 'KeyG') { e.preventDefault(); setLayout({ ...layout, mode: layout.mode === 'grid' ? 'single' : 'grid' }); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resetAccount = () => {
    if (confirm('לאפס את החשבון המדומה? כל הפוזיציות, הפקודות וההיסטוריה (כולל היומן) יימחקו.')) api.resetAccount();
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
        <button onClick={() => setHelp(true)} title="מקש ?">קיצורי מקלדת</button>
        {state.broker === 'paper' && <button onClick={resetAccount}>איפוס חשבון</button>}
        <button className="danger" onClick={flattenAll}>סגור הכל</button>
      </header>

      {a?.tradingBlocked && <div className="banner">{a.blockReason}</div>}

      <Watchlist symbols={state.symbols} names={state.names} quotes={state.quotes} positions={state.positions}
        selected={symbol} onSelect={selectSymbol} onError={(m) => notify(m)} />

      <ChartArea
        layout={layout.mode} setLayout={(mode) => setLayout({ ...layout, mode, cells: cells as string[] })}
        cells={cells} activeCell={layout.active}
        onActivate={(i) => setLayout({ ...layout, active: i, cells: cells as string[] })}
        names={state.names} quotes={state.quotes}
        timeframe={timeframe.tf} setTimeframe={(tf) => setTimeframe({ tf })}
        indicators={indicators} setIndicators={setIndicators}
        openOrders={openOrders} positions={state.positions}
        lines={lines} setLines={setLines}
        alerts={alerts} addAlert={addAlert} removeAlert={(id) => setAlerts(alerts.filter((x) => x.id !== id))}
        onPickPrice={(value) => setPicked((p) => ({ value, seq: (p?.seq ?? 0) + 1 }))}
        onAtrChange={setAtr}
      />

      {symbol && (
        <OrderTicket symbol={symbol} companyName={state.names[symbol]} quote={state.quotes[symbol]} position={position} account={a}
          settings={state.settings} pickedPrice={picked} openOrders={openOrders.filter((o) => o.symbol === symbol)} atr={atr} />
      )}

      <Blotter positions={state.positions} orders={orders} fills={state.fills} onSelect={selectSymbol}
        symbol={symbol} quote={symbol ? state.quotes[symbol] : undefined} />

      <div className="toasts">
        {localNotice && (
          <div key={localNotice.ts} className={`toast ${localNotice.level}`} onClick={() => setLocalNotice(undefined)}>{localNotice.message}</div>
        )}
        {state.notices.map((n) => (
          <div key={n.ts} className={`toast ${n.level}`} onClick={() => dismiss(n.ts)}>{n.message}</div>
        ))}
      </div>

      {help && <Help onClose={() => setHelp(false)} />}
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

const SHORTCUTS: [string, string][] = [
  ['B', 'קנייה לפי ההגדרות בכרטיס הפקודה'],
  ['S', 'מכירה (או שורט) לפי ההגדרות בכרטיס הפקודה'],
  ['Q', 'חישוב כמות לפי הסיכון והסטופ'],
  ['X', 'סגירת הפוזיציה במניה הנוכחית'],
  ['C', 'ביטול הפקודות הפתוחות במניה הנוכחית'],
  ['E', 'הזזת הסטופ לנקודת הכניסה'],
  ['R', 'היפוך הפוזיציה'],
  ['↑ / ↓', 'מעבר למניה הקודמת / הבאה ברשימה'],
  ['1 2 3 4', 'אורך נר: דקה, 5 דקות, 15 דקות, יומי'],
  ['G', 'מעבר בין גרף אחד לארבעה גרפים'],
  ['/', 'מעבר לתיבת החיפוש'],
  ['?', 'הצגת החלון הזה'],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="popover-title">קיצורי מקלדת <button className="sm ghost" onClick={onClose}>×</button></div>
        <p className="muted small">הקיצורים פועלים כשלא מקלידים בתוך שדה, וגם כשהמקלדת בעברית. פקודות יוצאות מיד, בלי אישור נוסף, וכל מגבלות הסיכון חלות עליהן.</p>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Short two-tone chime for price alerts (Web Audio; silently skipped if unavailable). */
function beep() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* audio unavailable */ }
}
