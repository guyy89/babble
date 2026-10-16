import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../api';
import { ORDER_TYPE, SIDE } from '../he';
import { aggregate, atr, bollinger, ema, macd, rsi, sma } from '../indicators';
import type { IndicatorConfig, PriceAlert } from '../prefs';
import { onBar, type Bar, type Order, type Position } from '../store';

const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const utcDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtTime = (t: Time) => nyTime.format(new Date((t as number) * 1000));
const fmtDate = (t: Time) => utcDate.format(new Date((t as number) * 1000));
const dayStart = (ms: number) => Date.parse(`${nyDay.format(new Date(ms))}T00:00:00Z`);

const toCandle = (b: Bar) => ({ time: (b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });
const toVolume = (b: Bar) => ({
  time: (b.t / 1000) as UTCTimestamp, value: b.v, color: b.c >= b.o ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)',
});

/** Session VWAP, reset at each New York trading day. */
function vwap(bars: Bar[]): number[] {
  let day = '';
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const d = nyDay.format(new Date(b.t));
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
    return vol > 0 ? pv / vol : b.c;
  });
}

type Point = { time: UTCTimestamp; value: number; color?: string };
const line = (bars: Bar[], values: (number | null)[]): Point[] =>
  bars.flatMap((b, i) => (values[i] === null ? [] : [{ time: (b.t / 1000) as UTCTimestamp, value: values[i]! }]));

export const TIMEFRAMES = [1, 5, 15, 'D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const tfLabel = (tf: Timeframe) => (tf === 'D' ? 'יומי' : `${tf} דק׳`);

export const COLORS = {
  vwap: '#f0b90b', ema1: '#4c8dff', ema2: '#c77dff', sma1: '#ff9f43', sma2: '#e84393', bb: '#5fa8a0',
  rsi: '#8b98a5', macd: '#4c8dff', signal: '#ff9f43', prev: '#7a8794', alert: '#ffb020', drawn: '#d6dde4',
};

export type ClickMode = 'pick' | 'line' | 'alert';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  indicators: IndicatorConfig;
  orders: Order[];
  position?: Position;
  lines: number[];
  alerts: PriceAlert[];
  mode: ClickMode;
  onClickPrice: (price: number, mode: ClickMode) => void;
  onAtr?: (value: number | null) => void;
}

