// Paper-trading engine. PURE LOGIC — no DOM, no network.
// Simulated funds only. Real-money execution must NEVER be added here;
// see js/live-trading.js which is a hard-disabled stub.
import { CONFIG } from './config.js';

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function newState() {
  return { traders: {}, follows: [], createdAt: Date.now() };
}

export function createTrader(state, name) {
  const clean = String(name || '').trim().slice(0, 24) || 'Trader';
  const id = uid('tr');
  state.traders[id] = {
    id,
    name: clean,
    cash: CONFIG.PAPER_STARTING_BALANCE_USD,
    positions: {}, // symbol -> { qty, avgEntry }
    realizedPnl: 0,
    trades: [],
    createdAt: Date.now(),
  };
  return state.traders[id];
}

export function getTrader(state, id) {
  return state.traders[id] || null;
}

// priceOf: (symbol) -> number | null
export function portfolioValue(trader, priceOf) {
  let pos = 0;
  for (const [sym, p] of Object.entries(trader.positions)) {
    const px = priceOf(sym);
    if (px != null) pos += p.qty * px;
  }
  return trader.cash + pos;
}

export function totalPnl(trader, priceOf) {
  return portfolioValue(trader, priceOf) - CONFIG.PAPER_STARTING_BALANCE_USD;
}

export function winRate(trader) {
  // Any closing trade (long sell OR short cover) with a realized P&L counts.
  const closed = trader.trades.filter(t => typeof t.realizedPnl === 'number');
  if (closed.length === 0) return null;
  const wins = closed.filter(t => t.realizedPnl > 0).length;
  return wins / closed.length;
}

// opts: { symbol, side: 'buy'|'sell', qty, price, at?, equity? }
// Long AND short paper positions. Shorts are cash-credited on open and
// cash-debited on cover; paper margin rule: short notional <= equity (no leverage).
// Returns { ok, trade?, error? }
export function placePaperTrade(state, traderId, opts) {
  const trader = getTrader(state, traderId);
  if (!trader) return { ok: false, error: 'unknown trader' };
  const symbol = String(opts.symbol || '').toUpperCase();
  if (!CONFIG.SYMBOLS[symbol]) return { ok: false, error: 'unsupported symbol' };
  const side = opts.side;
  if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'side must be buy|sell' };
  const qty = Number(opts.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'qty must be > 0' };
  const price = Number(opts.price);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'invalid price' };
  const at = Number(opts.at) > 0 ? Number(opts.at) : Date.now();
  const equity = Number(opts.equity);

  const notional = qty * price;
  const fee = notional * CONFIG.PAPER_FEE_RATE;
  let realizedPnl = null;
  const pos = trader.positions[symbol];

  if (side === 'buy') {
    if (pos && pos.qty < -1e-12) {
      // cover a short (full or partial; never flip in one trade)
      const shortQty = -pos.qty;
      if (qty > shortQty + 1e-12) return { ok: false, error: 'cover qty exceeds short; close first' };
      const cost = notional + fee;
      if (cost > trader.cash + 1e-9) return { ok: false, error: 'insufficient paper cash to cover' };
      realizedPnl = qty * (pos.avgEntry - price) - fee;
      trader.cash -= cost;
      trader.realizedPnl += realizedPnl;
      pos.qty += qty;
      if (Math.abs(pos.qty) <= 1e-12) delete trader.positions[symbol];
    } else {
      // open/add long
      const cost = notional + fee;
      if (cost > trader.cash + 1e-9) return { ok: false, error: 'insufficient paper cash' };
      trader.cash -= cost;
      const p = pos || { qty: 0, avgEntry: 0 };
      const newQty = p.qty + qty;
      p.avgEntry = (p.qty * p.avgEntry + qty * price) / newQty;
      p.qty = newQty;
      trader.positions[symbol] = p;
    }
  } else {
    if (pos && pos.qty > 1e-12) {
      // close/trim long
      if (qty > pos.qty + 1e-12) return { ok: false, error: 'insufficient position' };
      realizedPnl = qty * (price - pos.avgEntry) - fee;
      trader.cash += notional - fee;
      trader.realizedPnl += realizedPnl;
      pos.qty -= qty;
      if (pos.qty <= 1e-12) delete trader.positions[symbol];
    } else if (pos && pos.qty < -1e-12) {
      return { ok: false, error: 'already short; buy to cover first' };
    } else {
      // open short (paper margin: no leverage)
      if (Number.isFinite(equity) && notional > equity + 1e-9) {
        return { ok: false, error: 'short exceeds paper equity (no leverage)' };
      }
      trader.cash += notional - fee;
      trader.positions[symbol] = { qty: -qty, avgEntry: price };
    }
  }

  const trade = {
    id: uid('tx'),
    traderId,
    symbol,
    side,
    qty,
    price,
    notional,
    fee,
    at,
    realizedPnl,
  };
  trader.trades.push(trade);
  return { ok: true, trade };
}

// Leaderboard: every row traces to real recorded paper trades. No seeds, no fakes.
export function leaderboard(state, priceOf) {
  const rows = Object.values(state.traders).map(t => ({
    id: t.id,
    name: t.name,
    trades: t.trades.length,
    realizedPnl: t.realizedPnl,
    totalPnl: totalPnl(t, priceOf),
    portfolioValue: portfolioValue(t, priceOf),
    winRate: winRate(t),
    lastTradeAt: t.trades.length ? t.trades[t.trades.length - 1].at : null,
    createdAt: t.createdAt,
  }));
  rows.sort((a, b) => b.totalPnl - a.totalPnl || (b.winRate ?? -1) - (a.winRate ?? -1) || a.createdAt - b.createdAt);
  return rows;
}

export function tradeHistory(state, traderId, limit = 100) {
  const t = getTrader(state, traderId);
  if (!t) return [];
  return [...t.trades].reverse().slice(0, limit);
}

// Export / import a trader profile (share codes). Only real recorded trades travel.
export function exportTrader(state, traderId) {
  const t = getTrader(state, traderId);
  if (!t) return null;
  return JSON.stringify({ v: 1, trader: t });
}

export function importTrader(state, json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return { ok: false, error: 'bad share code' }; }
  const t = parsed && parsed.trader;
  if (!t || !t.id || !Array.isArray(t.trades)) return { ok: false, error: 'bad share code' };
  if (state.traders[t.id]) return { ok: false, error: 'trader already imported' };
  // sanitize: keep only known fields
  state.traders[t.id] = {
    id: String(t.id),
    name: String(t.name || 'Trader').slice(0, 24),
    cash: Number(t.cash) || 0,
    positions: t.positions && typeof t.positions === 'object' ? t.positions : {},
    realizedPnl: Number(t.realizedPnl) || 0,
    trades: t.trades.filter(x => x && x.symbol && x.side && x.at).map(x => ({
      id: String(x.id), traderId: String(t.id), symbol: String(x.symbol),
      side: x.side, qty: Number(x.qty), price: Number(x.price),
      notional: Number(x.notional), fee: Number(x.fee), at: Number(x.at),
      realizedPnl: typeof x.realizedPnl === 'number' ? x.realizedPnl : null,
    })),
    createdAt: Number(t.createdAt) || Date.now(),
  };
  return { ok: true, trader: state.traders[t.id] };
}
