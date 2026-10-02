// UI glue for the CopyTrade paper-trading app.
import { CONFIG } from './config.js';
import { store } from './store.js';
import { createPriceFeed } from './prices.js';
import {
  newState, createTrader, getTrader, placePaperTrade, leaderboard,
  tradeHistory, portfolioValue, totalPnl, winRate, exportTrader, importTrader,
} from './engine.js';
import { followTrader, unfollowTrader, mirrorTrade, following } from './copy.js';
import { detectChain, fetchAddressBalance, shortAddress } from './wallet.js';
import { LIVE_TRADING_ENABLED } from './live-trading.js';

const $ = id => document.getElementById(id);
const fmt$ = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtT = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let state = store.load() || newState();
let activeTraderId = state.activeTraderId || null;
let walletAddr = state.walletAddr || null;
let side = 'buy';
let copyFeed = [];

const feed = createPriceFeed();

function save() {
  state.activeTraderId = activeTraderId;
  state.walletAddr = walletAddr;
  store.save(state);
}
function activeTrader() { return getTrader(state, activeTraderId); }
function ensureTrader() {
  let t = activeTrader();
  if (!t) {
    t = createTrader(state, 'Jay');
    activeTraderId = t.id;
    save();
  }
  return t;
}
const priceOf = sym => { const g = feed.get(sym); return g.price; };

// ---------- prices ----------
async function refreshPrices() {
  const r = await feed.refresh();
  const el = $('price-status');
  if (r.ok) {
    el.className = 'price-status live';
    $('price-status-text').textContent = `live · ${r.source} · ${r.count} coins`;
  } else {
    el.className = 'price-status stale';
    $('price-status-text').textContent = 'price feed down — trading paused';
  }
  renderTickers();
  renderStats();
  renderBoard();
}

function renderTickers() {
  const row = $('ticker-row');
  row.innerHTML = '';
  for (const sym of Object.keys(CONFIG.SYMBOLS)) {
    const g = feed.get(sym);
    const d = document.createElement('div');
    d.className = 'ticker' + ($('trade-symbol').value === sym ? ' sel' : '');
    d.innerHTML = `<b>${sym}</b><span>${g.price != null ? '$' + g.price.toLocaleString('en-US', { maximumFractionDigits: g.price < 10 ? 4 : 2 }) : '—'}</span>`;
    d.onclick = () => { $('trade-symbol').value = sym; renderTickers(); updateTradePrice(); };
    row.appendChild(d);
  }
}

function updateTradePrice() {
  const sym = $('trade-symbol').value;
  const g = feed.get(sym);
  $('trade-price-label').textContent = 'price: ' + (g.price != null ? fmt$(g.price) + (g.stale ? ' (stale)' : '') : '—');
}

// ---------- trade tab ----------
function renderStats() {
  const t = ensureTrader();
  $('trader-name').textContent = t.name + ' · paper';
  const v = portfolioValue(t, priceOf);
  const pnl = totalPnl(t, priceOf);
  $('stat-portfolio').textContent = fmt$(v);
  $('stat-cash').textContent = fmt$(t.cash);
  const pnlEl = $('stat-pnl');
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl);
  pnlEl.className = pnl >= 0 ? 'pos' : 'neg';
  const wr = winRate(t);
  $('stat-win').textContent = wr == null ? '—' : Math.round(wr * 100) + '%';

  const pos = $('positions');
  const syms = Object.keys(t.positions);
  if (!syms.length) { pos.innerHTML = '<p class="muted">No open positions.</p>'; }
  else {
    pos.innerHTML = '';
    for (const sym of syms) {
      const p = t.positions[sym];
      const cur = priceOf(sym);
      const unrl = cur != null ? p.qty * (cur - p.avgEntry) : null;
      const div = document.createElement('div');
      div.className = 'pos-row';
      div.innerHTML = `<span><b>${sym}</b> ${p.qty.toFixed(6)}<br><small class="muted">avg ${fmt$(p.avgEntry)}</small></span>
        <span class="${unrl >= 0 ? 'pos' : 'neg'}">${unrl == null ? '—' : (unrl >= 0 ? '+' : '') + fmt$(unrl)}</span>`;
      pos.appendChild(div);
    }
  }

  const mt = $('my-trades');
  const hist = tradeHistory(t, t.id, 20);
  if (!hist.length) { mt.innerHTML = '<p class="muted">No trades yet.</p>'; }
  else {
    mt.innerHTML = '';
    for (const tr of hist) mt.appendChild(tradeRow(tr, false));
  }
}

