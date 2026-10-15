import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader so the project has no runtime dependency for it.
function loadDotEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (!existsSync(candidate)) continue;
    for (const raw of readFileSync(candidate, 'utf8').split('\n')) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

loadDotEnv();

const str = (key: string, fallback: string) => process.env[key] || fallback;
const num = (key: string, fallback: number) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${key} must be a number, got "${v}"`);
  return n;
};

export interface PaperConfig {
  startingCash: number;
  accountType: 'cash' | 'margin';
  slippageBps: number;
  commissionPerShare: number;
  minCommission: number;
  /** Fraction of displayed size we assume we can take per quote update. */
  liquidityFraction: number;
}

export interface RiskConfig {
  maxDailyLoss: number;
  maxPositionNotional: number;
  maxOrderNotional: number;
  flattenMinutesBeforeClose: number;
}

export const config = {
  port: num('PORT', 4000),
  dataSource: str('DATA_SOURCE', 'sim') as 'sim' | 'alpaca',
  broker: str('BROKER', 'paper') as 'paper',
  symbols: str('SYMBOLS', 'AAPL,MSFT,NVDA,TSLA,AMD,SPY,QQQ')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  alpaca: {
    keyId: str('ALPACA_KEY_ID', ''),
    secretKey: str('ALPACA_SECRET_KEY', ''),
    feed: str('ALPACA_FEED', 'iex'),
  },
  dataDir: str('DATA_DIR', resolve(process.cwd(), 'data')),
  paper: {
    startingCash: num('STARTING_CASH', 30000),
    accountType: str('ACCOUNT_TYPE', 'margin') as 'cash' | 'margin',
    slippageBps: num('SLIPPAGE_BPS', 2),
    commissionPerShare: num('COMMISSION_PER_SHARE', 0),
    minCommission: num('MIN_COMMISSION', 0),
    liquidityFraction: num('LIQUIDITY_FRACTION', 1),
  } satisfies PaperConfig,
  risk: {
    maxDailyLoss: num('MAX_DAILY_LOSS', 500),
    maxPositionNotional: num('MAX_POSITION_NOTIONAL', 20000),
    maxOrderNotional: num('MAX_ORDER_NOTIONAL', 15000),
    flattenMinutesBeforeClose: num('FLATTEN_MINUTES_BEFORE_CLOSE', 5),
  } satisfies RiskConfig,
};

export type AppConfig = typeof config;
