// Storage abstraction: localStorage in the browser, in-memory for Node tests.
// Only ever stores PAPER trading data. No keys, no secrets, ever.
import { CONFIG } from './config.js';

function makeMemoryAdapter() {
  const mem = {};
  return {
    get(k) { return k in mem ? mem[k] : null; },
    set(k, v) { mem[k] = v; },
    del(k) { delete mem[k]; },
  };
}

function makeLocalAdapter() {
  return {
    get(k) {
      try { return window.localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { window.localStorage.setItem(k, v); } catch { /* storage full/blocked */ }
    },
    del(k) {
      try { window.localStorage.removeItem(k); } catch { /* noop */ }
    },
  };
}

const adapter = (typeof window !== 'undefined' && window.localStorage)
  ? makeLocalAdapter()
  : makeMemoryAdapter();

export const store = {
  load() {
    const raw = adapter.get(CONFIG.STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  save(state) {
    adapter.set(CONFIG.STORAGE_KEY, JSON.stringify(state));
  },
  clear() {
    adapter.del(CONFIG.STORAGE_KEY);
  },
  // test hook: swap the backing adapter
  _memoryAdapter: makeMemoryAdapter,
};
