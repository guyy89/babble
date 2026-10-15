import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../api';
import { onBar, type Bar, type Order, type Position } from '../store';

const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const fmtTime = (t: Time) => nyTime.format(new Date((t as number) * 1000));

const toCandle = (b: Bar) => ({ time: (b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });
const toVolume = (b: Bar) => ({
  time: (b.t / 1000) as UTCTimestamp, value: b.v, color: b.c >= b.o ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)',
});

/** Session VWAP, reset at each New York trading day. */
class Vwap {
  private day = '';
  private pv = 0;
  private vol = 0;
  private lastBar?: Bar;

  push(b: Bar): number {
    const day = nyDay.format(new Date(b.t));
    if (day !== this.day) {
      this.day = day; this.pv = 0; this.vol = 0; this.lastBar = undefined;
    }
    // Re-applying an update of the same bar: remove its previous contribution first.
    if (this.lastBar && this.lastBar.t === b.t) {
      this.pv -= typical(this.lastBar) * this.lastBar.v;
      this.vol -= this.lastBar.v;
    }
    this.pv += typical(b) * b.v;
    this.vol += b.v;
    this.lastBar = { ...b };
    return this.vol > 0 ? this.pv / this.vol : b.c;
  }
}
const typical = (b: Bar) => (b.h + b.l + b.c) / 3;

interface Props {
  symbol: string;
  orders: Order[];
  position?: Position;
  onPickPrice: (price: number) => void;
}

export function Chart({ symbol, orders, position, onPickPrice }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(undefined);
  const candlesRef = useRef<ISeriesApi<'Candlestick'>>(undefined);
  const linesRef = useRef<IPriceLine[]>([]);
  const pickRef = useRef(onPickPrice);
  pickRef.current = onPickPrice;

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
    const vwapSeries = chart.addSeries(LineSeries, {
      color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    candlesRef.current = candles;

    chart.subscribeClick((param) => {
      if (!param.point) return;
      const p = candles.coordinateToPrice(param.point.y);
      if (p !== null) pickRef.current(Math.round(p * 100) / 100);
    });

    let cancelled = false;
    const vwap = new Vwap();
    let lastT = 0;
    api.bars(symbol).then((bars) => {
      if (cancelled) return;
      candles.setData(bars.map(toCandle));
      volume.setData(bars.map(toVolume));
      vwapSeries.setData(bars.map((b) => ({ time: (b.t / 1000) as UTCTimestamp, value: vwap.push(b) })));
      lastT = bars.at(-1)?.t ?? 0;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 5 });
    });
    const off = onBar((b) => {
      if (b.symbol !== symbol || b.t < lastT) return;
      lastT = b.t;
      candles.update(toCandle(b));
      volume.update(toVolume(b));
      vwapSeries.update({ time: (b.t / 1000) as UTCTimestamp, value: vwap.push(b) });
    });

    return () => {
      cancelled = true;
      off();
      chart.remove();
      linesRef.current = [];
    };
  }, [symbol]);

  // Working orders and the average entry price as horizontal lines.
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles) return;
    for (const l of linesRef.current) candles.removePriceLine(l);
    linesRef.current = [];
    if (position && position.qty !== 0) {
      linesRef.current.push(candles.createPriceLine({
        price: position.avgPrice, color: '#4c8dff', lineWidth: 2, lineStyle: LineStyle.Solid,
        title: `${position.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(position.qty)}`,
      }));
    }
    for (const o of orders) {
      const p = o.type === 'stop' || (o.type === 'stop_limit' && !o.triggered) ? o.stopPrice : o.limitPrice;
      if (!p) continue;
      linesRef.current.push(candles.createPriceLine({
        price: p, color: o.side === 'buy' ? '#26a69a' : '#ef5350', lineWidth: 1,
        lineStyle: o.status === 'held' ? LineStyle.SparseDotted : LineStyle.Dashed,
        title: `${o.parentId ? (o.type === 'stop' ? 'SL' : 'TP') : o.type.toUpperCase()} ${o.side} ${o.qty - o.filledQty}`,
      }));
    }
  }, [orders, position, symbol]);

  return <div className="chart" ref={el} />;
}
