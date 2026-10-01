// Real market prices via free keyless public APIs.
// Primary: CoinGecko simple/price. Fallback: CoinCap v2. Last resort: cached.
// Never invents a price: if no source responds, prices are marked stale/unavailable
// and trading is blocked (no trading on invented numbers).
import { CONFIG } from './config.js';

const ids = Object.values(CONFIG.SYMBOLS).map(s => s.coingeckoId).join(',');
const coincapIds = Object.keys(CONFIG.SYMBOLS).map(s => s.toLowerCase()).join(',');

export function createPriceFeed(fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const cache = new Map(); // symbol -> { price, at }

  async function fromCoinGecko() {
    const url = `${CONFIG.COINGECKO_URL}?ids=${ids}&vs_currencies=usd`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error('coingecko ' + res.status);
    const data = await res.json();
    const out = {};
    for (const [sym, meta] of Object.entries(CONFIG.SYMBOLS)) {
      const p = data[meta.coingeckoId]?.usd;
      if (typeof p === 'number' && p > 0) out[sym] = p;
    }
    return out;
  }

  async function fromCoinCap() {
    const url = `${CONFIG.COINCAP_URL}?ids=${coincapIds}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error('coincap ' + res.status);
    const data = await res.json();
    const out = {};
    for (const row of data.data || []) {
      const sym = (row.symbol || '').toUpperCase();
      const p = parseFloat(row.priceUsd);
      if (CONFIG.SYMBOLS[sym] && p > 0) out[sym] = p;
    }
    return out;
  }

  return {
    cache,
    async refresh() {
      let prices = null;
      let source = null;
      try { prices = await fromCoinGecko(); source = 'coingecko'; }
      catch { /* fall through */ }
      if (!prices || Object.keys(prices).length === 0) {
        try { prices = await fromCoinCap(); source = 'coincap'; }
        catch { /* fall through */ }
      }
      const now = Date.now();
      if (prices) {
        for (const [sym, price] of Object.entries(prices)) {
          cache.set(sym, { price, at: now, source });
        }
        return { ok: true, source, count: Object.keys(prices).length };
      }
      return { ok: false, source: null, count: 0 };
    },
    get(symbol) {
      const e = cache.get(symbol);
      if (!e) return { price: null, stale: true, at: null, source: null };
      return { ...e, stale: Date.now() - e.at > CONFIG.PRICE_STALE_MS };
    },
    hasFresh(symbol) {
      const e = cache.get(symbol);
      return !!e && (Date.now() - e.at) <= CONFIG.PRICE_STALE_MS;
    },
    // test hook
    _set(symbol, price, at = Date.now()) {
      cache.set(symbol, { price, at, source: 'test' });
    },
  };
}
