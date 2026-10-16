import { BASE_PRICES } from './simFeed.js';

export interface SymbolInfo {
  symbol: string;
  name: string;
  exchange: string;
}

/** Searchable list of tradable symbols with company names. */
export class SymbolDirectory {
  private list: SymbolInfo[] = [];
  private bySymbol = new Map<string, SymbolInfo>();

  constructor(private readonly loader: () => Promise<SymbolInfo[]>) {}

  async load(): Promise<void> {
    try {
      this.list = await this.loader();
      this.bySymbol = new Map(this.list.map((s) => [s.symbol, s]));
      console.log(`[symbols] ${this.list.length} symbols loaded`);
    } catch (err) {
      // Search degrades to "not found"; trading on the existing watchlist keeps working.
      console.error('[symbols] could not load the symbol list:', err);
    }
  }

  all(): SymbolInfo[] {
    return this.list;
  }

  get(symbol: string): SymbolInfo | undefined {
    return this.bySymbol.get(symbol.toUpperCase());
  }

  /** Exact symbol first, then symbol prefix, then company-name word prefix, then name substring. */
  search(query: string, limit = 20): SymbolInfo[] {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const scored: [number, SymbolInfo][] = [];
    for (const s of this.list) {
      const name = s.name.toUpperCase();
      let score: number;
      if (s.symbol === q) score = 0;
      else if (s.symbol.startsWith(q)) score = 1;
      else if (name.startsWith(q) || name.includes(` ${q}`)) score = 2;
      else if (name.includes(q)) score = 3;
      else continue;
      scored.push([score, s]);
    }
    return scored
      .sort((a, b) => a[0] - b[0] || a[1].symbol.length - b[1].symbol.length || a[1].symbol.localeCompare(b[1].symbol))
      .slice(0, limit)
      .map(([, s]) => s);
  }
}

// Alpaca appends the share class to most names ("Apple Inc. Common Stock").
const SUFFIX = /\s+(Class [A-Z] )?(Common Stock|Ordinary Shares|Common Shares|American Depositary Shares.*)$/i;

/** Tradable, exchange-listed US equities from Alpaca's Trading API (OTC is excluded). */
export function alpacaSymbols(creds: { keyId: string; secretKey: string; tradingUrl: string }) {
  return async (): Promise<SymbolInfo[]> => {
    const res = await fetch(`${creds.tradingUrl}/v2/assets?status=active&asset_class=us_equity`, {
      headers: { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey },
    });
    if (!res.ok) throw new Error(`Alpaca assets: ${res.status} ${await res.text()}`);
    const assets = (await res.json()) as Array<{ symbol: string; name: string; exchange: string; tradable: boolean }>;
    return assets
      .filter((a) => a.tradable && a.exchange !== 'OTC')
      .map((a) => ({ symbol: a.symbol, name: (a.name || a.symbol).replace(SUFFIX, ''), exchange: a.exchange }));
  };
}

const SIM_NAMES: Record<string, string> = {
  AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation', NVDA: 'NVIDIA Corporation', TSLA: 'Tesla, Inc.',
  AMD: 'Advanced Micro Devices, Inc.', SPY: 'SPDR S&P 500 ETF Trust', QQQ: 'Invesco QQQ Trust',
  META: 'Meta Platforms, Inc.', AMZN: 'Amazon.com, Inc.', GOOGL: 'Alphabet Inc.',
};

/** Simulated market: the handful of symbols the synthetic feed has base prices for. */
export async function simSymbols(): Promise<SymbolInfo[]> {
  return Object.keys(BASE_PRICES).map((symbol) => ({ symbol, name: SIM_NAMES[symbol] ?? symbol, exchange: 'SIM' }));
}
