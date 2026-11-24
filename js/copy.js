// Copy trading: mirror a leader's PAPER trades into a follower's PAPER account.
// Everything stays simulated. A follower mirrors with a fraction of the leader's
// notional size, executed at the follower's current market price.
import { getTrader, placePaperTrade, portfolioValue } from './engine.js';

export function followTrader(state, followerId, leaderId, fraction) {
  const follower = getTrader(state, followerId);
  const leader = getTrader(state, leaderId);
  if (!follower || !leader) return { ok: false, error: 'unknown trader' };
  if (followerId === leaderId) return { ok: false, error: 'cannot follow yourself' };
  const f = Number(fraction);
  if (!Number.isFinite(f) || f <= 0 || f > 1) return { ok: false, error: 'fraction must be 0–1' };
  if (state.follows.some(x => x.followerId === followerId && x.leaderId === leaderId)) {
    return { ok: false, error: 'already following' };
  }
  state.follows.push({ followerId, leaderId, fraction: f, since: Date.now() });
  return { ok: true };
}

export function unfollowTrader(state, followerId, leaderId) {
  const n = state.follows.length;
  state.follows = state.follows.filter(x => !(x.followerId === followerId && x.leaderId === leaderId));
  return { ok: state.follows.length < n };
}

export function following(state, followerId) {
  return state.follows.filter(x => x.followerId === followerId);
}

// Mirror one leader trade into all followers. priceOf: (symbol) -> number|null
// Returns list of { followerId, result } for the UI feed.
// A leader trade is either an OPEN (realizedPnl === null: new long / new short)
// or a CLOSE (realizedPnl is a number: trim of an existing position), and the
// mirror must match the kind:
//  - opens mirror as opens in the same direction — crossing zero via two legs
//    (close the opposite side first, then open), so a leader short-open
//    actually puts the follower short instead of failing with "holds none";
//  - closes mirror as closes of the follower's same-direction position,
//    capped at what they hold — a leader close never flips a follower into
//    the opposite side (a leader covering a short must not buy the follower
//    more long).
export function mirrorTrade(state, leaderTrade, priceOf) {
  const out = [];
  for (const f of state.follows.filter(x => x.leaderId === leaderTrade.traderId)) {
    const px = priceOf(leaderTrade.symbol);
    if (px == null) {
      out.push({ followerId: f.followerId, result: { ok: false, error: 'no fresh price' } });
      continue;
    }
    const targetNotional = leaderTrade.notional * f.fraction;
    const qty = targetNotional / px;
    if (!Number.isFinite(qty) || qty <= 0) {
      out.push({ followerId: f.followerId, result: { ok: false, error: 'qty too small' } });
      continue;
    }
    const follower = getTrader(state, f.followerId);
    const isOpen = leaderTrade.realizedPnl == null;
    const result = isOpen
      ? mirrorOpen(state, follower, leaderTrade.symbol, leaderTrade.side, qty, px, priceOf)
      : mirrorClose(state, follower, leaderTrade.symbol, leaderTrade.side, qty, px, priceOf);
    if (result.ok) {
      for (const t of result.trades) t.copiedFrom = leaderTrade.traderId;
      result.trade = result.trades[result.trades.length - 1];
    }
    out.push({ followerId: f.followerId, result });
  }
  return out;
}

// Mirror a leader OPEN: same direction, same exposure delta. If the follower
// holds the opposite side, close that first, then open the remainder.
function mirrorOpen(state, follower, symbol, side, qty, px, priceOf) {
  const legs = [];
  const pos = follower.positions[symbol];
  if (side === 'buy' && pos && pos.qty < -1e-12) {
    const coverQty = Math.min(qty, -pos.qty);
    const r = placePaperTrade(state, follower.id, { symbol, side: 'buy', qty: coverQty, price: px, equity: portfolioValue(follower, priceOf) });
    if (!r.ok) return { ok: false, error: r.error };
    legs.push(r.trade);
    qty -= coverQty;
  } else if (side === 'sell' && pos && pos.qty > 1e-12) {
    const closeQty = Math.min(qty, pos.qty);
    const r = placePaperTrade(state, follower.id, { symbol, side: 'sell', qty: closeQty, price: px, equity: portfolioValue(follower, priceOf) });
    if (!r.ok) return { ok: false, error: r.error };
    legs.push(r.trade);
    qty -= closeQty;
  }
  if (qty > 1e-12) {
    const r = placePaperTrade(state, follower.id, { symbol, side, qty, price: px, equity: portfolioValue(follower, priceOf) });
    if (!r.ok) return { ok: false, error: r.error, trades: legs };
    legs.push(r.trade);
  }
  return { ok: true, trades: legs };
}

// Mirror a leader CLOSE: trim the follower's same-direction position, capped
// at what they hold. Never opens the opposite side.
function mirrorClose(state, follower, symbol, side, qty, px, priceOf) {
  const pos = follower.positions[symbol];
  if (side === 'sell') {
    if (!pos || pos.qty <= 1e-12) return { ok: false, error: 'follower holds none' };
    const sellQty = Math.min(qty, pos.qty);
    const r = placePaperTrade(state, follower.id, { symbol, side: 'sell', qty: sellQty, price: px, equity: portfolioValue(follower, priceOf) });
    return r.ok ? { ok: true, trades: [r.trade] } : { ok: false, error: r.error };
  }
  if (!pos || pos.qty >= -1e-12) return { ok: false, error: 'follower holds no short' };
  const coverQty = Math.min(qty, -pos.qty);
  const r = placePaperTrade(state, follower.id, { symbol, side: 'buy', qty: coverQty, price: px, equity: portfolioValue(follower, priceOf) });
  return r.ok ? { ok: true, trades: [r.trade] } : { ok: false, error: r.error };
}