function tradeRow(tr, showTrader) {
  const div = document.createElement('div');
  div.className = 'trade-row';
  const pnlTxt = tr.realizedPnl != null
    ? `<span class="${tr.realizedPnl >= 0 ? 'pos' : 'neg'}">${tr.realizedPnl >= 0 ? '+' : ''}${fmt$(tr.realizedPnl)}</span>` : '';
  div.innerHTML = `<span><b class="${tr.side === 'buy' ? 'pos' : 'neg'}">${tr.side.toUpperCase()}</b> ${tr.qty.toFixed(6)} ${tr.symbol} @ ${fmt$(tr.price)}
    ${tr.copiedFrom ? '<span class="copied-tag">🔁 copied</span>' : ''}<br><small class="muted">${fmtT(tr.at)}${showTrader ? ' · ' + escName(tr.traderId) : ''}</small></span>
    <span style="text-align:right">${pnlTxt}<br><small class="muted">fee ${fmt$(tr.fee)}</small></span>`;
  return div;
}
function escName(id) {
  const t = getTrader(state, id);
  return t ? t.name.replace(/[<>&]/g, '') : '?';
}

function placeTrade() {
  const t = ensureTrader();
  const sym = $('trade-symbol').value;
  if (!feed.hasFresh(sym)) {
    msg('trade-msg', 'Price feed is stale for ' + sym + ' — trading paused. No trading on bad data.', 'err');
    return;
  }
  const qty = parseFloat($('trade-qty').value);
  const g = feed.get(sym);
  const r = placePaperTrade(state, t.id, { symbol: sym, side, qty, price: g.price });
  if (!r.ok) { msg('trade-msg', r.error, 'err'); return; }
  // mirror to followers (paper only)
  const mirrored = mirrorTrade(state, r.trade, priceOf);
  for (const m of mirrored) {
    if (m.result.ok) {
      const f = getTrader(state, m.followerId);
      copyFeed.unshift({ at: Date.now(), text: `${String(f.name).replace(/[<>&"]/g, '')} copied ${side.toUpperCase()} ${m.result.trade.qty.toFixed(6)} ${sym}` });
    }
  }
  copyFeed = copyFeed.slice(0, 30);
  msg('trade-msg', `${side.toUpperCase()} ${qty} ${sym} @ ${fmt$(g.price)} — paper filled`, 'ok');
  $('trade-qty').value = '';
  save();
  renderAll();
}

function msg(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
}

// ---------- 24/7 paper bots (published by the supervisor, real recorded paper trades) ----------
let botBoardCache = null;
async function renderBotBoard() {
  const el = $('bot-board');
  try {
    const res = await fetch('trader-logs/leaderboard.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('no bot data yet');
    const data = await res.json();
    botBoardCache = data;
  } catch (e) {
    el.innerHTML = '<p class="muted">Bots are warming up — their first leaderboard publishes soon.</p>';
    return;
  }
  const rows = botBoardCache.rows || [];
  if (!rows.length) { el.innerHTML = '<p class="muted">Bots are warming up.</p>'; return; }
  const upd = botBoardCache.updatedAt ? fmtT(botBoardCache.updatedAt) : '';
  el.innerHTML = `<p class="muted small">updated ${upd} · paper only</p>`;
  rows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'lb-row';
    const wr = row.winRate == null ? '—' : Math.round(row.winRate * 100) + '%';
    div.innerHTML = `<span class="lb-rank">#${i + 1}</span>
      <span class="lb-name"><b>🤖 ${String(row.name).replace(/[<>&]/g, '')}</b>
      <small>${row.trades} trades · win ${wr}${row.lastTradeAt ? ' · last ' + fmtT(row.lastTradeAt) : ''}${row.killedToday ? ' · ⛔ day stop hit' : ''}</small></span>
      <span class="${row.totalPnl >= 0 ? 'pos' : 'neg'}"><b>${row.totalPnl >= 0 ? '+' : ''}${fmt$(row.totalPnl)}</b></span>`;
    div.onclick = () => showBotDetail(row);
    el.appendChild(div);
  });
}

