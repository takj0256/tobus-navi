import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyRequestPolicy } from '../../tools/phase11-daily-request-policy.mjs';

test('daily reads retain the existing bounded policy', () => {
  assert.deepEqual(dailyRequestPolicy('GET'), { attempts: 8, baseDelayMs: 1000, timeoutMs: 120000 });
});
test('small daily uploads retain 120 seconds with fewer retries', () => {
  assert.deepEqual(dailyRequestPolicy('PUT', '{}'), { attempts: 3, baseDelayMs: 1000, timeoutMs: 120000 });
});
test('large daily uploads get a byte-based bounded transfer budget', () => {
  const body = 'a'.repeat(18_000_000);
  assert.equal(dailyRequestPolicy('PUT', body).timeoutMs, 222000);
  assert.equal(dailyRequestPolicy('PUT', 'a'.repeat(40_736_193)).timeoutMs, 464520);
  assert.equal(dailyRequestPolicy('PUT', 'a'.repeat(60_000_000)).timeoutMs, 600000);
});
test('serialized UTF-8 byte count is used, never character count', () => {
  assert.equal(dailyRequestPolicy('PUT', 'あ'.repeat(6_000_000)).timeoutMs, 222000);
  assert.throws(() => dailyRequestPolicy('PUT', undefined), TypeError);
});
