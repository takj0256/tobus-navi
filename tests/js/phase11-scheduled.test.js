import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = resolve('tools/run_phase11_scheduled.sh');
function fixture(t, body = 'echo run >> "$PWD/runs"\nexit 0\n') {
  const root = mkdtempSync(join(tmpdir(), 'phase11-scheduled-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'app/tools'), { recursive: true });
  mkdirSync(join(root, 'nvm'));
  writeFileSync(join(root, 'nvm/nvm.sh'), ':\n');
  writeFileSync(join(root, 'app/tools/run_phase11_local_aggregation.sh'), body);
  const env = { ...process.env, NVM_DIR: join(root, 'nvm') };
  return { root, env, run: () => spawnSync('bash', [runner, root], { env, encoding: 'utf8' }) };
}
const opts = { skip: process.platform === 'win32' };
test('scheduled success records date; repeated launch does not aggregate again', opts, t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.match(readFileSync(join(f.root, 'aggregation-success-date'), 'utf8'), /^\d{4}-\d{2}-\d{2}\n$/);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.root, 'app/runs'), 'utf8'), 'run\n');
});
test('failure propagates exit status and does not mark success', opts, t => {
  const f = fixture(t, 'exit 23\n');
  assert.equal(f.run().status, 23);
  assert.equal(existsSync(join(f.root, 'aggregation-success-date')), false);
});
test('stale marker allows a new run', opts, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'aggregation-success-date'), '2000-01-01\n');
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.root, 'app/runs'), 'utf8'), 'run\n');
});
test('held lock prevents execution and signals retry', opts, t => {
  const f = fixture(t);
  const result = spawnSync('flock', [join(f.root, 'aggregation.lock'), 'bash', runner, f.root], { env: f.env });
  assert.equal(result.status, 75);
  assert.equal(existsSync(join(f.root, 'app/runs')), false);
});
