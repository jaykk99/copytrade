// BreakoutBot — momentum breakout strategy for paper trading.
// Paper money only. NEVER invent prices: only symbols present in ctx.prices
// may be referenced. The driver converts action.fraction of equity -> qty at
// the real price. Sell = full position (fraction ignored).

export const STRATEGY_NAME = 'BreakoutBot';

const MIN_HISTORY = 12;      // need >= 12 history points to consider a coin
const LOOKBACK = 20;         // trailing-20-point high (excluding latest)
const BREAKOUT_PCT = 0.005;  // +0.5% above trailing high triggers a buy
const BUY_FRACTION = 0.3;    // 0.25-0.35 of equity per signal
const MAX_POSITIONS = 3;     // max concurrent positions
const TAKE_PROFIT = 0.06;    // +6% vs avgEntry
const STOP_LOSS = 0.04;      // -4% vs avgEntry

export function decide(ctx) {
  const { trader, history = {}, prices = {}, killed } = ctx;
  const meta = ctx.meta && typeof ctx.meta === 'object' ? ctx.meta : {};
  const actions = [];

  // Kill-switch: daily drawdown tripped — hold everything, no actions.
  if (killed) {
    return { actions, meta };
  }

  const openSymbols = new Set(Object.keys(trader.positions || {}));

  // 1) Exits first: check every open position for take-profit / stop-loss.
  for (const sym of openSymbols) {
    const pos = trader.positions[sym];
    const px = prices[sym];
    // No invented prices: if we don't have a fresh real price, can't exit.
    if (!Number.isFinite(px) || px <= 0) continue;
    if (!pos || !(pos.qty > 0) || !(pos.avgEntry > 0)) continue;

    const ret = (px - pos.avgEntry) / pos.avgEntry;
    if (ret >= TAKE_PROFIT || ret <= -STOP_LOSS) {
      actions.push({ type: 'sell', symbol: sym, fraction: 1 });
      openSymbols.delete(sym); // frees the slot for a fresh entry below
      meta[`last_${sym}`] = { exit: px, at: Date.now() };
    }
  }

  // 2) Entries: breakout buys, capped at MAX_POSITIONS concurrent.
  if (openSymbols.size >= MAX_POSITIONS) {
    return { actions, meta };
  }

  for (const sym of Object.keys(prices)) {
    if (openSymbols.size >= MAX_POSITIONS) break;
    if (openSymbols.has(sym)) continue; // one position per coin

    const px = prices[sym];
    if (!Number.isFinite(px) || px <= 0) continue;

    const pts = history[sym];
    if (!Array.isArray(pts) || pts.length < MIN_HISTORY) continue;

    // Trailing high over the points BEFORE the latest point. If we have
    // fewer than LOOKBACK prior points, use all prior points.
    const prior = pts.slice(0, -1).slice(-LOOKBACK);
    if (prior.length === 0) continue;

    let trailingHigh = -Infinity;
    for (const p of prior) {
      if (p && Number.isFinite(p.price) && p.price > trailingHigh) {
        trailingHigh = p.price;
      }
    }
    if (!Number.isFinite(trailingHigh) || trailingHigh <= 0) continue;

    if (px >= trailingHigh * (1 + BREAKOUT_PCT)) {
      actions.push({ type: 'buy', symbol: sym, fraction: BUY_FRACTION });
      openSymbols.add(sym);
      meta[`last_${sym}`] = { entry: px, at: Date.now() };
    }
  }

  return { actions, meta };
}
