import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { BrokerError } from '../broker/broker.js';
import type { TradingService } from '../tradingService.js';
import type { OrderRequest } from '../types.js';

export function createApiServer(svc: TradingService): Server {
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
    res.json(feed.symbols().map((s) => ({ symbol: s, quote: feed.getQuote(s) ?? null })));
  });
  app.get('/api/bars/:symbol', (req, res) => {
    res.json(feed.getBars(req.params.symbol.toUpperCase()));
  });
  app.get('/api/account', async (_req, res) => {
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

  wss.on('connection', async (ws) => {
    // Initial snapshot so the client never has to stitch REST + stream timing together.
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: {
        clock: clock.state(),
        dataSource: feed.name,
        broker: broker.name,
        symbols: feed.symbols(),
        quotes: feed.symbols().map((s) => feed.getQuote(s)).filter(Boolean),
        account: await svc.account(),
        positions: await broker.getPositions(),
        orders: await broker.getOrders('all'),
        fills: (await broker.getFills()).slice(0, 200),
      },
    }));
  });

  svc.on('event', (ev) => {
    const msg = JSON.stringify(ev);
    for (const client of wss.clients) {
      // Drop quote updates for slow clients instead of letting the buffer grow unbounded.
      if (client.readyState !== WebSocket.OPEN) continue;
      if (ev.type === 'quote' && client.bufferedAmount > 1_000_000) continue;
      client.send(msg);
    }
  });

  return server;
}
