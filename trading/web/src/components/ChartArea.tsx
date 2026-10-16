import { useEffect, useState } from 'react';
import { price, pnlClass, signed } from '../format';
import { DEFAULT_INDICATORS, type IndicatorConfig, type PriceAlert } from '../prefs';
import type { Order, Position, Quote } from '../store';
import { Chart, COLORS, TIMEFRAMES, tfLabel, type ClickMode, type Timeframe } from './Chart';

interface Props {
  layout: 'single' | 'grid';
  setLayout: (l: 'single' | 'grid') => void;
  /** Symbols shown: one in single layout, four in grid layout. */
  cells: (string | undefined)[];
  activeCell: number;
  onActivate: (cell: number) => void;
  names: Record<string, string>;
  quotes: Record<string, Quote>;
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  indicators: IndicatorConfig;
  setIndicators: (c: IndicatorConfig) => void;
  openOrders: Order[];
  positions: Position[];
  lines: Record<string, number[]>;
  setLines: (l: Record<string, number[]>) => void;
  alerts: PriceAlert[];
  addAlert: (symbol: string, price: number) => void;
  removeAlert: (id: string) => void;
  onPickPrice: (price: number) => void;
  onAtrChange?: (atr: number | null) => void;
}

export function ChartArea(p: Props) {
  const [mode, setMode] = useState<ClickMode>('pick');
  const [menu, setMenu] = useState<'indicators' | 'alerts' | null>(null);
  const [atrValue, setAtrValue] = useState<number | null>(null);
  useEffect(() => p.onAtrChange?.(atrValue), [atrValue]);
  const active = p.cells[p.activeCell];
  const position = p.positions.find((x) => x.symbol === active && x.qty !== 0);
  const symbolAlerts = p.alerts.filter((a) => a.symbol === active);

  const onClick = (symbol: string, value: number, m: ClickMode) => {
    if (m === 'line') p.setLines({ ...p.lines, [symbol]: [...(p.lines[symbol] ?? []), value] });
    else if (m === 'alert') p.addAlert(symbol, value);
    else p.onPickPrice(value);
    if (m !== 'pick') setMode('pick'); // one shot: draw/alert, then back to picking prices
  };

  const cellView = (symbol: string | undefined, i: number) => {
    const q = symbol ? p.quotes[symbol] : undefined;
    const pos = p.positions.find((x) => x.symbol === symbol && x.qty !== 0);
    return (
      <div key={i} className={`chart-cell ${p.layout === 'grid' && i === p.activeCell ? 'active' : ''}`}
        onMouseDown={() => i !== p.activeCell && p.onActivate(i)}>
        {p.layout === 'grid' && (
          <div className="cell-title">
            <b>{symbol ?? '—'}</b> <span className="co-title">{symbol && p.names[symbol]}</span>
            <span className="spacer" />
            {q && <span>{price(q.last)}</span>}
            {pos && <span className={pnlClass(pos.unrealizedPnl)}>{signed(pos.unrealizedPnl)}</span>}
          </div>
        )}
        {symbol ? (
          <Chart symbol={symbol} timeframe={p.timeframe} indicators={p.indicators}
            orders={p.openOrders.filter((o) => o.symbol === symbol)} position={pos}
            lines={p.lines[symbol] ?? []} alerts={p.alerts.filter((a) => a.symbol === symbol)}
            mode={i === p.activeCell ? mode : 'pick'}
            onClickPrice={(v, m) => onClick(symbol, v, m)}
            onAtr={i === p.activeCell ? setAtrValue : undefined} />
        ) : (
          <div className="muted pad">בחר מניה מרשימת המעקב כדי להציג אותה כאן</div>
        )}
      </div>
    );
  };

  return (
    <main className="panel chart-panel">
      <div className="panel-title chart-toolbar">
        <span>{active} <span className="co-title">{active && p.names[active]}</span></span>
        <span className="tf">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className={tf === p.timeframe ? 'sm on' : 'sm'} onClick={() => p.setTimeframe(tf)}>{tfLabel(tf)}</button>
          ))}
        </span>
        <span className="tf">
          <button className={`sm ${menu === 'indicators' ? 'on' : ''}`} onClick={() => setMenu(menu === 'indicators' ? null : 'indicators')}>אינדיקטורים ▾</button>
          <button className={`sm ${mode === 'line' ? 'on' : ''}`} title="לחץ על הגרף כדי לסמן קו אופקי"
            onClick={() => setMode(mode === 'line' ? 'pick' : 'line')}>קו אופקי</button>
          <button className="sm" disabled={!active || !(p.lines[active]?.length)} onClick={() => active && p.setLines({ ...p.lines, [active]: [] })}>
            נקה קווים
          </button>
          <button className={`sm ${mode === 'alert' ? 'on' : ''}`} title="לחץ על הגרף במחיר שבו תרצה התראה"
            onClick={() => setMode(mode === 'alert' ? 'pick' : 'alert')}>התראת מחיר</button>
          <button className={`sm ${menu === 'alerts' ? 'on' : ''}`} onClick={() => setMenu(menu === 'alerts' ? null : 'alerts')}>
            התראות ({p.alerts.length})
          </button>
        </span>
        <span className="tf">
          <button className={`sm ${p.layout === 'single' ? 'on' : ''}`} onClick={() => p.setLayout('single')}>גרף אחד</button>
          <button className={`sm ${p.layout === 'grid' ? 'on' : ''}`} onClick={() => p.setLayout('grid')}>4 גרפים</button>
        </span>
        <span className="muted small">תנודתיות ממוצעת לנר: {atrValue === null ? '—' : price(atrValue)}</span>
        {position && (
          <span className={`pos-pill ${pnlClass(position.unrealizedPnl)}`}>
            {position.qty > 0 ? 'לונג' : 'שורט'} {Math.abs(position.qty)} מניות במחיר {price(position.avgPrice)} · {signed(position.unrealizedPnl)}
          </span>
        )}
      </div>
      {mode !== 'pick' && (
        <div className="mode-hint">
          {mode === 'line' ? 'לחץ על הגרף במחיר שבו תרצה קו' : `לחץ על הגרף במחיר שבו תרצה התראה עבור ${active}`}
          <button className="sm" onClick={() => setMode('pick')}>ביטול</button>
        </div>
      )}
      {menu === 'indicators' && <IndicatorMenu config={p.indicators} onChange={p.setIndicators} onClose={() => setMenu(null)} />}
      {menu === 'alerts' && (
        <div className="popover">
          <div className="popover-title">התראות מחיר פעילות <button className="sm ghost" onClick={() => setMenu(null)}>×</button></div>
          {p.alerts.length === 0 && <div className="muted">אין התראות. לחץ על "התראת מחיר" ואז על הגרף.</div>}
          {p.alerts.map((a) => (
            <div key={a.id} className="alert-row">
              <b>{a.symbol}</b> {a.dir === 'above' ? 'עולה מעל' : 'יורדת מתחת ל'} {price(a.price)}
              <button className="sm ghost" onClick={() => p.removeAlert(a.id)}>מחק</button>
            </div>
          ))}
          {symbolAlerts.length > 0 && <div className="muted small">התראות על {active} מסומנות על הגרף בקו כתום.</div>}
        </div>
      )}
      <div className={p.layout === 'grid' ? 'chart-grid' : 'chart-single'}>
        {(p.layout === 'grid' ? p.cells : [p.cells[p.activeCell]]).map((s, i) => cellView(s, p.layout === 'grid' ? i : p.activeCell))}
      </div>
    </main>
  );
}

