// Backtest / audit engine for paper trading. PURE LOGIC — no DOM, no network.
// Two jobs:
//   1. replay(): rebuild one trader's equity from their recorded trades and
//      verify the books agree (audit — catches bookkeeping bugs, not alpha).
//   2. runStrategy(): run a simple signal strategy over a price series to
//      produce a paper trade list (simulation only, no real execution).
// Paper only. No live trading paths exist in this module.
import { CONFIG } from './config.js';

// --- 1. replay / audit -------------------------------------------------------
// trades: array of { symbol, side, qty, price, at, fee?, realizedPnl? }
// Re-executes the cash/position accounting and returns what the engine
// believes the final state should be, plus any mismatches vs the recording.
export function replay(trades, opts = {}) {
  const feeRate = opts.feeRate ?? CONFIG.PAPER_FEE_RATE;
  const start = opts.startBalance ?? CONFIG.PAPER_STARTING_BALANCE_USD;
  const ordered = [...trades].sort((a, b) => a.at - b.at);
  let cash = start;
  const pos = {};
  const curve = [{ at: ordered[0] ? ordered[0].at : Date.now(), value: start }];
  const lastPx = {};
  const mismatches = [];
  let recomputedRealized = 0;

  for (const t of ordered) {
    const qty = Number(t.qty), px = Number(t.price);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) {
      mismatches.push({ tradeId: t.id, issue: 'bad qty/price', trade: t });
      continue;
    }
    lastPx[t.symbol] = px;
    const notional = qty * px;
    const fee = Number.isFinite(Number(t.fee)) ? Number(t.fee) : notional * feeRate;
    let realized = null;
    const p = pos[t.symbol];
    if (t.side === 'buy') {
      if (p && p.qty < 0) {
        realized = qty * (p.avgEntry - px) - fee;
        cash -= notional + fee;
        p.qty += qty;
        if (Math.abs(p.qty) <= 1e-12) delete pos[t.symbol];
      } else {
        cash -= notional + fee;
        const b = p || { qty: 0, avgEntry: 0 };
        const nq = b.qty + qty;
        b.avgEntry = (b.qty * b.avgEntry + qty * px) / nq;
        b.qty = nq;
        pos[t.symbol] = b;
      }
    } else if (t.side === 'sell') {
      if (p && p.qty > 0) {
        realized = qty * (px - p.avgEntry) - fee;
        cash += notional - fee;
        p.qty -= qty;
        if (p.qty <= 1e-12) delete pos[t.symbol];
      } else {
        cash += notional - fee;
        pos[t.symbol] = { qty: -(p ? Math.abs(p.qty) + qty : qty), avgEntry: px };
      }
    } else {
      mismatches.push({ tradeId: t.id, issue: 'bad side', trade: t });
      continue;
    }
    if (realized != null) {
      recomputedRealized += realized;
      if (typeof t.realizedPnl === 'number' && Math.abs(t.realizedPnl - realized) > 1e-6) {
        mismatches.push({ tradeId: t.id, issue: 'realizedPnl mismatch', recorded: t.realizedPnl, recomputed: realized });
      }
    }
    let value = cash;
    for (const [sym, pp] of Object.entries(pos)) {
      if (lastPx[sym] != null) value += pp.qty * lastPx[sym];
    }
    curve.push({ at: t.at, value });
  }
  // recorded realized total vs recomputed
  const recordedRealized = ordered.reduce((a, t) => a + (typeof t.realizedPnl === 'number' ? t.realizedPnl : 0), 0);
  return {
    finalCash: cash,
    finalPositions: pos,
    tradeCount: ordered.length,
    recomputedRealized,
    recordedRealized,
    realizedDelta: recordedRealized - recomputedRealized,
    equityCurve: curve,
    mismatches,
    clean: mismatches.length === 0 && Math.abs(recordedRealized - recomputedRealized) < 1e-6,
  };
}

// Audit every trader in a bot-log shaped object:
// { trades: [ {traderId, symbol, side, qty, price, at, fee, realizedPnl, ...} ] }
export function auditLog(log, opts = {}) {
  const byTrader = {};
  for (const t of (log.trades || [])) {
    const id = t.traderId || t.trader;
    if (!id) continue;
    (byTrader[id] = byTrader[id] || []).push(t);
  }
  return Object.entries(byTrader).map(([traderId, trades]) => {
    const r = replay(trades, opts);
    return { traderId, name: trades[0].trader || traderId, ...r };
  });
}

