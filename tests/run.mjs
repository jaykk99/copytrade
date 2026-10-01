// Full-loop tests: trade -> leaderboard -> copy. Run: node tests/run.mjs
import { strict as assert } from 'node:assert';
import {
  newState, createTrader, placePaperTrade, leaderboard, tradeHistory,
  exportTrader, importTrader, portfolioValue, winRate,
} from '../js/engine.js';
import { followTrader, unfollowTrader, mirrorTrade } from '../js/copy.js';
import { createPriceFeed } from '../js/prices.js';
import { LIVE_TRADING_ENABLED, executeLiveTrade } from '../js/live-trading.js';
import { detectChain, shortAddress } from '../js/wallet.js';
import { CONFIG } from '../js/config.js';

let passed = 0;
const pending = [];
function t(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ok -', name); }
    catch (e) { console.error('  FAIL -', name, '\n   ', e.message); process.exitCode = 1; }
  })());
}

// mocked prices: BTC 60000 -> 66000, ETH 3000 -> 2700
const px = { BTC: 60000, ETH: 3000 };
const priceOf = s => px[s] ?? null;

console.log('engine');
{
  const s = newState();
  const a = createTrader(s, 'Alice');
  assert.equal(a.cash, 10000);

  t('buy BTC reduces cash by notional+fee', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: 0.1, price: 60000, at: 1000 });
    assert.ok(r.ok, r.error);
    assert.equal(r.trade.fee, 0.1 * 60000 * 0.001);
    assert.ok(Math.abs(a.cash - (10000 - 6000 - 6)) < 1e-9);
    assert.equal(a.positions.BTC.qty, 0.1);
    assert.equal(a.positions.BTC.avgEntry, 60000);
  });

  t('rejects buy with insufficient cash', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: 10, price: 60000 });
    assert.ok(!r.ok && /insufficient/.test(r.error));
  });

  t('sell with no position opens a short (paper margin)', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'ETH', side: 'sell', qty: 1, price: 3000, equity: 20000 });
    assert.ok(r.ok, r.error);
    assert.equal(a.positions.ETH.qty, -1);
    // cover it right away so later assertions stay clean; cover fee = 3
    const c = placePaperTrade(s, a.id, { symbol: 'ETH', side: 'buy', qty: 1, price: 3000 });
    assert.ok(c.ok, c.error);
    assert.ok(!a.positions.ETH);
    assert.ok(Math.abs(c.trade.realizedPnl - -3) < 1e-9, 'got ' + c.trade.realizedPnl);
  });

  t('sell books correct realized pnl', () => {
    px.BTC = 66000;
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'sell', qty: 0.1, price: 66000, at: 2000 });
    assert.ok(r.ok, r.error);
    // (66000-60000)*0.1 - fee(6.6) = 600 - 6.6 = 593.4
    assert.ok(Math.abs(r.trade.realizedPnl - 593.4) < 1e-9, 'got ' + r.trade.realizedPnl);
    assert.ok(!a.positions.BTC, 'position closed');
  });

  t('portfolio value and total pnl', () => {
    // cash = 10000 - 6006 (buy+fee) + 2997 (short open) - 3003 (cover+fee)
    //        + 6593.4 (sell-fee) = 10581.4 ; no positions
    const v = portfolioValue(a, priceOf);
    assert.ok(Math.abs(v - 10581.4) < 1e-9, 'got ' + v);
  });

  t('rejects bad symbol / bad qty', () => {
    assert.ok(!placePaperTrade(s, a.id, { symbol: 'XXX', side: 'buy', qty: 1, price: 1 }).ok);
    assert.ok(!placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: -1, price: 1 }).ok);
    assert.ok(!placePaperTrade(s, 'nope', { symbol: 'BTC', side: 'buy', qty: 1, price: 1 }).ok);
  });
}