function IndicatorMenu({ config, onChange, onClose }: { config: IndicatorConfig; onChange: (c: IndicatorConfig) => void; onClose: () => void }) {
  const set = <K extends keyof IndicatorConfig>(k: K, v: IndicatorConfig[K]) => onChange({ ...config, [k]: v });
  const num = (v: string, min = 1, max = 500) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));
  // Plain render helpers (not components) so inputs keep focus while typing.
  const len = (k: 'ema1' | 'ema2' | 'sma1' | 'sma2' | 'rsi' | 'bb', field = 'len' as const) => (
    <input type="number" className="len" value={(config[k] as { len: number })[field]}
      onChange={(e) => set(k, { ...(config[k] as object), [field]: num(e.target.value) } as never)} />
  );
  const toggle = (k: 'ema1' | 'ema2' | 'sma1' | 'sma2' | 'rsi' | 'bb' | 'macd', label: string, color: string) => (
    <input type="checkbox" checked={config[k].on} onChange={(e) => set(k, { ...config[k], on: e.target.checked } as never)}
      aria-label={label} style={{ accentColor: color }} />
  );

  return (
    <div className="popover indicators">
      <div className="popover-title">אינדיקטורים <button className="sm ghost" onClick={onClose}>×</button></div>
      <label><input type="checkbox" checked={config.vwap} onChange={(e) => set('vwap', e.target.checked)} />
        <span style={{ color: COLORS.vwap }}>ממוצע משוקלל נפח</span><span className="muted small">המחיר הממוצע של היום לפי נפח (לא בגרף יומי)</span></label>
      <label>{toggle('ema1', 'ממוצע נע מהיר', COLORS.ema1)}<span style={{ color: COLORS.ema1 }}>ממוצע נע מעריכי</span> {len('ema1')}<span className="muted small">נרות</span></label>
      <label>{toggle('ema2', 'ממוצע נע איטי', COLORS.ema2)}<span style={{ color: COLORS.ema2 }}>ממוצע נע מעריכי</span> {len('ema2')}<span className="muted small">נרות</span></label>
      <label>{toggle('sma1', 'ממוצע נע פשוט', COLORS.sma1)}<span style={{ color: COLORS.sma1 }}>ממוצע נע פשוט</span> {len('sma1')}<span className="muted small">נרות</span></label>
      <label>{toggle('sma2', 'ממוצע נע פשוט ארוך', COLORS.sma2)}<span style={{ color: COLORS.sma2 }}>ממוצע נע פשוט</span> {len('sma2')}<span className="muted small">נרות</span></label>
      <label>{toggle('bb', 'רצועות בולינגר', COLORS.bb)}<span style={{ color: COLORS.bb }}>רצועות בולינגר</span> {len('bb')}
        <input type="number" className="len" step={0.5} value={config.bb.mult}
          onChange={(e) => set('bb', { ...config.bb, mult: Math.max(0.5, Number(e.target.value) || 2) })} /><span className="muted small">סטיות תקן</span></label>
      <label>{toggle('rsi', 'מדד חוזק יחסי', COLORS.rsi)}<span>מדד חוזק יחסי</span> {len('rsi')}<span className="muted small">חלון נפרד מתחת לגרף</span></label>
      <label>{toggle('macd', 'מדד מומנטום', COLORS.macd)}<span>מדד מומנטום (מאקד)</span>
        <input type="number" className="len" value={config.macd.fast} onChange={(e) => set('macd', { ...config.macd, fast: num(e.target.value) })} />
        <input type="number" className="len" value={config.macd.slow} onChange={(e) => set('macd', { ...config.macd, slow: num(e.target.value) })} />
        <input type="number" className="len" value={config.macd.signal} onChange={(e) => set('macd', { ...config.macd, signal: num(e.target.value) })} /></label>
      <label><input type="checkbox" checked={config.prevDay} onChange={(e) => set('prevDay', e.target.checked)} />
        <span>שיא, שפל וסגירה של אתמול</span><span className="muted small">קווים מקווקווים אפורים</span></label>
      <label><input type="checkbox" checked={config.volume} onChange={(e) => set('volume', e.target.checked)} /><span>מחזור מסחר</span></label>
      <button className="sm" onClick={() => onChange(DEFAULT_INDICATORS)}>חזרה לברירת המחדל</button>
    </div>
  );
}
