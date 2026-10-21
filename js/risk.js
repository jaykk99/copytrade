// Risk guards for paper trading. PURE LOGIC — no DOM, no network.
// These are simulator safety rails (max position size, daily loss limit,
// cooldowns), NOT real-money risk controls. Paper only.
import { getTrader, portfolioValue } from './engine.js';
import { CONFIG } from './config.js';

const DEFAULTS = {
  MAX_POSITION_PCT: 0.5,    // one symbol may not exceed 50% of equity (notional)
  MAX_TRADE_NOTIONAL_PCT: 0.25, // one trade may not exceed 25% of equity
  MAX_OPEN_POSITIONS: 5,    // distinct symbols held at once
  DAILY_LOSS_LIMIT_PCT: 0.05,  // stop opening new positions after -5% day
  LOSS_STREAK_COOLDOWN: 3,  // pause new opens after 3 straight losing closes
};

export function riskConfig() {
  return { ...DEFAULTS, ...(CONFIG.RISK || {}) };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Per-trader day tracking, stored on the trader object under `risk`.
export function ensureRiskDay(trader, priceOf, now = Date.now()) {
  const cfg = riskConfig();
  trader.risk = trader.risk || {};
  const key = dayKey(now);
  if (trader.risk.day !== key) {
    trader.risk.day = key;
    trader.risk.startEquity = portfolioValue(trader, priceOf);
    trader.risk.stopped = false;
  }
  return trader.risk;
}

export function dailyPnl(trader, priceOf, now = Date.now()) {
  const risk = ensureRiskDay(trader, priceOf, now);
  const start = risk.startEquity || CONFIG.PAPER_STARTING_BALANCE_USD;
  const cur = portfolioValue(trader, priceOf);
  return { pnl: cur - start, pnlPct: start > 0 ? (cur - start) / start : 0, startEquity: start };
}

function isOpening(trader, symbol, side) {
  const pos = trader.positions[symbol];
  if (side === 'buy') return !(pos && pos.qty < 0); // buy = open long unless covering
  return !(pos && pos.qty > 0); // sell = open short unless closing
}

function lossStreak(trader) {
  let n = 0;
  const trades = [...trader.trades].sort((a, b) => b.at - a.at);
  for (const t of trades) {
    if (typeof t.realizedPnl !== 'number') continue;
    if (t.realizedPnl <= 0) n++;
    else break;
  }
  return n;
}

// checkTrade: pure pre-trade risk gate.
// opts: { symbol, side, qty, price }. Returns { ok, violations: [{rule, detail}] }.
export function checkTrade(state, traderId, opts, priceOf, now = Date.now()) {
  const cfg = riskConfig();
  const violations = [];
  const trader = getTrader(state, traderId);
  if (!trader) return { ok: false, violations: [{ rule: 'unknown-trader', detail: 'no such trader' }] };
  const symbol = String(opts.symbol || '').toUpperCase();
  const qty = Number(opts.qty);
  const price = Number(opts.price);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
    return { ok: false, violations: [{ rule: 'bad-input', detail: 'qty/price must be positive' }] };
  }
  const equity = portfolioValue(trader, priceOf);
  const notional = qty * price;
  const opening = isOpening(trader, symbol, opts.side);

  if (opening) {
    // daily loss limit: hard stop on NEW risk once hit
    const day = dailyPnl(trader, priceOf, now);
    if (day.pnlPct <= -cfg.DAILY_LOSS_LIMIT_PCT) {
      trader.risk.stopped = true;
      violations.push({ rule: 'daily-loss-limit', detail: `day P&L ${(day.pnlPct * 100).toFixed(2)}% <= -${(cfg.DAILY_LOSS_LIMIT_PCT * 100)}%` });
    }
    // per-trade notional cap
    if (equity > 0 && notional > equity * cfg.MAX_TRADE_NOTIONAL_PCT) {
      violations.push({ rule: 'max-trade-size', detail: `notional $${notional.toFixed(2)} > ${(cfg.MAX_TRADE_NOTIONAL_PCT * 100)}% of equity` });
    }
    // per-symbol position cap (projected)
    const cur = trader.positions[symbol];
    const curNotional = cur ? Math.abs(cur.qty) * price : 0;
    if (equity > 0 && curNotional + notional > equity * cfg.MAX_POSITION_PCT) {
      violations.push({ rule: 'max-position-size', detail: `${symbol} would exceed ${(cfg.MAX_POSITION_PCT * 100)}% of equity` });
    }
    // max distinct open positions
    const openSyms = Object.keys(trader.positions || {}).filter(s => Math.abs(trader.positions[s].qty) > 1e-12);
    if (!cur && openSyms.length >= cfg.MAX_OPEN_POSITIONS) {
      violations.push({ rule: 'max-open-positions', detail: `${openSyms.length} positions open (max ${cfg.MAX_OPEN_POSITIONS})` });
    }
    // loss-streak cooldown
    if (lossStreak(trader) >= cfg.LOSS_STREAK_COOLDOWN) {
      violations.push({ rule: 'loss-streak-cooldown', detail: `${cfg.LOSS_STREAK_COOLDOWN}+ straight losing closes — cool down` });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Live risk dashboard state for one trader.
export function riskStatus(state, traderId, priceOf, now = Date.now()) {
  const trader = getTrader(state, traderId);
  if (!trader) return null;
  const cfg = riskConfig();
  const equity = portfolioValue(trader, priceOf);
  const day = dailyPnl(trader, priceOf, now);
  const positions = Object.entries(trader.positions || {}).map(([symbol, p]) => {
    const px = priceOf(symbol);
    const notional = px != null ? Math.abs(p.qty) * px : null;
    return { symbol, qty: p.qty, avgEntry: p.avgEntry, notional, pctOfEquity: notional != null && equity > 0 ? notional / equity : null };
  });
  return {
    equity,
    dailyPnl: day.pnl,
    dailyPnlPct: day.pnlPct,
    dailyLimitPct: cfg.DAILY_LOSS_LIMIT_PCT,
    dayStopped: !!(trader.risk && trader.risk.stopped),
    lossStreak: lossStreak(trader),
    cooldownAfter: cfg.LOSS_STREAK_COOLDOWN,
    positions,
    maxPositionPct: cfg.MAX_POSITION_PCT,
    maxTradePct: cfg.MAX_TRADE_NOTIONAL_PCT,
    openCount: positions.length,
    maxOpen: cfg.MAX_OPEN_POSITIONS,
  };
}

// Convenience: run the risk gate and, if clean, place the paper trade.
// Returns { ok, trade?, error?, violations? }.
export function placeTradeWithRisk(placeFn, state, traderId, opts, priceOf, now = Date.now()) {
  const gate = checkTrade(state, traderId, opts, priceOf, now);
  if (!gate.ok) {
    return { ok: false, error: 'risk: ' + gate.violations.map(v => v.rule).join(', '), violations: gate.violations };
  }
  return placeFn(state, traderId, opts);
}
