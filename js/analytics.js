// Per-trader PnL analytics. PURE LOGIC — no DOM, no network.
// Paper data only. All metrics derive from the trader's recorded trades;
// nothing is estimated or seeded.
import { CONFIG } from './config.js';

// --- helpers ---------------------------------------------------------------

function sortedTrades(trader) {
  return [...trader.trades].sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}

function closedTrades(trader) {
  return trader.trades.filter(t => typeof t.realizedPnl === 'number');
}

// --- equity curve ----------------------------------------------------------
// Rebuilds equity through time by replaying trades at their recorded prices.
// Positions are marked at the most recent traded price of each symbol, so the
// curve is an approximation of what the paper engine knew at each step.
export function equityCurve(trader, opts = {}) {
  const start = CONFIG.PAPER_STARTING_BALANCE_USD;
  const trades = sortedTrades(trader);
  let cash = start;
  const pos = {}; // symbol -> { qty, avgEntry }
  const lastPx = {};
  const points = [{ at: trader.createdAt || (trades[0] ? trades[0].at : Date.now()), value: start }];
  for (const t of trades) {
    const qty = Number(t.qty) || 0;
    const px = Number(t.price);
    if (!Number.isFinite(px) || px <= 0 || qty <= 0) continue;
    lastPx[t.symbol] = px;
    const notional = qty * px;
    const fee = Number(t.fee) || notional * CONFIG.PAPER_FEE_RATE;
    const p = pos[t.symbol];
    if (t.side === 'buy') {
      if (p && p.qty < 0) { // cover
        cash -= notional + fee;
        p.qty += qty;
        if (Math.abs(p.qty) <= 1e-12) delete pos[t.symbol];
      } else {
        cash -= notional + fee;
        const base = p || { qty: 0, avgEntry: 0 };
        const nq = base.qty + qty;
        base.avgEntry = (base.qty * base.avgEntry + qty * px) / nq;
        base.qty = nq;
        pos[t.symbol] = base;
      }
    } else {
      if (p && p.qty > 0) { // close long
        cash += notional - fee;
        p.qty -= qty;
        if (p.qty <= 1e-12) delete pos[t.symbol];
      } else {
        cash += notional - fee; // short open
        pos[t.symbol] = { qty: -(p ? Math.abs(p.qty) + qty : qty), avgEntry: px };
        if (p && p.qty < 0) pos[t.symbol].avgEntry = p.avgEntry; // keep entry on adds
      }
    }
    let value = cash;
    for (const [sym, pp] of Object.entries(pos)) {
      const lp = lastPx[sym];
      if (lp != null) value += pp.qty * lp;
    }
    points.push({ at: t.at, value });
  }
  return opts.dedupe === false ? points : dedupePoints(points);
}

function dedupePoints(points) {
  // keep the last value per timestamp so long flat stretches stay compact
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.at === p.at) last.value = p.value;
    else out.push({ ...p });
  }
  return out;
}

// --- drawdown --------------------------------------------------------------

export function maxDrawdown(curve) {
  let peak = -Infinity, peakAt = null;
  let worst = 0, wPeakAt = null, wTroughAt = null;
  for (const p of curve) {
    if (p.value > peak) { peak = p.value; peakAt = p.at; }
    const dd = peak > 0 ? (p.value - peak) / peak : 0;
    if (dd < worst) { worst = dd; wPeakAt = peakAt; wTroughAt = p.at; }
  }
  return { drawdownPct: worst, peakAt: wPeakAt, troughAt: wTroughAt };
}

// --- risk-adjusted returns -------------------------------------------------

function curveReturns(curve) {
  const r = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].value, cur = curve[i].value;
    if (prev > 0 && cur > 0) r.push((cur - prev) / prev);
  }
  return r;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Sharpe on per-trade-step returns, annualized with the given steps-per-year.
// With few steps the number is noisy — callers should show the step count.
export function sharpeRatio(curve, stepsPerYear = 365 * 24) {
  const r = curveReturns(curve);
  const sd = stdev(r);
  if (sd === 0 || r.length < 2) return null;
  return (mean(r) / sd) * Math.sqrt(stepsPerYear);
}

