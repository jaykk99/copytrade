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
import { equityCurve, maxDrawdown, sharpeRatio, tradeStats, perSymbol, monthlyPnl, traderReport, compareTraders } from '../js/analytics.js';
import { checkTrade, riskStatus, placeTradeWithRisk, dailyPnl } from '../js/risk.js';
import { replay, auditLog, runStrategy, smaCrossoverSignals } from '../js/backtest.js';
import { tradesToCsv, leaderboardToCsv, perSymbolToCsv, monthlyToCsv } from '../js/export.js';

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

console.log('analytics');
{
  const s = newState();
  const a = createTrader(s, 'Annie');
  // win: 0.01 BTC 60000 -> 66000 ; loss: 1 ETH 3000 -> 2400
  placePaperTrade(s, a.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 1000 });
  placePaperTrade(s, a.id, { symbol: 'BTC', side: 'sell', qty: 0.01, price: 66000, at: 2000 });
  placePaperTrade(s, a.id, { symbol: 'ETH', side: 'buy', qty: 1, price: 3000, at: 3000 });
  placePaperTrade(s, a.id, { symbol: 'ETH', side: 'sell', qty: 1, price: 2400, at: 4000 });

  t('tradeStats: win rate, expectancy, profit factor', () => {
    const st = tradeStats(a);
    assert.equal(st.closed, 2);
    assert.equal(st.winRate, 0.5);
    // win 59.34, loss -602.4
    assert.ok(Math.abs(st.expectancy - (59.34 - 602.4) / 2) < 1e-6, 'got ' + st.expectancy);
    assert.ok(Math.abs(st.profitFactor - 59.34 / 602.4) < 1e-6);
    assert.equal(st.maxWinStreak, 1);
    assert.equal(st.maxLossStreak, 1);
    assert.ok(st.totalFees > 0);
  });

  t('equityCurve starts at 10000, ends flat with no positions', () => {
    const c = equityCurve(a);
    assert.equal(c[0].value, 10000);
    assert.ok(!a.positions.BTC && !a.positions.ETH);
    const last = c[c.length - 1].value;
    const pv = portfolioValue(a, priceOf);
    assert.ok(Math.abs(last - pv) < 1e-6, `curve ${last} vs pv ${pv}`);
  });

  t('maxDrawdown catches the dip after the ETH loss', () => {
    const dd = maxDrawdown(equityCurve(a));
    // curve steps on trades only: peak 10058.74 -> trough 9453.34
    assert.ok(dd.drawdownPct < -0.05 && dd.drawdownPct > -0.07, 'got ' + dd.drawdownPct);
    assert.ok(dd.troughAt > dd.peakAt);
  });

  t('sharpeRatio null on flat curve', () => {
    assert.equal(sharpeRatio([{ at: 1, value: 100 }, { at: 2, value: 100 }]), null);
  });

  t('perSymbol groups and sorts by realized', () => {
    const ps = perSymbol(a);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].symbol, 'BTC');
    assert.ok(Math.abs(ps[0].realizedPnl - 59.34) < 1e-6);
    assert.equal(ps[1].symbol, 'ETH');
  });

  t('monthlyPnl buckets realized by month', () => {
    const m = monthlyPnl(a);
    assert.equal(m.length, 1);
    assert.ok(Math.abs(m[0].pnl - (59.34 - 602.4)) < 1e-6, 'got ' + m[0].pnl);
  });

  t('traderReport bundles curve + stats + live value', () => {
    const r = traderReport(a, priceOf);
    assert.equal(r.name, 'Annie');
    assert.ok(r.equityCurve.length >= 5);
    assert.equal(r.stats.closed, 2);
    assert.ok(Math.abs(r.liveValue - portfolioValue(a, priceOf)) < 1e-6);
  });

  t('compareTraders returns 7 metric rows', () => {
    const b = createTrader(s, 'Bob');
    const cmp = compareTraders(a, b, priceOf);
    assert.equal(cmp.a, 'Annie');
    assert.equal(cmp.b, 'Bob');
    assert.equal(cmp.rows.length, 7);
    assert.equal(cmp.rows[0][0], 'Total P&L');
  });
}

