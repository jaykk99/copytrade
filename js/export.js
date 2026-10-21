// CSV export for paper-trading data. PURE LOGIC except downloadCsv().
// Exports cover trades and leaderboard rows — everything the app can show,
// nothing sensitive (paper data only, no keys/addresses beyond public ones).
import { leaderboard } from './engine.js';

function esc(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return lines.join('\n') + '\n';
}

export function tradesToCsv(trades) {
  const headers = ['id', 'traderId', 'symbol', 'side', 'qty', 'price', 'notional', 'fee', 'realizedPnl', 'at', 'isoTime', 'copiedFrom'];
  const rows = [...trades].sort((a, b) => a.at - b.at).map(t => [
    t.id, t.traderId, t.symbol, t.side, t.qty, t.price, t.notional, t.fee,
    t.realizedPnl, t.at, new Date(t.at).toISOString(), t.copiedFrom || '',
  ]);
  return toCsv(headers, rows);
}

export function leaderboardToCsv(state, priceOf) {
  const rows = leaderboard(state, priceOf);
  const headers = ['rank', 'traderId', 'name', 'trades', 'winRate', 'realizedPnl', 'totalPnl', 'portfolioValue', 'lastTradeAt'];
  return toCsv(headers, rows.map((r, i) => [
    i + 1, r.id, r.name, r.trades,
    r.winRate == null ? '' : r.winRate.toFixed(4),
    r.realizedPnl.toFixed(2), r.totalPnl.toFixed(2), r.portfolioValue.toFixed(2),
    r.lastTradeAt ? new Date(r.lastTradeAt).toISOString() : '',
  ]));
}

// analytics report -> CSV of per-symbol breakdown
export function perSymbolToCsv(perSymbolRows) {
  const headers = ['symbol', 'trades', 'closed', 'wins', 'winRate', 'realizedPnl', 'volume', 'fees'];
  return toCsv(headers, perSymbolRows.map(s => [
    s.symbol, s.trades, s.closed, s.wins,
    s.winRate == null ? '' : s.winRate.toFixed(4),
    s.realizedPnl.toFixed(2), s.volume.toFixed(2), s.fees.toFixed(2),
  ]));
}

// monthly pnl -> CSV
export function monthlyToCsv(monthlyRows) {
  return toCsv(['month', 'realizedPnl'], monthlyRows.map(m => [m.month, m.pnl.toFixed(2)]));
}

// Browser download helper (DOM). Keep filename safe.
export function downloadCsv(filename, csv) {
  const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe.endsWith('.csv') ? safe : safe + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
