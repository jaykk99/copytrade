// Copy trading: mirror a leader's PAPER trades into a follower's PAPER account.
// Everything stays simulated. A follower mirrors with a fraction of the leader's
// notional size, executed at the follower's current market price.
import { getTrader, placePaperTrade } from './engine.js';

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
    let result;
    if (leaderTrade.side === 'buy') {
      result = placePaperTrade(state, f.followerId, { symbol: leaderTrade.symbol, side: 'buy', qty, price: px });
    } else {
      // mirror sells: sell the same fraction of the follower's position, capped at what they hold
      const follower = getTrader(state, f.followerId);
      const pos = follower.positions[leaderTrade.symbol];
      const sellQty = pos ? Math.min(qty, pos.qty) : 0;
      result = sellQty > 0
        ? placePaperTrade(state, f.followerId, { symbol: leaderTrade.symbol, side: 'sell', qty: sellQty, price: px })
        : { ok: false, error: 'follower holds none' };
    }
    if (result.ok) result.trade.copiedFrom = leaderTrade.traderId;
    out.push({ followerId: f.followerId, result });
  }
  return out;
}