console.log('risk');
{
  const s = newState();
  const r1 = createTrader(s, 'Risky');

  t('checkTrade blocks oversized single trade', () => {
    const g = checkTrade(s, r1.id, { symbol: 'BTC', side: 'buy', qty: 1, price: 60000 }, priceOf);
    assert.ok(!g.ok);
    assert.ok(g.violations.some(v => v.rule === 'max-trade-size'));
  });

  t('checkTrade allows a sensibly sized trade', () => {
    const g = checkTrade(s, r1.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000 }, priceOf);
    assert.ok(g.ok, JSON.stringify(g.violations));
  });

  t('checkTrade blocks new opens after daily loss limit', () => {
    const s2 = newState();
    const d = createTrader(s2, 'Down');
    dailyPnl(d, priceOf); // seeds risk.day
    d.risk.startEquity = 20000; // simulate a -50% day
    const g = checkTrade(s2, d.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000 }, priceOf);
    assert.ok(!g.ok);
    assert.ok(g.violations.some(v => v.rule === 'daily-loss-limit'));
    assert.ok(d.risk.stopped);
  });

  t('checkTrade blocks new opens after 3 straight losses', () => {
    const s3 = newState();
    const l = createTrader(s3, 'Streaky');
    for (let i = 0; i < 3; i++) {
      placePaperTrade(s3, l.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 1000 + i * 10 });
      placePaperTrade(s3, l.id, { symbol: 'BTC', side: 'sell', qty: 0.01, price: 59000, at: 1005 + i * 10 });
    }
    const g = checkTrade(s3, l.id, { symbol: 'ETH', side: 'buy', qty: 0.1, price: 3000 }, priceOf);
    assert.ok(!g.ok, 'expected cooldown block');
    assert.ok(g.violations.some(v => v.rule === 'loss-streak-cooldown'));
  });

  t('riskStatus reports position sizing', () => {
    const s4 = newState();
    const p = createTrader(s4, 'Pos');
    placePaperTrade(s4, p.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 1 });
    const rs = riskStatus(s4, p.id, priceOf);
    assert.equal(rs.openCount, 1);
    // notional 600 vs equity 9999.4 (fee drag) — ~6%
    assert.ok(rs.positions[0].pctOfEquity > 0.059 && rs.positions[0].pctOfEquity < 0.061, 'got ' + rs.positions[0].pctOfEquity);
    assert.equal(rs.dayStopped, false);
  });

  t('placeTradeWithRisk places clean, blocks dirty', () => {
    const s5 = newState();
    const w = createTrader(s5, 'Gated');
    const clean = placeTradeWithRisk(placePaperTrade, s5, w.id,
      { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, equity: 10000 }, priceOf);
    assert.ok(clean.ok, clean.error);
    const dirty = placeTradeWithRisk(placePaperTrade, s5, w.id,
      { symbol: 'BTC', side: 'buy', qty: 10, price: 60000, equity: 10000 }, priceOf);
    assert.ok(!dirty.ok);
    assert.ok(/^risk:/.test(dirty.error));
  });
}