console.log('leaderboard');
{
  const s = newState();
  const w = createTrader(s, 'Winner');
  const l = createTrader(s, 'Loser');
  px.ETH = 3000;
  placePaperTrade(s, w.id, { symbol: 'ETH', side: 'buy', qty: 1, price: 3000, at: 100 });
  px.ETH = 3600;
  placePaperTrade(s, w.id, { symbol: 'ETH', side: 'sell', qty: 1, price: 3600, at: 200 });
  placePaperTrade(s, l.id, { symbol: 'ETH', side: 'buy', qty: 1, price: 3000, at: 100 });
  px.ETH = 2400;
  placePaperTrade(s, l.id, { symbol: 'ETH', side: 'sell', qty: 1, price: 2400, at: 200 });

  t('ranks winner above loser, win rates correct', () => {
    const lb = leaderboard(s, priceOf);
    assert.equal(lb.length, 2);
    assert.equal(lb[0].name, 'Winner');
    assert.equal(lb[1].name, 'Loser');
    assert.equal(lb[0].winRate, 1);
    assert.equal(lb[1].winRate, 0);
    assert.ok(lb[0].totalPnl > 0 && lb[1].totalPnl < 0);
  });

  t('trade history newest-first with timestamps', () => {
    const h = tradeHistory(s, w.id);
    assert.equal(h.length, 2);
    assert.ok(h[0].at > h[1].at);
    assert.equal(h[0].side, 'sell');
  });

  t('export/import round-trips real trades only', () => {
    const code = exportTrader(s, w.id);
    const s2 = newState();
    const r = importTrader(s2, code);
    assert.ok(r.ok, r.error);
    assert.equal(s2.traders[w.id].trades.length, 2);
    assert.ok(!importTrader(s2, code).ok, 'duplicate rejected');
    assert.ok(!importTrader(s2, 'garbage').ok, 'garbage rejected');
  });
}

console.log('copy trading');
{
  const s = newState();
  const leader = createTrader(s, 'Leader');
  const copier = createTrader(s, 'Copier');
  px.BTC = 60000;

  t('follow + mirror buy at fraction', () => {
    assert.ok(followTrader(s, copier.id, leader.id, 0.5).ok);
    assert.ok(!followTrader(s, copier.id, leader.id, 0.5).ok, 'double follow rejected');
    assert.ok(!followTrader(s, leader.id, leader.id, 0.5).ok, 'self follow rejected');
    const lr = placePaperTrade(s, leader.id, { symbol: 'BTC', side: 'buy', qty: 0.1, price: 60000, at: 300 });
    assert.ok(lr.ok);
    const mirrored = mirrorTrade(s, lr.trade, priceOf);
    assert.equal(mirrored.length, 1);
    assert.ok(mirrored[0].result.ok, JSON.stringify(mirrored[0].result));
    // leader notional 6000 * 0.5 = 3000 -> qty 0.05 at 60000
    assert.ok(Math.abs(copier.positions.BTC.qty - 0.05) < 1e-9);
    assert.equal(mirrored[0].result.trade.copiedFrom, leader.id);
  });

  t('mirror sell reduces follower position', () => {
    px.BTC = 66000;
    const lr = placePaperTrade(s, leader.id, { symbol: 'BTC', side: 'sell', qty: 0.1, price: 66000, at: 400 });
    assert.ok(lr.ok);
    const mirrored = mirrorTrade(s, lr.trade, priceOf);
    assert.ok(mirrored[0].result.ok, JSON.stringify(mirrored[0].result));
    assert.ok(!copier.positions.BTC, 'copier closed too');
    assert.ok(copier.realizedPnl > 0, 'copier profited');
  });

  t('unfollow stops mirroring', () => {
    assert.ok(unfollowTrader(s, copier.id, leader.id));
    px.BTC = 60000;
    const lr = placePaperTrade(s, leader.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 500 });
    const mirrored = mirrorTrade(s, lr.trade, priceOf);
    assert.equal(mirrored.length, 0);
  });
}

