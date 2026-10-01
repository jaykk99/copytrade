// Read-only wallet linking. NO private keys, NO seed phrases, NO signing — ever.
// The user pastes a PUBLIC address (found in Trust Wallet under Settings).
// Balances are fetched from the free keyless Blockchair API.
import { CONFIG } from './config.js';

const CHAINS = {
  ethereum: { label: 'Ethereum', tickers: ['ETH'] },
  bitcoin: { label: 'Bitcoin', tickers: ['BTC'] },
  bnb: { label: 'BNB Chain', tickers: ['BNB'] },
  solana: { label: 'Solana', tickers: ['SOL'] },
  dogecoin: { label: 'Dogecoin', tickers: ['DOGE'] },
  cardano: { label: 'Cardano', tickers: ['ADA'] },
  ripple: { label: 'XRP', tickers: ['XRP'] },
};

export function detectChain(address) {
  const a = (address || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ethereum'; // also BNB Chain EVM
  if (/^(bc1|[13])[a-zA-Z0-9]{25,62}$/.test(a)) return 'bitcoin';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'solana';
  if (/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return 'dogecoin';
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return 'ripple';
  if (/^addr1[0-9a-z]{50,100}$/.test(a)) return 'cardano';
  return null;
}

export async function fetchAddressBalance(chain, address, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const url = `${CONFIG.BLOCKCHAIR_URL}/${chain}/dashboards/address/${encodeURIComponent(address)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error('balance lookup failed: ' + res.status);
  const data = await res.json();
  const info = data?.data?.[address];
  if (!info) throw new Error('address not found');
  const addr = info.address || {};
  // balance in base units; convert per chain
  const decimals = { ethereum: 18, bitcoin: 8, dogecoin: 8, ripple: 6, cardano: 6, solana: 9, bnb: 18 }[chain] ?? 18;
  const balance = Number(addr.balance || 0) / Math.pow(10, decimals);
  return {
    chain,
    label: CHAINS[chain]?.label || chain,
    balance,
    ticker: (CHAINS[chain]?.tickers || ['?'])[0],
    txCount: addr.transaction_count ?? null,
  };
}

export function shortAddress(a) {
  a = String(a || '');
  return a.length > 13 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
}