console.log('backtest');
{
  t('replay recomputes realized pnl; flags tampered records', () => {
    const trades = [
      { id: 't1', symbol: 'BTC', side: 'buy', qty: 0.1, price: 60000, at: 100, fee: 6, realizedPnl: null },
      { id: 't2', symbol: 'BTC', side: 'sell', qty: 0.1, price: 66000, at: 200, fee: 6.6, realizedPnl: 593.4 },
    ];
    const r = replay(trades);
    assert.ok(r.clean, JSON.stringify(r.mismatches));
    assert.ok(Math.abs(r.recomputedRealized - 593.4) < 1e-6);
    const bad = replay(trades.map(x => x.id === 't2' ? { ...x, realizedPnl: 9999 } : x));
    assert.ok(!bad.clean);
    assert.ok(bad.mismatches.some(m => m.issue === 'realizedPnl mismatch'));
  });

  t('replay flags bad side/qty without crashing', () => {
    const r = replay([{ id: 'x', symbol: 'BTC', side: 'hold', qty: 1, price: 1, at: 1 }]);
    assert.ok(r.mismatches.some(m => m.issue === 'bad side'));
  });

  t('runStrategy turns signals into a clean paper run', () => {
    const pts = [];
    for (let i = 0; i < 20; i++) pts.push({ at: 1000 + i * 60, symbol: 'BTC', price: 60000 + i * 100 });
    for (let i = 20; i < 40; i++) pts.push({ at: 1000 + i * 60, symbol: 'BTC', price: 62000 - (i - 20) * 100 });
    const prices = { BTC: pts };
    const sigs = [
      { at: 1000 + 5 * 60, symbol: 'BTC', action: 'buy' },
      { at: 1000 + 25 * 60, symbol: 'BTC', action: 'close' },
    ];
    const bt = runStrategy(sigs, prices, { sizeUsd: 1000 });
    assert.equal(bt.trades.length, 2);
    assert.ok(bt.trades[0].realizedPnl == null && typeof bt.trades[1].realizedPnl === 'number');
    assert.ok(bt.summary.clean);
    assert.ok(bt.trades[1].realizedPnl > 0, 'bought low, sold high');
    assert.ok(bt.terminalValue > 10000);
  });

  t('smaCrossoverSignals emits buy and close on a hump', () => {
    const pts = [];
    for (let i = 0; i < 12; i++) pts.push({ at: i, symbol: 'BTC', price: 100 });
    for (let i = 12; i < 30; i++) pts.push({ at: i, symbol: 'BTC', price: 100 + (i - 12) * 2 });
    for (let i = 30; i < 48; i++) pts.push({ at: i, symbol: 'BTC', price: 136 - (i - 30) * 2 });
    const sigs = smaCrossoverSignals(pts, 3, 8);
    assert.ok(sigs.some(s => s.action === 'buy'), 'no buy signal');
    assert.ok(sigs.some(s => s.action === 'close'), 'no close signal');
  });

  t('auditLog groups trades by trader', () => {
    const mk = (id, tr) => ({ id, traderId: tr, trader: tr, symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 1, fee: 0.6, realizedPnl: null });
    const out = auditLog({ trades: [mk('1', 'a'), mk('2', 'a'), mk('3', 'b')] });
    assert.equal(out.length, 2);
    assert.equal(out.find(o => o.traderId === 'a').tradeCount, 2);
  });
}

console.log('csv');
{
  t('tradesToCsv header + rows, quotes commas', () => {
    const s = newState();
    const z = createTrader(s, 'Zed, the "best"');
    placePaperTrade(s, z.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 1000 });
    const csv = tradesToCsv(tradeHistory(s, z.id));
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('id,traderId,symbol,side,qty,price'));
    assert.ok(lines[1].includes('BTC'));
  });

  t('leaderboardToCsv ranks by pnl', () => {
    const s = newState();
    const w = createTrader(s, 'W');
    placePaperTrade(s, w.id, { symbol: 'BTC', side: 'buy', qty: 0.01, price: 60000, at: 100 });
    px.BTC = 66000;
    placePaperTrade(s, w.id, { symbol: 'BTC', side: 'sell', qty: 0.01, price: 66000, at: 200 });
    const csv = leaderboardToCsv(s, priceOf);
    assert.ok(csv.includes('rank,traderId,name,trades'));
    assert.ok(csv.split('\n')[1].startsWith('1,'));
    px.BTC = 60000;
  });

  t('perSymbolToCsv and monthlyToCsv shape', () => {
    const s = newState();
    const q = createTrader(s, 'Q');
    placePaperTrade(s, q.id, { symbol: 'ETH', side: 'buy', qty: 1, price: 3000, at: 100 });
    placePaperTrade(s, q.id, { symbol: 'ETH', side: 'sell', qty: 1, price: 3300, at: 200 });
    const rep = traderReport(q, priceOf);
    const ps = perSymbolToCsv(rep.perSymbol);
    assert.ok(ps.includes('ETH'));
    const mo = monthlyToCsv(rep.monthly);
    assert.ok(mo.startsWith('month,realizedPnl'));
    assert.equal(mo.trim().split('\n').length, 2);
  });
}

await Promise.all(pending);
console.log(`\n${passed} assertions passed${process.exitCode ? ' (with FAILURES above)' : ''}`);
