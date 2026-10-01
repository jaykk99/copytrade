// TrendRider — trend-following MA-crossover strategy for the copytrade paper engine.
//
// Exports:
//   STRATEGY_NAME = 'TrendRider'
//   decide(ctx) -> { actions, meta }
//
// ctx = { trader, history, prices, equity, dayStartEquity, killed, meta }
//   trader:   { cash, positions: {SYM: {qty, avgEntry}}, trades, realizedPnl }
//   history:  { SYM: [{at, price}, ...] } oldest→newest, ~2min apart, up to 120
//   prices:   { SYM: number } fresh real prices this cycle — use ONLY these
//   equity:   current portfolio value in USD
//   killed:   boolean kill-switch; when true, return no actions
//   meta:     persistent scratch object (keeps meta.peaks across cycles)
//
// Actions: [{ type:'buy'|'sell', symbol, fraction }]. fraction is the portion of
// equity the driver converts to qty at the real price. SELL = full position.
//
// Signals:
//   BUY  — with ≥26 history points, short MA(8) crosses above long MA(24)
//          (prev cycle short ≤ long, now short > long) and no open position.
//          fraction 0.25–0.35 of equity (0.30), max 3 concurrent positions,
//          one position per coin.
//   SELL — full position when short crosses back below long, OR trailing stop:
//          price falls ≥5% below the peak since entry (peaks tracked in
//          meta.peaks, updated each cycle while in position, deleted on exit).
//
// Skips coins with <26 history points. Never invents prices: every action
// references a symbol present in `prices`.

export const STRATEGY_NAME = 'TrendRider';

const SHORT_N = 8;
const LONG_N = 24;
const MIN_POINTS = 26; // ≥ LONG_N + 2 so prev-cycle cross can be checked
const BUY_FRACTION = 0.3;
const MAX_POSITIONS = 3;
const TRAIL_PCT = 0.05;

function ma(points, n) {
  let sum = 0;
  for (let i = points.length - n; i < points.length; i++) sum += points[i].price;
  return sum / n;
}

/**
 * @param {object} ctx
 * @returns {{ actions: Array<{type:'buy'|'sell',symbol:string,fraction:number}>, meta: object }}
 */
export function decide(ctx) {
  const actions = [];
  const { trader, history = {}, prices = {}, killed } = ctx || {};
  const meta = ctx && ctx.meta ? ctx.meta : {};
  if (!meta.peaks) meta.peaks = {};

  if (killed) return { actions, meta };

  const positions = (trader && trader.positions) || {};
  const openCount = Object.keys(positions).length;

  for (const symbol of Object.keys(prices)) {
    const pts = history[symbol];
    if (!pts || pts.length < MIN_POINTS) continue;

    const price = prices[symbol];
    if (typeof price !== 'number' || !(price > 0)) continue;

    const hasPos = !!positions[symbol];

    if (hasPos) {
      // --- update trailing peak while in position
      if (meta.peaks[symbol] == null || price > meta.peaks[symbol]) {
        meta.peaks[symbol] = price;
      }
      const peak = meta.peaks[symbol];

      // exit 1: death cross (short crosses below long)
      const shortNow = ma(pts, SHORT_N);
      const longNow = ma(pts, LONG_N);
      const shortPrev = ma(pts.slice(0, -1), SHORT_N);
      const longPrev = ma(pts.slice(0, -1), LONG_N);
      const deathCross = shortPrev >= longPrev && shortNow < longNow;

      // exit 2: trailing stop ≥5% below peak
      const trailingHit = price <= peak * (1 - TRAIL_PCT);

      if (deathCross || trailingHit) {
        actions.push({ type: 'sell', symbol, fraction: 1 });
        delete meta.peaks[symbol];
      }
      continue;
    }

    // --- entry: golden cross (prev short ≤ long, now short > long)
    if (openCount + actions.filter(a => a.type === 'buy').length >= MAX_POSITIONS) continue;

    const shortNow = ma(pts, SHORT_N);
    const longNow = ma(pts, LONG_N);
    const shortPrev = ma(pts.slice(0, -1), SHORT_N);
    const longPrev = ma(pts.slice(0, -1), LONG_N);
    const goldenCross = shortPrev <= longPrev && shortNow > longNow;

    if (goldenCross) {
      actions.push({ type: 'buy', symbol, fraction: BUY_FRACTION });
    }
  }

  return { actions, meta };
}