function showBotDetail(row) {
  const card = $('trader-detail-card');
  card.classList.remove('hidden');
  $('detail-name').textContent = '🤖 ' + row.name + ' — every trade (paper)';
  const el = $('trader-detail');
  const trades = (botBoardCache.recentTrades || []).filter(t => t.trader === row.name).slice(0, 50);
  el.innerHTML = trades.length ? '' : '<p class="muted">No trades recorded yet.</p>';
  for (const tr of trades) {
    const div = document.createElement('div');
    div.className = 'trade-row';
    const pnlTxt = tr.realizedPnl != null
      ? `<span class="${tr.realizedPnl >= 0 ? 'pos' : 'neg'}">${tr.realizedPnl >= 0 ? '+' : ''}${fmt$(tr.realizedPnl)}</span>` : '';
    div.innerHTML = `<span><b class="${tr.side === 'buy' ? 'pos' : 'neg'}">${tr.side.toUpperCase()}</b> ${Number(tr.qty).toFixed(6)} ${tr.symbol} @ ${fmt$(tr.price)}
      <br><small class="muted">${fmtT(tr.at)}</small></span>
      <span style="text-align:right">${pnlTxt}<br><small class="muted">fee ${fmt$(tr.fee)}</small></span>`;
    el.appendChild(div);
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- leaderboard ----------
function renderBoard() {
  const lb = leaderboard(state, priceOf);
  const el = $('leaderboard');
  if (!lb.length) { el.innerHTML = '<p class="muted">No traders yet — make your first paper trade.</p>'; return; }
  el.innerHTML = '';
  lb.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'lb-row';
    div.innerHTML = `<span class="lb-rank">#${i + 1}</span>
      <span class="lb-name"><b>${row.name.replace(/[<>&]/g, '')}</b>
      <small>${row.trades} trades · win ${row.winRate == null ? '—' : Math.round(row.winRate * 100) + '%'}${row.lastTradeAt ? ' · last ' + fmtT(row.lastTradeAt) : ''}</small></span>
      <span class="${row.totalPnl >= 0 ? 'pos' : 'neg'}"><b>${row.totalPnl >= 0 ? '+' : ''}${fmt$(row.totalPnl)}</b></span>`;
    div.onclick = () => showTraderDetail(row.id);
    el.appendChild(div);
  });
}

