# CopyTrade — Paper Trading + Copy Trading (Phase 1)

Paper-trade crypto with **real market prices** (CoinGecko/CoinCap, keyless), climb a **live leaderboard** ranked by real recorded P&L, and **copy top traders** — your paper account mirrors their paper trades automatically.

**Phase 1 = paper only.** There is no real-money execution anywhere in a callable path.

## Safety (non-negotiable)

- **Paper/sim trading ONLY.** `js/live-trading.js` is a hard-disabled stub: `LIVE_TRADING_ENABLED = false`, every function throws. Enabling live trading requires Jay's explicit approval + a code change + a security review.
- **No fake leaderboard entries.** Every row traces to real recorded paper trades. The board starts empty.
- **Read-only wallet.** "Connect Trust Wallet" links a *public* address for balance viewing via Blockchair. No seed phrases, no private keys, no signing — the app never asks for them.
- Trading is **blocked when the price feed is stale** — the app never trades on invented numbers.

## Run it

Static site, no build step. Open `index.html` or deploy to any static host.

```bash
node tests/run.mjs   # 17 engine tests: trade -> leaderboard -> copy
```

## How it works

- `js/engine.js` — paper engine: $10,000 start, 0.1% paper fee, positions, realized/unrealized P&L, leaderboard, share-code export/import
- `js/copy.js` — follow a trader at 10/25/50%; their paper trades mirror into your paper account at live prices
- `js/prices.js` — CoinGecko primary, CoinCap fallback, stale-price guard
- `js/wallet.js` — read-only address balances (Blockchair, keyless)
- `js/app.js` — mobile-first UI glue

## Roadmap

- Phase 2 (separate approval): live-money copy execution — NOT started, NOT in a callable path.
