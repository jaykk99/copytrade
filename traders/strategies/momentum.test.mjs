import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_NAME, decide } from './momentum.mjs';

function makeCtx(overrides = {}) {
  const trader = overrides.trader || {
    cash: 10000,
    positions: {},
    trades: [],
    realizedPnl: 0,
  };
  return {
    trader,
    history: overrides.history || {},
    prices: overrides.prices || {},
    equity: overrides.equity ?? 10000,
    dayStartEquity: overrides.dayStartEquity ?? 10000,
    killed: overrides.killed ?? false,
    meta: overrides.meta ?? {},
  };
}

// History of n points ascending to `latest` (latest = highest, oldest→newest).
function risingHistory(n, start, latest) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ at: i * 120_000, price: start + ((latest - start) * i) / (n - 1) });
  }
  return pts;
}

function flatHistory(n, price) {
  return Array.from({ length: n }, (_, i) => ({ at: i * 120_000, price }));
}

test('STRATEGY_NAME is BreakoutBot', () => {
  assert.equal(STRATEGY_NAME, 'BreakoutBot');
});

test('breakout buy signal fires when latest exceeds trailing-20 high by >=0.5%', () => {
  const prior = risingHistory(20, 100, 119); // trailing high = 119
  const latest = { at: 20 * 120_000, price: 120 }; // +0.84% over 119
  const ctx = makeCtx({
    history: { BTC: [...prior, latest] },
    prices: { BTC: 120 },
  });
  const { actions } = decide(ctx);
  const buys = actions.filter(a => a.type === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].symbol, 'BTC');
  assert.ok(buys[0].fraction >= 0.25 && buys[0].fraction <= 0.35);
});

test('no buy when breakout is below the 0.5% threshold', () => {
  const prior = risingHistory(20, 100, 119);
  const latest = { at: 20 * 120_000, price: 119.5 }; // +0.42% over 119 — below 0.5%
  const ctx = makeCtx({
    history: { BTC: [...prior, latest] },
    prices: { BTC: 119.5 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no signal without enough history (<12 points)', () => {
  const pts = risingHistory(11, 100, 200); // only 11 points
  const ctx = makeCtx({
    history: { BTC: pts }, // huge jump at the end, still no trade
    prices: { BTC: 200 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('take-profit exit fires at +6% vs avgEntry', () => {
  const ctx = makeCtx({
    trader: { cash: 7000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: flatHistory(20, 106) },
    prices: { BTC: 106.01 }, // +6.01% -> TP
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
});

test('stop-loss exit fires at -4% vs avgEntry', () => {
  const ctx = makeCtx({
    trader: { cash: 7000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: flatHistory(20, 96) },
    prices: { BTC: 95.9 }, // -4.1% -> SL
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
});

test('no exit when position is within the TP/SL band', () => {
  const ctx = makeCtx({
    trader: { cash: 7000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: flatHistory(20, 102) },
    prices: { BTC: 102 }, // +2% — inside band, no exit, no breakout vs trailing high 102
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('killed -> no actions at all', () => {
  const prior = risingHistory(20, 100, 119);
  const ctx = makeCtx({
    trader: { cash: 7000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: [...prior, { at: 20 * 120_000, price: 120 }] },
    prices: { BTC: 106.01 }, // would trigger TP exit + breakout entry
    killed: true,
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no invented prices: actions only reference symbols present in prices', () => {
  const prior = risingHistory(20, 100, 119);
  const ctx = makeCtx({
    history: {
      BTC: [...prior, { at: 20 * 120_000, price: 120 }],
      ETH: [...prior, { at: 20 * 120_000, price: 120 }], // breakout too, but no price quote
    },
    prices: { BTC: 120 }, // ETH missing from prices
  });
  const { actions } = decide(ctx);
  for (const a of actions) {
    assert.ok(Object.hasOwn(ctx.prices, a.symbol), `action references symbol not in prices: ${a.symbol}`);
  }
  assert.ok(actions.some(a => a.symbol === 'BTC'));
  assert.ok(!actions.some(a => a.symbol === 'ETH'));
});

test('max 3 concurrent positions and one position per coin', () => {
  const trader = {
    cash: 1000,
    positions: {
      BTC: { qty: 0.5, avgEntry: 100 },
      ETH: { qty: 5, avgEntry: 100 },
      SOL: { qty: 50, avgEntry: 100 },
    },
    trades: [],
    realizedPnl: 0,
  };
  const breakoutHist = sym => {
    const prior = risingHistory(20, 100, 119);
    return { [sym]: [...prior, { at: 20 * 120_000, price: 120 }] };
  };
  const ctx = makeCtx({
    trader,
    history: { ...breakoutHist('DOGE') },
    prices: { BTC: 102, ETH: 102, SOL: 102, DOGE: 120 }, // DOGE breaks out
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []); // already 3 positions, no new buys
});

test('does not double-buy a coin already held', () => {
  const prior = risingHistory(20, 100, 119);
  const ctx = makeCtx({
    trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 115 } }, trades: [], realizedPnl: 0 },
    history: { BTC: [...prior, { at: 20 * 120_000, price: 120 }] }, // breakout...
    prices: { BTC: 120 }, // ...but +4.3% vs avgEntry: no TP/SL, so still held -> no re-buy
  });
  const { actions } = decide(ctx);
  const buys = actions.filter(a => a.type === 'buy' && a.symbol === 'BTC');
  assert.equal(buys.length, 0);
});

test('meta is returned and passed through across cycles', () => {
  const prior = risingHistory(20, 100, 119);
  const ctx1 = makeCtx({
    history: { BTC: [...prior, { at: 20 * 120_000, price: 120 }] },
    prices: { BTC: 120 },
    meta: { cycle: 7 },
  });
  const r1 = decide(ctx1);
  assert.equal(r1.meta.cycle, 7);
  assert.ok(r1.meta['last_BTC']);
  const r2 = decide(makeCtx({
    history: { BTC: [...prior, { at: 20 * 120_000, price: 120 }] },
    prices: { BTC: 120 },
    meta: r1.meta,
  }));
  assert.equal(r2.meta.cycle, 7); // preserved
});