// --- 2. strategy backtest ----------------------------------------------------
// signals: array of { at, symbol, action: 'buy'|'sell'|'close', strength? }
// prices: { symbol: [ { at, price } ] } — sorted by at.
// Replays signals as paper trades at the first available price at/after the
// signal time. Returns the trade list + replay summary.
export function runStrategy(signals, prices, opts = {}) {
  const sizeUsd = opts.sizeUsd ?? 1000; // paper notional per signal
  const start = opts.startBalance ?? CONFIG.PAPER_STARTING_BALANCE_USD;
  const feeRate = opts.feeRate ?? CONFIG.PAPER_FEE_RATE;
  const series = {};
  for (const [sym, pts] of Object.entries(prices)) {
    series[sym] = [...pts].sort((a, b) => a.at - b.at);
  }
  function priceAt(sym, at) {
    const pts = series[sym];
    if (!pts || !pts.length) return null;
    let px = null;
    for (const p of pts) { if (p.at <= at) px = p.price; else break; }
    return px;
  }
  let cash = start;
  const pos = {};
  const trades = [];
  const sigs = [...signals].sort((a, b) => a.at - b.at);
  for (const s of sigs) {
    const px = priceAt(s.symbol, s.at);
    if (px == null || px <= 0) continue;
    const p = pos[s.symbol];
    const fee = (qty) => qty * px * feeRate;
    if (s.action === 'buy') {
      const qty = sizeUsd / px;
      const cost = qty * px + fee(qty);
      if (cost > cash) continue; // paper: skip when broke
      cash -= cost;
      const b = p && p.qty > 0 ? p : { qty: 0, avgEntry: 0 };
      const nq = b.qty + qty;
      b.avgEntry = nq > 0 ? (b.qty * b.avgEntry + qty * px) / nq : px;
      b.qty = nq;
      pos[s.symbol] = b;
      trades.push({ symbol: s.symbol, side: 'buy', qty, price: px, at: s.at, fee: fee(qty), realizedPnl: null });
    } else if (s.action === 'sell' || s.action === 'close') {
      if (!p || p.qty <= 0) continue;
      const qty = s.action === 'close' ? p.qty : Math.min(p.qty, sizeUsd / px);
      const realized = qty * (px - p.avgEntry) - fee(qty);
      cash += qty * px - fee(qty);
      p.qty -= qty;
      if (p.qty <= 1e-12) delete pos[s.symbol];
      trades.push({ symbol: s.symbol, side: 'sell', qty, price: px, at: s.at, fee: fee(qty), realizedPnl: realized });
    }
  }
  // mark remaining positions at last known prices for terminal equity
  let terminal = cash;
  for (const [sym, pp] of Object.entries(pos)) {
    const pts = series[sym];
    const last = pts && pts.length ? pts[pts.length - 1].price : null;
    if (last != null) terminal += pp.qty * last;
  }
  const summary = replay(trades, { startBalance: start, feeRate });
  return { trades, summary, terminalValue: terminal, totalPnl: terminal - start };
}

// Build simple crossover signals from a price series (demo/example strategy).
// fast/slow simple moving averages; buy on cross-up, close on cross-down.
export function smaCrossoverSignals(pricePts, fast = 5, slow = 20) {
  const pts = [...pricePts].sort((a, b) => a.at - b.at);
  const signals = [];
  let prevDiff = 0;
  for (let i = slow; i < pts.length; i++) {
    const f = pts.slice(i - fast, i).reduce((a, p) => a + p.price, 0) / fast;
    const s = pts.slice(i - slow, i).reduce((a, p) => a + p.price, 0) / slow;
    const diff = f - s;
    if (prevDiff <= 0 && diff > 0) signals.push({ at: pts[i].at, symbol: pts[i].symbol, action: 'buy' });
    else if (prevDiff >= 0 && diff < 0) signals.push({ at: pts[i].at, symbol: pts[i].symbol, action: 'close' });
    prevDiff = diff;
  }
  return signals;
}
