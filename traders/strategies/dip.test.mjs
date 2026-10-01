// Tests for the DipBuyer mean-reversion dip-buy strategy.
// Run: node --test traders/strategies/dip.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_NAME, decide } from './dip.mjs';

const T = 1700000000000; // fixed epoch base for deterministic history

function bars(prices) {
  return prices.map((price, i) => ({ at: T + i * 120000, price }));
}

function baseCtx(overrides = {}) {
  return {
    trader: { cash: 10000, positions: {}, trades: [], realizedPnl: 0 },
    history: {},
    prices: {},
    equity: 10000,
    dayStartEquity: 10000,
    killed: false,
    meta: {},
    ...overrides,
  };
}

test('strategy name is exported', () => {
  assert.equal(STRATEGY_NAME, 'DipBuyer');
});

test('dip buy fires on a real 3%+ dip (latest = trailing-20 low, >=3% below high)', () => {
  // 12+ points: bleed down so the last bar (96) is the trailing-20 low
  // and >=3% under the trailing high (112).
  const hist = bars([112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 96]);
  const ctx = baseCtx({ history: { BTC: hist }, prices: { BTC: 96 } });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'buy');
  assert.equal(actions[0].symbol, 'BTC');
  assert.ok(actions[0].fraction >= 0.25 && actions[0].fraction <= 0.35,
    `fraction ${actions[0].fraction} outside 0.25-0.35`);
});

test('dip buy fires on exactly a 3% dip', () => {
  const hist = bars([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 97]);
  const ctx = baseCtx({ history: { BTC: hist }, prices: { BTC: 97 } });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'buy');
});

test('no buy on flat/low-volatility chop (latest is low but dip < 3%)', () => {
  const hist = bars([100, 100.5, 99.8, 100.2, 99.9, 100.1, 99.7, 100.3, 99.8, 100, 99.9, 99.7]);
  const ctx = baseCtx({ history: { BTC: hist }, prices: { BTC: 99.7 } });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no buy when latest is NOT the trailing low', () => {
  // Big dip earlier, but price has already recovered off the low.
  const hist = bars([110, 108, 106, 104, 102, 100, 96, 98, 99, 100, 101, 102]);
  const ctx = baseCtx({ history: { BTC: hist }, prices: { BTC: 102 } });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no buy with <12 history points', () => {
  const hist = bars([110, 108, 100, 96, 94]);
  const ctx = baseCtx({ history: { BTC: hist }, prices: { BTC: 94 } });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('bounce exit fires at +5% vs avgEntry', () => {
  const ctx = baseCtx({
    trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    prices: { BTC: 105 },
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
});

test('stop-loss fires at -5% vs avgEntry', () => {
  const ctx = baseCtx({
    trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    prices: { BTC: 95 },
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
  assert.equal(actions[0].symbol, 'BTC');
});

test('no exit inside the +/-5% band', () => {
  for (const px of [96, 104, 100]) {
    const ctx = baseCtx({
      trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
      prices: { BTC: px },
    });
    const { actions } = decide(ctx);
    assert.deepEqual(actions, [], `expected no action at price ${px}`);
  }
});

test('killed=true -> no actions even with a live dip and a stoppable position', () => {
  const hist = bars([110, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93]);
  const ctx = baseCtx({
    trader: { cash: 5000, positions: { ETH: { qty: 1, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: hist },
    prices: { BTC: 93, ETH: 90 },
    killed: true,
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('no invented prices: actions only reference symbols present in prices', () => {
  // ETH dips hard in history, but prices only has BTC this cycle.
  const btcHist = bars([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  const ethHist = bars([110, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93]);
  const ctx = baseCtx({
    trader: { cash: 5000, positions: { SOL: { qty: 2, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: btcHist, ETH: ethHist },
    prices: { BTC: 100 }, // SOL position, ETH dip — neither is a fresh price
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
  for (const a of actions) {
    assert.ok(a.symbol in ctx.prices, `invented symbol ${a.symbol}`);
  }
});

test('max 3 concurrent positions: no new buy when already at 3', () => {
  const hist = bars([110, 108, 106, 104, 102, 100, 98, 97, 96, 95, 94, 93]);
  const ctx = baseCtx({
    trader: {
      cash: 3000,
      positions: {
        ETH: { qty: 1, avgEntry: 3000 },
        SOL: { qty: 10, avgEntry: 150 },
        DOGE: { qty: 1000, avgEntry: 0.2 },
      },
      trades: [],
      realizedPnl: 0,
    },
    history: { BTC: hist },
    prices: { BTC: 93, ETH: 3000, SOL: 150, DOGE: 0.2 },
  });
  const { actions } = decide(ctx);
  assert.ok(!actions.some(a => a.type === 'buy' && a.symbol === 'BTC'),
    'must not buy a 4th position');
});

test('one position per coin: no double-buy of an already-held symbol', () => {
  const hist = bars([112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 96]);
  const ctx = baseCtx({
    // Position is -4% (inside the hold band), dip is a real 14%+ dip,
    // but we already hold BTC -> no second buy, no sell.
    trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    history: { BTC: hist },
    prices: { BTC: 96 },
  });
  const { actions } = decide(ctx);
  assert.deepEqual(actions, []);
});

test('exits checked even without enough history (no history needed for exits)', () => {
  const ctx = baseCtx({
    trader: { cash: 5000, positions: { BTC: { qty: 0.5, avgEntry: 100 } }, trades: [], realizedPnl: 0 },
    prices: { BTC: 94 },
  });
  const { actions } = decide(ctx);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'sell');
});
