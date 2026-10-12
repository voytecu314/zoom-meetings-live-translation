// Translation module tests using the mock provider (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateText, __setProviderForTests } from '../server/translation/index.js';
import { createMockProvider } from '../server/translation/mock.js';
import { createRateLimiter } from '../server/translation/provider-interface.js';

test('mock provider marks up text per target language', async () => {
  __setProviderForTests(createMockProvider());
  const r = await translateText('Hello world', 'en', 'de');
  assert.equal(r.ok, true);
  assert.equal(r.text, '[de] Hello world');
});

test('empty input short-circuits without calling provider', async () => {
  let called = 0;
  __setProviderForTests({
    name: 'counting',
    async translate() { called++; return 'x'; },
  });
  const r = await translateText('   ', 'en', 'de');
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
  assert.equal(called, 0);
});

test('provider errors are returned as { ok:false } — never thrown', async () => {
  __setProviderForTests({
    name: 'always-failing',
    async translate() { throw new Error('boom'); },
  });
  const r = await translateText('Hello', 'en', 'de');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('retryable errors are retried but eventually fail without crashing', async () => {
  let attempts = 0;
  __setProviderForTests({
    name: 'flaky',
    async translate() {
      attempts++;
      const err = new Error('translation timed out');
      err.retryable = true;
      throw err;
    },
  });
  const r = await translateText('Hello', 'en', 'de');
  assert.equal(r.ok, false);
  assert.ok(attempts >= 2, `expected retries, got ${attempts} attempts`);
});

test('rate limiter bounds concurrency', async () => {
  const limiter = createRateLimiter(2);
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 8 }, () =>
    limiter.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    })
  );
  await Promise.all(jobs);
  assert.equal(peak, 2);
});

test('timeout is applied to hanging providers', async () => {
  __setProviderForTests({
    name: 'hanging',
    translate: () => new Promise(() => {}), // never resolves
  });
  const r = await translateText('Hello', 'en', 'de');
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out|failed/);
});
