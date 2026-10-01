// 24/7 paper-trader supervisor for the copytrade app.
// PAPER MONEY ONLY. Every fill references a real fetched price.
// Run via cron every 2 minutes. Never trades on stale/invented prices.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { CONFIG } from '../js/config.js';
import { createPriceFeed } from '../js/prices.js';
import {
  newState, createTrader, getTrader, placePaperTrade, leaderboard,
  portfolioValue, totalPnl, winRate,
} from '../js/engine.js';

const ROOT = new URL('..', import.meta.url).pathname;
const LOGDIR = ROOT + 'trader-logs/';
const STATE_FILE = LOGDIR + 'state.json';
const BOARD_FILE = LOGDIR + 'leaderboard.json';
const TRADES_FILE = LOGDIR + 'trades.json';
const TRADE_LOG = LOGDIR + 'trades.log';
const LOCK_FILE = LOGDIR + 'run.lock';
const PUSH_EVERY_MS = 10 * 60 * 1000;
const HISTORY_CAP = 120;
const MAX_DAILY_DRAWDOWN = 0.20; // kill-switch: stop if down 20% on the day

// Jay's own Pine-script strategies. The private/ dir is gitignored — his IP, never published.
const STRATEGIES = [
  { file: './private/noskip.mjs', key: 'noskip' },     // A: No-Skip momentum -> STONE
  { file: './private/unibot49.mjs', key: 'unibot49' }, // B: UniBotPro V49 -> BTC
  { file: './private/unibot31.mjs', key: 'unibot31' }, // C: UniBotPro V31 Apex -> ETH/SOL
  { file: './private/monck.mjs', key: 'monck' },       // D: Monck Lorentzian ML -> LDO/JTO
];
const RETIRED_STRATEGIES = new Set(['momentum', 'dip', 'trend']); // old public bots, retired

mkdirSync(LOGDIR, { recursive: true });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  let s;
  if (existsSync(STATE_FILE)) {
    try { s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* fall through */ }
  }
  if (!s) s = { engine: newState(), history: {}, day: {}, meta: {}, lastPush: 0 };
  // retire the old public-strategy bots (they never traded — no history lost)
  for (const t of Object.values(s.engine.traders || {})) {
    if (RETIRED_STRATEGIES.has(t.strategyKey) && (!t.trades || t.trades.length === 0)) {
      delete s.engine.traders[t.id];
      delete s.day[t.strategyKey];
      delete s.meta[t.strategyKey];
    }
  }
  return s;
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

function log(msg) {
  console.log(new Date().toISOString(), msg);
}

async function main() {
  if (existsSync(LOCK_FILE)) { log('previous run still active, skipping'); return; }
  writeFileSync(LOCK_FILE, String(process.pid));
  try {
    await cycle();
  } finally {
    try { (await import('fs')).unlinkSync(LOCK_FILE); } catch { /* noop */ }
  }
}