export function Chart({ symbol, timeframe, indicators, orders, position, lines, alerts, mode, onClickPrice, onAtr }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(undefined);
  const candlesRef = useRef<ISeriesApi<'Candlestick'>>(undefined);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const prevDayLinesRef = useRef<IPriceLine[]>([]);
  const clickRef = useRef(onClickPrice);
  clickRef.current = onClickPrice;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const atrRef = useRef(onAtr);
  atrRef.current = onAtr;
  const cfgKey = JSON.stringify(indicators);

  useEffect(() => {
    const daily = timeframe === 'D';
    const cfg = indicators;
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0f14' }, textColor: '#8b98a5', fontSize: 11 },
      grid: { vertLines: { color: '#151c24' }, horzLines: { color: '#151c24' } },
      rightPriceScale: { borderColor: '#1e2730' },
      timeScale: { borderColor: '#1e2730', timeVisible: !daily, secondsVisible: false, tickMarkFormatter: daily ? fmtDate : fmtTime },
      localization: { timeFormatter: daily ? fmtDate : fmtTime },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    const volume = cfg.volume ? chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' }) : undefined;
    volume?.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const overlay = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    // Each enabled indicator contributes series plus a function that computes their data from the bars.
    const outputs: { series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>; compute: (bars: Bar[]) => Point[] }[] = [];
    const addLine = (color: string, compute: (bars: Bar[]) => (number | null)[], pane = 0, extra = {}) => {
      const series = chart.addSeries(LineSeries, { ...overlay, color, ...extra }, pane);
      outputs.push({ series, compute: (bars) => line(bars, compute(bars)) });
      return series;
    };
    if (cfg.vwap && !daily) addLine(COLORS.vwap, vwap);
    if (cfg.ema1.on) addLine(COLORS.ema1, (b) => ema(b, cfg.ema1.len));
    if (cfg.ema2.on) addLine(COLORS.ema2, (b) => ema(b, cfg.ema2.len));
    if (cfg.sma1.on) addLine(COLORS.sma1, (b) => sma(b, cfg.sma1.len));
    if (cfg.sma2.on) addLine(COLORS.sma2, (b) => sma(b, cfg.sma2.len));
    if (cfg.bb.on) {
      const dashed = { lineStyle: LineStyle.Dashed };
      addLine(COLORS.bb, (b) => bollinger(b, cfg.bb.len, cfg.bb.mult).upper, 0, dashed);
      addLine(COLORS.bb, (b) => bollinger(b, cfg.bb.len, cfg.bb.mult).mid);
      addLine(COLORS.bb, (b) => bollinger(b, cfg.bb.len, cfg.bb.mult).lower, 0, dashed);
    }
    let pane = 1;
    if (cfg.rsi.on) {
      const s = addLine(COLORS.rsi, (b) => rsi(b, cfg.rsi.len), pane, { lastValueVisible: true });
      s.createPriceLine({ price: 70, color: '#ef5350', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
      s.createPriceLine({ price: 30, color: '#26a69a', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
      s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      pane++;
    }
    if (cfg.macd.on) {
      const m = (b: Bar[]) => macd(b, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      outputs.push({
        series: hist,
        compute: (bars) => line(bars, m(bars).hist).map((p) => ({ ...p, color: p.value >= 0 ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)' })),
      });
      addLine(COLORS.macd, (b) => m(b).line, pane, { lastValueVisible: true });
      addLine(COLORS.signal, (b) => m(b).signal, pane);
      pane++;
    }
    for (let i = 1; i < pane; i++) chart.panes()[i]?.setHeight(80);
    chartRef.current = chart;
    candlesRef.current = candles;

    chart.subscribeClick((param) => {
      if (!param.point) return;
      const p = candles.coordinateToPrice(param.point.y);
      if (p !== null) clickRef.current(Math.round(p * 100) / 100, modeRef.current);
    });

    let cancelled = false;
    let loaded = false;
    let base: Bar[] = []; // 1-minute bars, or daily bars on the daily chart

    // Indicators are recomputed from the full history on every update, then either drawn whole
    // (initial load) or only the last point is pushed (live updates).
    const render = (full: boolean) => {
      const bars = daily ? base : aggregate(base, timeframe);
      if (!bars.length) return;
      if (full) {
        candles.setData(bars.map(toCandle));
        volume?.setData(bars.map(toVolume));
        for (const o of outputs) o.series.setData(o.compute(bars));
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - (daily ? 160 : 120)), to: bars.length + 5 });
      } else {
        candles.update(toCandle(bars.at(-1)!));
        volume?.update(toVolume(bars.at(-1)!));
        for (const o of outputs) {
          const data = o.compute(bars);
          if (data.length) o.series.update(data.at(-1)!);
        }
      }
      atrRef.current?.(atr(bars, 14).at(-1) ?? null);
    };

    const drawPrevDay = (dailyBars: Bar[], ref: number) => {
      for (const l of prevDayLinesRef.current) candles.removePriceLine(l);
      prevDayLinesRef.current = [];
      if (!cfg.prevDay || daily) return;
      const today = dayStart(ref);
      const prev = [...dailyBars].reverse().find((b) => b.t < today);
      if (!prev) return;
      const mk = (price: number, title: string) =>
        candles.createPriceLine({ price, color: COLORS.prev, lineWidth: 1, lineStyle: LineStyle.LargeDashed, title, axisLabelVisible: true });
      prevDayLinesRef.current = [mk(prev.h, 'שיא אתמול'), mk(prev.l, 'שפל אתמול'), mk(prev.c, 'סגירת אתמול')];
    };

    const load = daily ? api.bars(symbol, 'day') : api.bars(symbol);
    load.then((bars) => {
      if (cancelled) return;
      base = bars;
      loaded = true;
      render(true);
      if (!daily && cfg.prevDay && bars.length) {
        api.bars(symbol, 'day').then((d) => { if (!cancelled) drawPrevDay(d, bars.at(-1)!.t); }).catch(() => {});
      }
    }).catch(() => {});

    const off = onBar((b) => {
      if (!loaded || b.symbol !== symbol) return;
      const last = base.at(-1);
      if (daily) {
        // Fold the live minute bar into today's daily bar.
        const t = dayStart(b.t);
        if (last && last.t === t) {
          last.h = Math.max(last.h, b.h);
          last.l = Math.min(last.l, b.l);
          last.c = b.c;
        } else if (!last || t > last.t) {
          base.push({ ...b, t });
        } else return;
      } else {
        if (last && b.t < last.t) return;
        if (last && b.t === last.t) base[base.length - 1] = b;
        else base.push(b);
      }
      render(false);
    });

    return () => {
      cancelled = true;
      off();
      chart.remove();
      priceLinesRef.current = [];
      prevDayLinesRef.current = [];
      atrRef.current?.(null);
    };
  }, [symbol, timeframe, cfgKey]);

  // Position, working orders, alerts and drawn levels as horizontal lines.
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    for (const l of priceLinesRef.current) candles.removePriceLine(l);
    priceLinesRef.current = [];
    const add = (opts: Parameters<typeof candles.createPriceLine>[0]) => priceLinesRef.current.push(candles.createPriceLine(opts));
    if (position && position.qty !== 0) {
      add({ price: position.avgPrice, color: '#4c8dff', lineWidth: 2, lineStyle: LineStyle.Solid, title: `${position.qty > 0 ? 'לונג' : 'שורט'} ${Math.abs(position.qty)}` });
    }
    for (const o of orders) {
      const p = o.type === 'stop' || (o.type === 'stop_limit' && !o.triggered) ? o.stopPrice : o.limitPrice;
      if (!p) continue;
      const kind = o.parentId ? (o.type === 'stop' ? (o.trailAmount ? 'סטופ נגרר' : 'סטופ') : 'יעד') : ORDER_TYPE[o.type];
      add({
        price: p, color: o.side === 'buy' ? '#26a69a' : '#ef5350', lineWidth: 1,
        lineStyle: o.status === 'held' ? LineStyle.SparseDotted : LineStyle.Dashed,
        title: `${kind} ${SIDE[o.side]} ${o.qty - o.filledQty}`,
      });
    }
    for (const a of alerts) add({ price: a.price, color: COLORS.alert, lineWidth: 1, lineStyle: LineStyle.Dotted, title: 'התראה' });
    for (const p of lines) add({ price: p, color: COLORS.drawn, lineWidth: 1, lineStyle: LineStyle.Solid, title: '' });
  }, [orders, position, alerts, lines, symbol, timeframe, cfgKey]);

  return <div className={`chart mode-${mode}`} ref={el} />;
}
