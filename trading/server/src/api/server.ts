import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { BrokerError } from '../broker/broker.js';
import type { FeeSchedule } from '../broker/fees.js';
import type { RiskConfig } from '../config.js';
import type { OrbBot } from '../bot/orbBot.js';
import type { XsMomBot } from '../bot/xsMomBot.js';
import { buildJournal } from '../journal.js';
import { researchProgress } from '../research/progress.js';
import type { Movers } from '../market/movers.js';
import type { ScanFilter, ScanRow } from '../market/scanner.js';
import type { TradingService } from '../tradingService.js';
import type { NewsItem, OrderRequest } from '../types.js';

export interface MarketServices {
  movers: () => Promise<Movers>;
  scan: (filter: ScanFilter) => Promise<ScanRow[]>;
  news: (symbol: string) => Promise<NewsItem[]>;
}

const numParam = (v: unknown) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Wraps a data-provider call so an upstream failure becomes a readable 502 instead of a generic 500. */
async function upstream<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[${what}]`, err);
    throw new BrokerError(`לא הצלחתי לטעון ${what} מספק הנתונים`, 502);
  }
}

export interface PublicSettings {
  fees?: FeeSchedule;
  risk: RiskConfig;
}

export function createApiServer(
  svc: TradingService, settings: PublicSettings, market: MarketServices, bot: OrbBot,
  replay?: { date: string; speed: number },
  xsBot?: XsMomBot,
): Server {
  const app = express();
  app.use(express.json());

  const { feed, broker, clock } = svc;

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, data: feed.name, broker: broker.name });
  });
  app.get('/api/clock', (_req, res) => {
    res.json(clock.state());
  });
  app.get('/api/symbols', (_req, res) => {
    res.json(svc.watchlist().map((w) => ({ ...w, quote: feed.getQuote(w.symbol) ?? null })));
  });
  app.get('/api/search', (req, res) => {
    res.json(svc.directory.search(String(req.query.q ?? ''), 20));
  });
  app.get('/api/movers', async (_req, res) => {
    res.json(await upstream('את רשימת המניות שזזות היום', market.movers));
  });
  app.post('/api/watchlist', async (req, res) => {
    await svc.addSymbol(String(req.body?.symbol ?? ''));
    res.json(svc.watchlist());
  });
  app.delete('/api/watchlist/:symbol', async (req, res) => {
    await svc.removeSymbol(req.params.symbol);
    res.json(svc.watchlist());
  });
  app.get('/api/bars/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (req.query.tf === 'day') return void res.json(await upstream('נרות יומיים', () => feed.dailyBars(symbol)));
    res.json(feed.getBars(symbol));
  });
  app.get('/api/news/:symbol', async (req, res) => {
    res.json(await upstream('חדשות', () => market.news(req.params.symbol.toUpperCase())));
  });
  app.get('/api/scan', async (req, res) => {
    const q = req.query;
    const filter: ScanFilter = {
      minPrice: numParam(q.minPrice), maxPrice: numParam(q.maxPrice), minVolume: numParam(q.minVolume),
      minChangePct: numParam(q.minChangePct), minGapPct: numParam(q.minGapPct),
      direction: q.direction === 'up' || q.direction === 'down' ? q.direction : 'any',
      sort: q.sort === 'gap' || q.sort === 'volume' ? q.sort : 'change',
    };
    res.json(await upstream('תוצאות סריקה', () => market.scan(filter)));
  });
  app.get('/api/bot', (_req, res) => {
    res.json(bot.status());
  });
  app.post('/api/bot', (req, res) => {
    try {
      bot.setEnabled(Boolean(req.body?.enabled));
    } catch (err) {
      throw new BrokerError((err as Error).message, 409);
    }
    res.json(bot.status());
  });
  app.get('/api/xsbot', async (_req, res) => {
    if (!xsBot) throw new BrokerError('רובוט הסל לא פעיל', 404);
    res.json(await xsBot.status());
  });
  app.post('/api/xsbot', async (req, res) => {
    if (!xsBot) throw new BrokerError('רובוט הסל לא פעיל', 404);
    try {
      xsBot.setEnabled(Boolean(req.body?.enabled));
    } catch (err) {
      throw new BrokerError((err as Error).message, 409);
    }
    res.json(await xsBot.status());
  });
  app.get('/api/research/progress', (_req, res) => {
    res.json(researchProgress());
  });
  app.get('/api/journal', async (_req, res) => {
    res.json(buildJournal((await broker.getFills()).reverse(), await broker.getOrders('all')));
  });
  app.get('/api/account', async (_req, res) => {
    res.json(await svc.account());
  });
  app.get('/api/settings', (_req, res) => {
    res.json(settings);
  });
  app.post('/api/account/reset', async (_req, res) => {
    const resettable = broker as typeof broker & { reset?: () => Promise<void> };
    if (!resettable.reset) throw new BrokerError('אפשר לאפס רק חשבון מדומה', 409);
    await resettable.reset();
    const msg = await snapshot();
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(msg);
    svc.notice('info', 'החשבון המדומה אופס');
    res.json(await svc.account());
  });
  app.get('/api/positions', async (_req, res) => {
    res.json(await broker.getPositions());
  });
  app.get('/api/orders', async (req, res) => {
    res.json(await broker.getOrders(req.query.status === 'open' ? 'open' : 'all'));
  });
  app.get('/api/fills', async (_req, res) => {
    res.json(await broker.getFills());
  });
  app.post('/api/orders', async (req, res) => {
    const order = await svc.submitOrder(req.body as OrderRequest);
    res.status(order.status === 'rejected' ? 422 : 201).json(order);
  });
  app.patch('/api/orders/:id', async (req, res) => {
    const b = req.body ?? {};
    res.json(await broker.modifyOrder(req.params.id, {
      limitPrice: numParam(b.limitPrice), stopPrice: numParam(b.stopPrice),
      trailAmount: b.trailAmount === null ? null : numParam(b.trailAmount),
    }));
  });
  app.delete('/api/orders/:id', async (req, res) => {
    res.json(await broker.cancelOrder(req.params.id));
  });
  app.delete('/api/orders', async (_req, res) => {
    await broker.cancelAll();
    res.status(204).end();
  });
  app.delete('/api/positions/:symbol', async (req, res) => {
    const order = await broker.closePosition(req.params.symbol.toUpperCase());
    res.json(order ?? null);
  });
  app.delete('/api/positions', async (_req, res) => {
    await broker.closeAll();
    res.status(204).end();
  });

  // Production: serve the built web app from the same origin.
  const webDist = resolve(import.meta.dirname, '../../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BrokerError) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Full state, sent on connect (so the client never stitches REST + stream timing together)
  // and broadcast after an account reset.
  const snapshot = async () =>
    JSON.stringify({
      type: 'snapshot',
      data: {
        clock: clock.state(),
        dataSource: feed.name,
        broker: broker.name,
        settings,
        symbols: svc.watchlist(),
        quotes: feed.symbols().map((s) => feed.getQuote(s)).filter(Boolean),
        account: await svc.account(),
        positions: await broker.getPositions(),
        orders: await broker.getOrders('all'),
        fills: (await broker.getFills()).slice(0, 200),
        bot: bot.status(),
        replay: replay ? { date: replay.date, speed: replay.speed } : null,
      },
    });

  wss.on('connection', async (ws) => {
    ws.send(await snapshot());
  });

  bot.on('status', (status) => svc.emit('event', { type: 'bot', data: status }));

  svc.on('event', (ev) => {
    const msg = JSON.stringify(ev);
    for (const client of wss.clients) {
      // Drop quote updates for slow clients instead of letting the buffer grow unbounded.
      if (client.readyState !== WebSocket.OPEN) continue;
      if ((ev.type === 'quote' || ev.type === 'trade') && client.bufferedAmount > 1_000_000) continue;
      client.send(msg);
    }
  });

  return server;
}
