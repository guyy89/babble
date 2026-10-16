import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../api';
import { aggregate, atr, ema, rsi } from '../indicators';
import { ORDER_TYPE, SIDE } from '../he';
import { onBar, type Bar, type Order, type Position } from '../store';

const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const fmtTime = (t: Time) => nyTime.format(new Date((t as number) * 1000));

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

const line = (bars: Bar[], values: (number | null)[]) =>
  bars.flatMap((b, i) => (values[i] === null ? [] : [{ time: (b.t / 1000) as UTCTimestamp, value: values[i]! }]));

export const TIMEFRAMES = [1, 5, 15] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

interface Props {
  symbol: string;
  timeframe: Timeframe;
  orders: Order[];
  position?: Position;
  onPickPrice: (price: number) => void;
  onAtr: (value: number | null) => void;
}

export function Chart({ symbol, timeframe, orders, position, onPickPrice, onAtr }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(undefined);
  const candlesRef = useRef<ISeriesApi<'Candlestick'>>(undefined);
  const linesRef = useRef<IPriceLine[]>([]);
  const pickRef = useRef(onPickPrice);
  pickRef.current = onPickPrice;
  const atrRef = useRef(onAtr);
  atrRef.current = onAtr;

  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0f14' }, textColor: '#8b98a5', fontSize: 11 },
      grid: { vertLines: { color: '#151c24' }, horzLines: { color: '#151c24' } },
      rightPriceScale: { borderColor: '#1e2730' },
      timeScale: { borderColor: '#1e2730', timeVisible: true, secondsVisible: false, tickMarkFormatter: fmtTime },
      localization: { timeFormatter: fmtTime },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const overlay = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const vwapSeries = chart.addSeries(LineSeries, { ...overlay, color: '#f0b90b' });
    const ema9Series = chart.addSeries(LineSeries, { ...overlay, color: '#4c8dff' });
    const ema20Series = chart.addSeries(LineSeries, { ...overlay, color: '#c77dff' });
    // RSI in its own pane below the price, with the usual 70/30 bands.
    const rsiSeries = chart.addSeries(LineSeries, { ...overlay, color: '#8b98a5', lastValueVisible: true }, 1);
    rsiSeries.createPriceLine({ price: 70, color: '#ef5350', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
    rsiSeries.createPriceLine({ price: 30, color: '#26a69a', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
    rsiSeries.priceScale().applyOptions({ autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
    rsiSeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    chart.panes()[1]?.setHeight(90);
    chartRef.current = chart;
    candlesRef.current = candles;

    chart.subscribeClick((param) => {
      if (!param.point) return;
      const p = candles.coordinateToPrice(param.point.y);
      if (p !== null) pickRef.current(Math.round(p * 100) / 100);
    });

    let cancelled = false;
    let loaded = false;
    let minuteBars: Bar[] = [];

    // Indicators are recomputed from the full history on every update (a few thousand bars at most),
    // then either drawn whole (initial load) or only the last point is pushed (live updates).
    const render = (full: boolean) => {
      const bars = aggregate(minuteBars, timeframe);
      if (!bars.length) return;
      const series: [ISeriesApi<'Line'>, { time: UTCTimestamp; value: number }[]][] = [
        [vwapSeries, line(bars, vwap(bars))],
        [ema9Series, line(bars, ema(bars, 9))],
        [ema20Series, line(bars, ema(bars, 20))],
        [rsiSeries, line(bars, rsi(bars, 14))],
      ];
      if (full) {
        candles.setData(bars.map(toCandle));
        volume.setData(bars.map(toVolume));
        for (const [s, data] of series) s.setData(data);
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 5 });
      } else {
        candles.update(toCandle(bars.at(-1)!));
        volume.update(toVolume(bars.at(-1)!));
        for (const [s, data] of series) if (data.length) s.update(data.at(-1)!);
      }
      atrRef.current(atr(bars, 14).at(-1) ?? null);
    };

    api.bars(symbol).then((bars) => {
      if (cancelled) return;
      minuteBars = bars;
      loaded = true;
      render(true);
    });
    const off = onBar((b) => {
      if (!loaded || b.symbol !== symbol) return;
      const last = minuteBars.at(-1);
      if (last && b.t < last.t) return;
      if (last && b.t === last.t) minuteBars[minuteBars.length - 1] = b;
      else minuteBars.push(b);
      render(false);
    });

    return () => {
      cancelled = true;
      off();
      chart.remove();
      linesRef.current = [];
      atrRef.current(null);
    };
  }, [symbol, timeframe]);

  // Working orders and the average entry price as horizontal lines.
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    for (const l of linesRef.current) candles.removePriceLine(l);
    linesRef.current = [];
    if (position && position.qty !== 0) {
      linesRef.current.push(candles.createPriceLine({
        price: position.avgPrice, color: '#4c8dff', lineWidth: 2, lineStyle: LineStyle.Solid,
        title: `${position.qty > 0 ? 'לונג' : 'שורט'} ${Math.abs(position.qty)}`,
      }));
    }
    for (const o of orders) {
      const p = o.type === 'stop' || (o.type === 'stop_limit' && !o.triggered) ? o.stopPrice : o.limitPrice;
      if (!p) continue;
      linesRef.current.push(candles.createPriceLine({
        price: p, color: o.side === 'buy' ? '#26a69a' : '#ef5350', lineWidth: 1,
        lineStyle: o.status === 'held' ? LineStyle.SparseDotted : LineStyle.Dashed,
        title: `${o.parentId ? (o.type === 'stop' ? 'סטופ' : 'יעד') : ORDER_TYPE[o.type]} ${SIDE[o.side]} ${o.qty - o.filledQty}`,
      }));
    }
  }, [orders, position, symbol, timeframe]);

  return <div className="chart" ref={el} />;
}