async function cycle() {
  const s = loadState();
  const feed = createPriceFeed();
  const r = await feed.refresh();
  if (!r.ok) { log('price feed down — no trading this cycle'); return; }

  const now = Date.now();
  const prices = {};
  for (const sym of Object.keys(CONFIG.SYMBOLS)) {
    const g = feed.get(sym);
    if (g.price != null && !g.stale) prices[sym] = g.price;
    // history: record every coin that has a price, stale or not (history is not trading)
    const gp = feed.get(sym);
    if (gp.price != null) {
      const h = (s.history[sym] = s.history[sym] || []);
      if (!h.length || h[h.length - 1].price !== gp.price) h.push({ at: now, price: gp.price });
      if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
    }
  }
  const freshCount = Object.keys(prices).length;
  if (freshCount === 0) { log('no fresh prices — no trading'); return; }

  const priceOf = sym => prices[sym] ?? null;
  const day = todayStr();
  const newTrades = [];

  for (const strat of STRATEGIES) {
    let mod = null;
    try { mod = await import(strat.file); }
    catch (e) { log(`${strat.key}: strategy module not ready yet`); continue; }

    // find or create this strategy's paper trader
    let trader = Object.values(s.engine.traders).find(t => t.strategyKey === strat.key);
    if (!trader) {
      trader = createTrader(s.engine, mod.STRATEGY_NAME || strat.key);
      trader.strategyKey = strat.key;
      log(`${mod.STRATEGY_NAME}: created paper account`);
    }

    // day rollover: reset kill-switch and day-start equity
    const d = (s.day[strat.key] = s.day[strat.key] || {});
    const equity = portfolioValue(trader, priceOf);
    if (d.date !== day) {
      d.date = day;
      d.startEquity = equity;
      d.killed = false;
      log(`${trader.name}: new day, start equity $${equity.toFixed(2)}`);
    }

    // kill-switch: down 20% on the day -> flatten and stop
    if (!d.killed && d.startEquity > 0 && equity < d.startEquity * (1 - MAX_DAILY_DRAWDOWN)) {
      d.killed = true;
      for (const sym of Object.keys(trader.positions)) {
        const px = prices[sym];
        if (px == null) continue;
        const qty = trader.positions[sym].qty;
        const side = qty > 0 ? 'sell' : 'buy'; // cover shorts too
        const res = placePaperTrade(s.engine, trader.id, { symbol: sym, side, qty: Math.abs(qty), price: px, at: now });
        if (res.ok) newTrades.push({ ...res.trade, trader: trader.name, killSwitch: true });
      }
      log(`${trader.name}: ⛔ DAILY STOP HIT (${((1 - equity / d.startEquity) * 100).toFixed(1)}% down) — flattened, done for the day`);
      continue;
    }
    if (d.killed) continue;

    const meta = (s.meta[strat.key] = s.meta[strat.key] || {});
    let decision;
    try {
      decision = mod.decide({
        trader, history: s.history, prices, equity,
        dayStartEquity: d.startEquity, killed: !!d.killed, meta,
      });
    } catch (e) { log(`${trader.name}: strategy error: ${String(e.message).slice(0, 120)}`); continue; }
    if (decision && decision.meta) s.meta[strat.key] = decision.meta;

    for (const a of (decision && decision.actions) || []) {
      const sym = String(a.symbol || '').toUpperCase();
      const px = prices[sym];
      if (px == null) { log(`${trader.name}: skip ${a.type} ${sym} — no fresh price`); continue; }
      const fraction = Math.min(Math.max(Number(a.fraction) || 0, 0), 0.5);
      if (a.type === 'close') {
        const pos = trader.positions[sym];
        if (!pos) continue;
        const side = pos.qty > 0 ? 'sell' : 'buy'; // buy = cover a short
        const closeQty = Math.abs(pos.qty);
        const res = placePaperTrade(s.engine, trader.id, { symbol: sym, side, qty: closeQty, price: px, at: now });
        if (res.ok) { newTrades.push({ ...res.trade, trader: trader.name }); log(`${trader.name}: CLOSE ${closeQty.toFixed(6)} ${sym} @ $${px} pnl ${res.trade.realizedPnl >= 0 ? '+' : ''}$${res.trade.realizedPnl.toFixed(2)}`); }
        else log(`${trader.name}: close rejected: ${res.error}`);
      } else if (a.type === 'buy' || a.type === 'sell') {
        // buy = open long, sell = open short; strategies close before flipping
        if (fraction <= 0) continue;
        if (trader.positions[sym]) continue; // one position per coin
        const qty = (equity * fraction) / px;
        const res = placePaperTrade(s.engine, trader.id, { symbol: sym, side: a.type, qty, price: px, at: now, equity });
        if (res.ok) { newTrades.push({ ...res.trade, trader: trader.name }); log(`${trader.name}: ${a.type === 'buy' ? 'LONG' : 'SHORT'} ${qty.toFixed(6)} ${sym} @ $${px}`); }
        else log(`${trader.name}: ${a.type} rejected: ${res.error}`);
      }
    }
  }

  // persist state
  saveState(s);

  // trade log
  for (const t of newTrades) appendFileSync(TRADE_LOG, JSON.stringify(t) + '\n');

  // publish leaderboard + recent trades for the live site
  const rows = leaderboard(s.engine, priceOf).map(row => ({
    ...row,
    killedToday: !!(s.day[Object.values(s.engine.traders).find(t => t.id === row.id)?.strategyKey || '']?.killed),
    openPositions: Object.keys((getTrader(s.engine, row.id)?.positions) || {}).length,
  }));
  const allTrades = [];
  for (const t of Object.values(s.engine.traders)) {
    for (const tr of t.trades) allTrades.push({ ...tr, trader: t.name });
  }
  allTrades.sort((a, b) => b.at - a.at);
  writeFileSync(BOARD_FILE, JSON.stringify({ updatedAt: now, note: 'paper only — not real money', rows }));
  writeFileSync(TRADES_FILE, JSON.stringify({ updatedAt: now, trades: allTrades.slice(0, 200) }));

  const totals = rows.map(row => `${row.name}: ${row.trades} trades, ${row.winRate == null ? '—' : Math.round(row.winRate * 100) + '%'} win, ${row.totalPnl >= 0 ? '+' : ''}$${row.totalPnl.toFixed(2)}`).join(' | ');
  log(`cycle done: ${freshCount} fresh prices, ${newTrades.length} new trades. ${totals}`);

  // push published files every ~10 min
  if (now - (s.lastPush || 0) > PUSH_EVERY_MS) {
    try {
      execSync(`cd ${ROOT} && git add trader-logs/leaderboard.json trader-logs/trades.json && git diff --cached --quiet || git commit -m "bot leaderboard update (paper)" && git push origin master`, { timeout: 60000, stdio: 'pipe' });
      s.lastPush = now;
      saveState(s);
      log('pushed leaderboard to live site');
    } catch (e) { log('push failed (will retry): ' + String(e.message).slice(0, 100)); }
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
