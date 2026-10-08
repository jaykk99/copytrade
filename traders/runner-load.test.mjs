// Tests for the strategy-module loader in traders/run.mjs.
// The "strategy module not ready yet" path must carry the real failure reason
// so a silently-skipped strategy is diagnosable (missing file vs. syntax error
// vs. missing export).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStrategy } from './run.mjs';

test('loadStrategy returns ok:true for a valid strategy module', async () => {
  const res = await loadStrategy({ key: 'momentum', file: './strategies/momentum.mjs' });
  assert.equal(res.ok, true);
  assert.equal(typeof res.mod.decide, 'function');
  assert.equal(typeof res.mod.STRATEGY_NAME, 'string');
});

test('loadStrategy reports the real reason for a missing module', async () => {
  const res = await loadStrategy({ key: 'ghost', file: './private/does-not-exist.mjs' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Cannot find module|ENOENT/);
  assert.match(res.reason, /does-not-exist/);
});

test('loadStrategy flags a module with no decide export', async () => {
  const res = await loadStrategy({ key: 'bad', file: '../js/config.js' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no decide\(\) export/);
});

test('loadStrategy fails closed on a syntax-error module', async () => {
  // A module with a genuine syntax error must NOT be misreported as merely
  // "not deployed" — the loader must surface the parse failure.
  const { writeFileSync } = await import('fs');
  const { pathToFileURL } = await import('url');
  const p = '/tmp/copytrade-broken-strategy.mjs';
  writeFileSync(p, 'export const STRATEGY_NAME = ; // syntax error\n');
  const res = await loadStrategy({ key: 'broken', file: pathToFileURL(p).href });
  assert.equal(res.ok, false);
  assert.ok(res.reason.length > 0);
  assert.match(res.reason, /Unexpected token|SyntaxError/i);
});