export function sortinoRatio(curve, stepsPerYear = 365 * 24) {
  const r = curveReturns(curve);
  if (r.length < 2) return null;
  const m = mean(r);
  const downside = r.filter(x => x < 0);
  const dd = downside.length
    ? Math.sqrt(downside.reduce((a, x) => a + x * x, 0) / r.length)
    : 0;
  if (dd === 0) return m > 0 ? Infinity : null;
  return (m / dd) * Math.sqrt(stepsPerYear);
}

// --- trade stats -------------------------------------------------------------

export function tradeStats(trader) {
  const closed = closedTrades(trader);
  const wins = closed.filter(t => t.realizedPnl > 0);
  const losses = closed.filter(t => t.realizedPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  let streak = 0, bestW = 0, bestL = 0;
  for (const t of sortedTrades(trader)) {
    if (typeof t.realizedPnl !== 'number') continue;
    if (t.realizedPnl > 0) { streak = streak >= 0 ? streak + 1 : 1; bestW = Math.max(bestW, streak); }
    else { streak = streak <= 0 ? streak - 1 : -1; bestL = Math.max(bestL, -streak); }
  }
  const fees = trader.trades.reduce((a, t) => a + (Number(t.fee) || 0), 0);
  return {
    trades: trader.trades.length,
    closed: closed.length,
    open: trader.trades.length - closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    expectancy: closed.length ? (grossWin - grossLoss) / closed.length : null,
    largestWin: wins.length ? Math.max(...wins.map(t => t.realizedPnl)) : null,
    largestLoss: losses.length ? Math.min(...losses.map(t => t.realizedPnl)) : null,
    maxWinStreak: bestW,
    maxLossStreak: bestL,
    totalFees: fees,
  };
}

export function perSymbol(trader) {
  const by = {};
  for (const t of trader.trades) {
    const s = by[t.symbol] || (by[t.symbol] = { symbol: t.symbol, trades: 0, closed: 0, wins: 0, realizedPnl: 0, volume: 0, fees: 0 });
    s.trades++;
    s.volume += Number(t.notional) || 0;
    s.fees += Number(t.fee) || 0;
    if (typeof t.realizedPnl === 'number') {
      s.closed++;
      s.realizedPnl += t.realizedPnl;
      if (t.realizedPnl > 0) s.wins++;
    }
  }
  return Object.values(by)
    .map(s => ({ ...s, winRate: s.closed ? s.wins / s.closed : null }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
}

export function monthlyPnl(trader) {
  const by = {};
  for (const t of closedTrades(trader)) {
    const d = new Date(t.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    by[key] = (by[key] || 0) + t.realizedPnl;
  }
  return Object.entries(by)
    .map(([month, pnl]) => ({ month, pnl }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// --- combined report ---------------------------------------------------------

// priceOf: (symbol) -> number | null — used only for the live equity mark.
export function traderReport(trader, priceOf) {
  const curve = equityCurve(trader);
  const dd = maxDrawdown(curve);
  const stats = tradeStats(trader);
  let liveValue = null;
  if (typeof priceOf === 'function') {
    liveValue = trader.cash;
    for (const [sym, p] of Object.entries(trader.positions || {})) {
      const px = priceOf(sym);
      if (px != null) liveValue += p.qty * px;
    }
  }
  return {
    id: trader.id,
    name: trader.name,
    stats,
    equityCurve: curve,
    drawdown: dd,
    sharpe: sharpeRatio(curve),
    sortino: sortinoRatio(curve),
    perSymbol: perSymbol(trader),
    monthly: monthlyPnl(trader),
    liveValue,
  };
}

// Compare two traders head-to-head on the metrics that matter.
export function compareTraders(a, b, priceOf) {
  const ra = traderReport(a, priceOf), rb = traderReport(b, priceOf);
  const rows = [
    ['Total P&L', ra.liveValue != null ? ra.liveValue - CONFIG.PAPER_STARTING_BALANCE_USD : null,
                  rb.liveValue != null ? rb.liveValue - CONFIG.PAPER_STARTING_BALANCE_USD : null],
    ['Win rate', ra.stats.winRate, rb.stats.winRate],
    ['Profit factor', ra.stats.profitFactor, rb.stats.profitFactor],
    ['Expectancy / trade', ra.stats.expectancy, rb.stats.expectancy],
    ['Max drawdown', ra.drawdown.drawdownPct, rb.drawdown.drawdownPct],
    ['Sharpe', ra.sharpe, rb.sharpe],
    ['Trades', ra.stats.trades, rb.stats.trades],
  ];
  return { a: ra.name, b: rb.name, rows };
}
