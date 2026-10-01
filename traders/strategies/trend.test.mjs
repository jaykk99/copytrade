import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_NAME, decide } from './trend.mjs';

const mkPts = (arr) => arr.map((price, i) => ({ at: i, price }));

const baseCtx = (overrides = {}) => ({
  trader: { cash: 10000, positions: {}, trades: [], realizedPnl: 0 },
  history: {},
  prices: {},
  equity: 10000,
  dayStartEquity: 10000,
  killed: false,
  meta: {},
  ...overrides,
});

test('exports the right strategy name', () => {
  assert.equal(STRATEGY_NAME, 'TrendRider');
});

test('golden-cross buy fires on a real cross', () => {
  // 29 flat at 100, last spike to 130: prev MA8 == MA24, now MA8 > MA24
  const ctx = baseCtx({
    history: { BTC: mkPts([...Array(29).fill(100), 130]) },
    prices: { BTC: 130 },
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'buy');
  assert.equal(actions[0].symbol, 'BTC');
  assert.ok(actions[0].fraction >= 0.25 && actions[0].fraction <= 0.35);
});

test('no buy without a real cross (flat trend)', () => {
  const ctx = baseCtx({
    history: { BTC: mkPts(Array(30).fill(100)) },
    prices: { BTC: 100 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no buy on coins with fewer than 26 history points', () => {
  const ctx = baseCtx({
    history: { BTC: mkPts([...Array(24).fill(100), 200]) },
    prices: { BTC: 200 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('death-cross sell fires (full position)', () => {
  // 29 flat at 100, last dip to 70: prev MA8 == MA24, now MA8 < MA24
  const ctx = baseCtx({
    trader: { cash: 0, positions: { BTC: { qty: 1, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: mkPts([...Array(29).fill(100), 70]) },
    prices: { BTC: 70 },
    equity: 70,
    meta: { peaks: { BTC: 100 } },
  });
  const { actions, meta } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
  assert.equal(actions[0].fraction, 1);
  assert.equal(meta.peaks.BTC, undefined, 'peak cleared on exit');
});

test('trailing stop fires after a 5% fall from peak', () => {
  const ctx = baseCtx({
    trader: { cash: 0, positions: { BTC: { qty: 1, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: mkPts(Array(30).fill(100)) }, // flat: no death cross
    prices: { BTC: 95 }, // exactly 5% below peak
    equity: 95,
    meta: { peaks: { BTC: 100 } },
  });
  const { actions, meta } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
  assert.equal(meta.peaks.BTC, undefined);
});

test('no trailing stop when price is only slightly below peak', () => {
  const ctx = baseCtx({
    trader: { cash: 0, positions: { BTC: { qty: 1, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: mkPts(Array(30).fill(100)) },
    prices: { BTC: 97 }, // 3% below peak
    equity: 97,
    meta: { peaks: { BTC: 100 } },
  });
  const { actions, meta } = decide(ctx);
  assert.deepEqual(actions, []);
  assert.equal(meta.peaks.BTC, 100);
});

test('peak updates upward while in position', () => {
  const ctx = baseCtx({
    trader: { cash: 0, positions: { BTC: { qty: 1, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: mkPts(Array(30).fill(100)) },
    prices: { BTC: 105 },
    equity: 105,
    meta: { peaks: { BTC: 100 } },
  });
  const { actions, meta } = decide(ctx);
  assert.deepEqual(actions, []);
  assert.equal(meta.peaks.BTC, 105);
});

test('killed -> no actions', () => {
  const ctx = baseCtx({
    killed: true,
    history: { BTC: mkPts([...Array(29).fill(100), 130]) },
    prices: { BTC: 130 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no invented prices: actions only reference symbols in prices', () => {
  const cross = mkPts([...Array(29).fill(100), 130]);
  const ctx = baseCtx({
    history: { BTC: cross, ETH: cross, SOL: cross },
    prices: { BTC: 130 }, // ETH/SOL have cross patterns but no real price
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].symbol, 'BTC');
  for (const a of actions) assert.ok(a.symbol in ctx.prices);
});

test('max 3 concurrent positions, one position per coin', () => {
  const cross = mkPts([...Array(29).fill(100), 130]);
  const ctx = baseCtx({
    history: { BTC: cross, ETH: cross, SOL: cross, DOGE: cross },
    prices: { BTC: 130, ETH: 130, SOL: 130, DOGE: 130 },
  });
  const { actions } = decide(ctx);
  const buys = actions.filter(a => a.type === 'buy');
  assert.equal(buys.length, 3);
  assert.equal(new Set(buys.map(a => a.symbol)).size, 3);

  // one position per coin: no buy when already holding
  const ctx2 = baseCtx({
    trader: { cash: 5000, positions: { BTC: { qty: 1, avgEntry: 120 } }, trades: [], realizedPnl: 0 },
    history: { BTC: cross },
    prices: { BTC: 130 },
    equity: 5130,
    meta: { peaks: { BTC: 120 } },
  });
  const r2 = decide(ctx2);
  assert.ok(!r2.actions.some(a => a.type === 'buy' && a.symbol === 'BTC'));
});
