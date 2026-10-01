// DipBuyer — mean-reversion dip-buy paper-trading strategy.
// PAPER MONEY ONLY. No real trading anywhere in this app.
//
// Entry: with >=12 history points, BUY when the latest price is the
// trailing-20-point low AND is >=3% below the trailing-20-point high
// (a real dip, not a flatline).
// Exits (checked every cycle): sell the bounce at +5% vs avgEntry,
// stop-loss at -5% vs avgEntry.
//
// Aggressive but sane: 0.25-0.35 of equity per buy, max 3 concurrent
// positions, one position per coin. Never invents prices: acts only on
// symbols present in ctx.prices.

export const STRATEGY_NAME = 'DipBuyer';

const BUY_FRACTION = 0.3;
const MAX_POSITIONS = 3;
const MIN_HISTORY = 12;
const TRAIL_WINDOW = 20;
const DIP_PCT = 0.03;
const BOUNCE_PCT = 0.05;
const STOP_PCT = 0.05;

export function decide(ctx) {
  const actions = [];
  const meta = (ctx && ctx.meta) || {};

  if (!ctx || ctx.killed === true) {
    return { actions, meta };
  }

  const trader = ctx.trader || {};
  const prices = ctx.prices || {};
  const history = ctx.history || {};
  const positions = { ...(trader.positions || {}) };

  // --- Exits first: check every open position against the fresh price ---
  for (const symbol of Object.keys(positions)) {
    const price = prices[symbol];
    if (!Number.isFinite(price) || price <= 0) continue; // no fresh price, no action
    const pos = positions[symbol];
    if (!pos || !Number.isFinite(pos.avgEntry) || pos.avgEntry <= 0) continue;
    const ret = (price - pos.avgEntry) / pos.avgEntry;
    if (ret >= BOUNCE_PCT || ret <= -STOP_PCT) {
      actions.push({ type: 'sell', symbol, fraction: 1 }); // sell = full position
      delete positions[symbol]; // freed slot for a new entry this cycle
    }
  }

  // --- Entries ---
  const openCount = Object.keys(positions).length;
  let slots = MAX_POSITIONS - openCount;
  if (slots <= 0) {
    meta.lastSignals = { exits: actions.filter(a => a.type === 'sell').length, entries: 0 };
    return { actions, meta };
  }

  for (const symbol of Object.keys(prices)) {
    if (slots <= 0) break;
    if (positions[symbol]) continue; // one position per coin
    const hist = history[symbol];
    if (!Array.isArray(hist) || hist.length < MIN_HISTORY) continue;

    const window = hist.slice(-TRAIL_WINDOW);
    let high = -Infinity;
    let low = Infinity;
    for (const p of window) {
      const v = Number(p && p.price);
      if (!Number.isFinite(v)) continue;
      if (v > high) high = v;
      if (v < low) low = v;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0) continue;

    const latest = prices[symbol];
    if (!Number.isFinite(latest) || latest <= 0) continue;

    // Latest must be the trailing low AND >=3% below the trailing high.
    const isTrailingLow = latest <= low * (1 + 1e-9);
    const dip = (high - latest) / high;
    if (isTrailingLow && dip >= DIP_PCT) {
      actions.push({ type: 'buy', symbol, fraction: BUY_FRACTION });
      positions[symbol] = true; // reserve the slot for this cycle
      slots -= 1;
    }
  }

  meta.lastSignals = {
    exits: actions.filter(a => a.type === 'sell').length,
    entries: actions.filter(a => a.type === 'buy').length,
  };
  return { actions, meta };
}