console.log('prices');
{
  const okFetch = async (url) => ({
    ok: true,
    json: async () => ({ bitcoin: { usd: 60000 }, ethereum: { usd: 3000 } }),
  });
  t('coingecko primary works', async () => {
    const f = createPriceFeed(okFetch);
    const r = await f.refresh();
    assert.ok(r.ok && r.source === 'coingecko');
    assert.equal(f.get('BTC').price, 60000);
    assert.ok(f.hasFresh('BTC'));
  });

  const failThenCap = (() => {
    let n = 0;
    return async (url) => {
      n++;
      if (url.includes('coingecko')) throw new Error('down');
      return { ok: true, json: async () => ({ data: [{ symbol: 'BTC', priceUsd: '61000' }] }) };
    };
  })();
  t('falls back to coincap', async () => {
    const f = createPriceFeed(failThenCap);
    const r = await f.refresh();
    assert.ok(r.ok && r.source === 'coincap');
    assert.equal(f.get('BTC').price, 61000);
  });

  t('both down -> not ok, no invented prices', async () => {
    const f = createPriceFeed(async () => { throw new Error('down'); });
    const r = await f.refresh();
    assert.ok(!r.ok);
    assert.ok(!f.hasFresh('BTC'));
    assert.equal(f.get('BTC').price, null);
  });
}

console.log('safety');
{
  t('live trading is OFF and throws', () => {
    assert.equal(LIVE_TRADING_ENABLED, false);
    assert.throws(() => executeLiveTrade(), /DISABLED/);
  });
  t('wallet chain detection, no keys anywhere', () => {
    assert.equal(detectChain('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'), 'ethereum');
    assert.equal(detectChain('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), 'bitcoin');
    assert.equal(detectChain('not an address'), null);
    assert.equal(shortAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'), '0x742d…f44e');
  });
}

console.log('shorts');
{
  const s = newState();
  const a = createTrader(s, 'Shorty');
  const eq0 = portfolioValue(a, { BTC: 100 });

  t('short open credits cash, negative qty', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'sell', qty: 0.1, price: 100, equity: eq0 });
    assert.ok(r.ok, r.error);
    assert.equal(a.positions.BTC.qty, -0.1);
    assert.equal(a.positions.BTC.avgEntry, 100);
    assert.ok(Math.abs(a.cash - (10000 + 10 - 0.01)) < 1e-9);
  });

  t('partial cover books profit', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: 0.05, price: 90 });
    assert.ok(r.ok, r.error);
    const exp = 0.05 * (100 - 90) - 0.05 * 90 * 0.001;
    assert.ok(Math.abs(r.trade.realizedPnl - exp) < 1e-9);
    assert.equal(a.positions.BTC.qty, -0.05);
  });

  t('full cover at loss, winRate counts covers', () => {
    const r = placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: 0.05, price: 110 });
    assert.ok(r.ok, r.error);
    assert.ok(!a.positions.BTC);
    assert.ok(r.trade.realizedPnl < 0);
    assert.equal(winRate(a), 0.5); // 1 win (cover), 1 loss (cover)
  });

  t('over-cover rejected', () => {
    const s2 = newState();
    const b = createTrader(s2, 'S2');
    placePaperTrade(s2, b.id, { symbol: 'BTC', side: 'sell', qty: 0.1, price: 100, equity: 10000 });
    const r = placePaperTrade(s2, b.id, { symbol: 'BTC', side: 'buy', qty: 0.2, price: 100 });
    assert.equal(r.ok, false);
  });

  t('short beyond equity rejected (no leverage)', () => {
    const s3 = newState();
    const c = createTrader(s3, 'S3');
    const r = placePaperTrade(s3, c.id, { symbol: 'BTC', side: 'sell', qty: 5, price: 100, equity: 100 });
    assert.equal(r.ok, false);
  });

  t('short unrealized sign correct', () => {
    const s4 = newState();
    const d = createTrader(s4, 'S4');
    placePaperTrade(s4, d.id, { symbol: 'BTC', side: 'sell', qty: 0.1, price: 100, equity: 10000 });
    const pos = d.positions.BTC;
    assert.ok(pos.qty * (110 - pos.avgEntry) < 0); // price up -> loss
    assert.ok(pos.qty * (90 - pos.avgEntry) > 0);  // price down -> profit
  });
}

await Promise.all(pending);
console.log(`\n${passed} assertions passed${process.exitCode ? ' (with FAILURES above)' : ''}`);