function showTraderDetail(id) {
  const t = getTrader(state, id);
  if (!t) return;
  const card = $('trader-detail-card');
  card.classList.remove('hidden');
  $('detail-name').textContent = t.name + ' — every trade';
  const el = $('trader-detail');
  const hist = tradeHistory(state, id, 50);
  el.innerHTML = hist.length ? '' : '<p class="muted">No trades recorded.</p>';
  for (const tr of hist) el.appendChild(tradeRow(tr, false));
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- copy ----------
function renderCopy() {
  const me = ensureTrader();
  const lb = leaderboard(state, priceOf).filter(r => r.id !== me.id);
  const list = $('copy-list');
  if (!lb.length) { list.innerHTML = '<p class="muted">No traders to follow yet.</p>'; }
  else {
    list.innerHTML = '';
    for (const row of lb) {
      const isF = state.follows.some(f => f.followerId === me.id && f.leaderId === row.id);
      const div = document.createElement('div');
      div.className = 'lb-row';
      div.innerHTML = `<span class="lb-name"><b>${row.name.replace(/[<>&]/g, '')}</b>
        <small>${row.trades} trades · <span class="${row.totalPnl >= 0 ? 'pos' : 'neg'}">${row.totalPnl >= 0 ? '+' : ''}${fmt$(row.totalPnl)}</span> · win ${row.winRate == null ? '—' : Math.round(row.winRate * 100) + '%'}${row.lastTradeAt ? ' · last ' + fmtT(row.lastTradeAt) : ''}</small></span>`;
      if (!isF) {
        const wrap = document.createElement('span');
        wrap.className = 'fraction-row';
        for (const frac of [0.1, 0.25, 0.5]) {
          const b = document.createElement('button');
          b.className = 'ghost';
          b.textContent = `copy ${frac * 100}%`;
          b.onclick = e => {
            e.stopPropagation();
            const r = followTrader(state, me.id, row.id, frac);
            msg('copy-list', r.ok ? `Following ${row.name} at ${frac * 100}% (paper)` : r.error, r.ok ? 'ok' : 'err');
            save(); renderCopy();
          };
          wrap.appendChild(b);
        }
        div.appendChild(wrap);
      } else {
        const b = document.createElement('button');
        b.className = 'ghost'; b.textContent = 'unfollow';
        b.onclick = e => { e.stopPropagation(); unfollowTrader(state, me.id, row.id); save(); renderCopy(); };
        div.appendChild(b);
      }
      list.appendChild(div);
    }
  }

  const fl = $('following-list');
  const fols = following(state, me.id);
  fl.innerHTML = fols.length ? '' : '<p class="muted">Not following anyone.</p>';
  for (const f of fols) {
    const l = getTrader(state, f.leaderId);
    const div = document.createElement('div');
    div.className = 'lb-row';
    div.innerHTML = `<span class="lb-name"><b>${l ? l.name.replace(/[<>&]/g, '') : '?'}</b><small>mirroring at ${f.fraction * 100}% · since ${fmtT(f.since)}</small></span>`;
    const b = document.createElement('button');
    b.className = 'ghost'; b.textContent = 'unfollow';
    b.onclick = () => { unfollowTrader(state, me.id, f.leaderId); save(); renderCopy(); };
    div.appendChild(b);
    fl.appendChild(div);
  }

  const cf = $('copy-feed');
  cf.innerHTML = copyFeed.length ? '' : '<p class="muted">Copied trades will appear here.</p>';
  for (const e of copyFeed) {
    const div = document.createElement('div');
    div.className = 'trade-row';
    div.innerHTML = `<span>🔁 ${e.text}</span><small class="muted">${fmtT(e.at)}</small>`;
    cf.appendChild(div);
  }
}

// ---------- wallet ----------
function renderWallet() {
  const has = !!walletAddr;
  $('wallet-connected').classList.toggle('hidden', !has);
  $('wallet-connect-form').classList.toggle('hidden', has);
  if (has) {
    $('wallet-addr').textContent = shortAddress(walletAddr);
    lookupWallet();
  }
}

async function lookupWallet() {
  const el = $('wallet-balances');
  el.innerHTML = '<p class="muted">Looking up balances…</p>';
  const chain = detectChain(walletAddr);
  if (!chain) { el.innerHTML = '<p class="muted">Unrecognized address format.</p>'; return; }
  try {
    const b = await fetchAddressBalance(chain, walletAddr);
    el.innerHTML = `<div class="pos-row"><span><b>${b.label}</b><br><small class="muted">${shortAddress(walletAddr)} · ${b.txCount ?? '?'} txs</small></span>
      <b>${b.balance.toFixed(6)} ${b.ticker}</b></div>
      <p class="muted small">Read-only view. Paper trading only — this app cannot move funds.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="muted">Balance lookup failed (${String(e.message).slice(0, 60)}). Address is still linked read-only.</p>`;
  }
}

// ---------- share ----------
function doExport() {
  const t = ensureTrader();
  const box = $('share-box');
  box.classList.remove('hidden');
  $('btn-do-import').classList.add('hidden');
  box.value = exportTrader(state, t.id);
  box.select();
  msg('share-msg', 'Share code copied to the box — send it to a friend. It contains only your paper trades.', 'ok');
}
function doImport() {
  const box = $('share-box');
  box.classList.remove('hidden');
  $('btn-do-import').classList.remove('hidden');
  box.value = '';
  box.placeholder = 'Paste a trader share code here, then tap Import';
  box.focus();
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('tab-' + b.dataset.tab).classList.add('active');
  };
});

