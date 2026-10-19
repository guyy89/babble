import { describe, expect, it } from 'vitest';
import { AlpacaFeed } from '../src/market/alpacaFeed.js';

/** A feed whose network calls are replaced, to test only the stale-stream watchdog. */
function feed(open: boolean) {
  const f = new AlpacaFeed(['AAPL'], { keyId: 'k', secretKey: 's', feed: 'iex' }, () => open) as any;
  let connects = 0, refreshes = 0;
  f.connect = () => { connects++; };
  f.loadSnapshots = async () => { refreshes++; };
  const events: string[] = [];
  f.on('reconnect', (m: string) => events.push(m));
  return { f, events, counts: () => ({ connects, refreshes }) };
}

describe('AlpacaFeed watchdog', () => {
  it('replaces a silent stream during market hours and refreshes prices', async () => {
    const { f, events, counts } = feed(true);
    f.lastData = Date.now() - 120_000;
    await f.checkStale();
    expect(counts()).toEqual({ connects: 1, refreshes: 1 });
    expect(events).toHaveLength(1);
    // right after a reconnect it waits a full window before trying again
    await f.checkStale();
    expect(counts().connects).toBe(1);
  });

  it('leaves a quiet stream alone outside market hours and while data is flowing', async () => {
    const closed = feed(false);
    closed.f.lastData = Date.now() - 600_000;
    await closed.f.checkStale();
    expect(closed.counts().connects).toBe(0);

    const flowing = feed(true);
    flowing.f.lastData = Date.now() - 10_000;
    await flowing.f.checkStale();
    expect(flowing.counts().connects).toBe(0);
  });
});
