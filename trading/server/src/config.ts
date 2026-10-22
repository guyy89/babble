import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FeeSchedule } from './broker/fees.js';
import type { MarginModel } from './broker/margin.js';

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
  marginModel: MarginModel;
  slippageBps: number;
  fees: FeeSchedule;
  /** Fraction of displayed size we assume we can take per quote update. */
  liquidityFraction: number;
  /** Execute no further than this from the last trade, in bps (single-venue feeds show inflated spreads). 0 disables. */
  maxQuoteDeviationBps: number;
}

export interface RiskConfig {
  maxDailyLoss: number;
  /** Max loss to the stop for a single new position; 0 disables (and stops being mandatory). */
  maxRiskPerTrade: number;
  maxPositionNotional: number;
  maxOrderNotional: number;
  flattenMinutesBeforeClose: number;
}

export const config = {
  port: num('PORT', 4000),
  dataSource: str('DATA_SOURCE', 'sim') as 'sim' | 'alpaca' | 'replay',
  // Replay a recorded day (needs Alpaca keys): REPLAY_DATE=YYYY-MM-DD, REPLAY_SPEED=× real time.
  replay: { date: str('REPLAY_DATE', ''), speed: num('REPLAY_SPEED', 5) },
  // paper = local simulator; alpaca-paper = orders go to Alpaca's paper trading account (needs paper keys).
  broker: str('BROKER', 'paper') as 'paper' | 'alpaca-paper',
  symbols: str('SYMBOLS', 'AAPL,MSFT,NVDA,TSLA,AMD,SPY,QQQ')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  alpaca: {
    keyId: str('ALPACA_KEY_ID', ''),
    secretKey: str('ALPACA_SECRET_KEY', ''),
    feed: str('ALPACA_FEED', 'iex'),
    // Asset list (for search). Paper keys only work against the paper endpoint.
    tradingUrl: str('ALPACA_TRADING_URL', 'https://paper-api.alpaca.markets'),
  },
  dataDir: str('DATA_DIR', resolve(process.cwd(), 'data')),
  paper: {
    startingCash: num('STARTING_CASH', 5000),
    accountType: str('ACCOUNT_TYPE', 'margin') as 'cash' | 'margin',
    marginModel: str('MARGIN_MODEL', 'intraday') as MarginModel,
    slippageBps: num('SLIPPAGE_BPS', 2),
    // IBKR Pro Fixed + pass-through regulatory fees (rates current as of 2026-10).
    fees: {
      commissionPerShare: num('COMMISSION_PER_SHARE', 0.005),
      minCommission: num('MIN_COMMISSION', 1),
      maxCommissionPct: num('MAX_COMMISSION_PCT', 0.01),
      secFeePerMillion: num('SEC_FEE_PER_MILLION', 20.6),
      tafPerShare: num('FINRA_TAF_PER_SHARE', 0.000195),
      tafMaxPerTrade: num('FINRA_TAF_MAX', 9.79),
    },
    liquidityFraction: num('LIQUIDITY_FRACTION', 1),
    maxQuoteDeviationBps: num('MAX_QUOTE_DEVIATION_BPS', 10),
  } satisfies PaperConfig,
  risk: {
    maxDailyLoss: num('MAX_DAILY_LOSS', 150),
    maxRiskPerTrade: num('MAX_RISK_PER_TRADE', 50),
    maxPositionNotional: num('MAX_POSITION_NOTIONAL', 10000),
    maxOrderNotional: num('MAX_ORDER_NOTIONAL', 10000),
    flattenMinutesBeforeClose: num('FLATTEN_MINUTES_BEFORE_CLOSE', 5),
  } satisfies RiskConfig,
  // Momentum-basket robot (forward test of r2_xsmom), trading in the main paper account.
  xsmom: {
    riskPerLeg: num('XSMOM_RISK_PER_LEG', 200),
    /** Close the whole basket once the day's net P&L reaches this many $ (0 = hold to the close). */
    dayTakeProfit: num('XSMOM_DAY_TAKE_PROFIT', 0),
  },
};

export type AppConfig = typeof config;