// ---------- wire up ----------
function init() {
  const sym = $('trade-symbol');
  for (const s of Object.keys(CONFIG.SYMBOLS)) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sym.appendChild(o);
  }
  sym.value = 'BTC';
  sym.onchange = () => { renderTickers(); updateTradePrice(); };

  $('side-buy').onclick = () => { side = 'buy'; $('side-buy').classList.add('active'); $('side-sell').classList.remove('active'); };
  $('side-sell').onclick = () => { side = 'sell'; $('side-sell').classList.add('active'); $('side-buy').classList.remove('active'); };
  $('btn-trade').onclick = placeTrade;
  $('btn-max').onclick = () => {
    const t = ensureTrader();
    const s = $('trade-symbol').value;
    const g = feed.get(s);
    if (g.price == null) return;
    if (side === 'buy') $('trade-qty').value = (t.cash / (g.price * 1.001)).toFixed(6);
    else $('trade-qty').value = (t.positions[s]?.qty || 0).toFixed(6);
  };
  $('btn-switch-trader').onclick = () => {
    const name = prompt('Trader name (creates a new paper account if new):', '');
    if (!name) return;
    const existing = Object.values(state.traders).find(x => x.name.toLowerCase() === name.trim().toLowerCase());
    const t = existing || createTrader(state, name);
    activeTraderId = t.id;
    save(); renderAll();
  };
  $('btn-refresh-board').onclick = () => { renderBoard(); renderCopy(); renderBotBoard(); };
  $('btn-export').onclick = doExport;
  $('btn-import').onclick = doImport;
  $('btn-do-import').onclick = () => {
    const r = importTrader(state, $('share-box').value.trim());
    msg('share-msg', r.ok ? `Imported ${r.trader.name} — ${r.trader.trades.length} paper trades` : r.error, r.ok ? 'ok' : 'err');
    if (r.ok) { save(); renderAll(); }
  };

  // wallet
  $('btn-connect-wallet').onclick = () => { $('wallet-modal').classList.remove('hidden'); };
  $('modal-close').onclick = () => { $('wallet-modal').classList.add('hidden'); };
  $('btn-link-wallet').onclick = () => {
    const a = $('wallet-input').value.trim();
    if (!detectChain(a)) { $('modal-msg').textContent = 'That does not look like a wallet address.'; $('modal-msg').className = 'msg err'; return; }
    walletAddr = a;
    $('wallet-modal').classList.add('hidden');
    $('wallet-input').value = '';
    save(); renderWallet();
    msg('wallet-msg', 'Address linked read-only. Never share seed phrases or private keys.', 'ok');
  };
  $('btn-disconnect').onclick = () => { walletAddr = null; save(); renderWallet(); };

  // live trading badge reflects the hard-disabled module
  if (!LIVE_TRADING_ENABLED) $('live-badge').textContent = 'LIVE TRADING: DISABLED';

  ensureTrader();
  renderAll();
  refreshPrices();
  setInterval(refreshPrices, CONFIG.PRICE_REFRESH_MS);
}

function renderAll() {
  renderStats();
  renderTickers();
  updateTradePrice();
  renderBoard();
  renderBotBoard();
  renderCopy();
  renderWallet();
}

init();
