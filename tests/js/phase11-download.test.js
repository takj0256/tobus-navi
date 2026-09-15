import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function runFixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'phase11-download-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['tools', 'node_modules/.bin', 'mockbin']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync('tools/run_phase11_local_aggregation.sh', join(root, 'tools/run_phase11_local_aggregation.sh'));
  writeFileSync(join(root, 'node_modules/.bin/wrangler'), `#!/bin/bash
count=0
[[ ! -f "$TEST_ROOT/count" ]] || count=$(cat "$TEST_ROOT/count")
count=$((count+1))
echo "$count" > "$TEST_ROOT/count"
if (( count >= 3 )) && { [[ "$TEST_MODE" != transient ]] || (( count == 3 )); }; then
  if [[ "$TEST_MODE" == missing ]]; then echo 'The specified key does not exist'; else echo 'network terminated'; fi
  exit 1
fi
while (( $# )); do
  if [[ "$1" == --file ]]; then printf '{}\\n' > "$2"; break; fi
  shift
done
`, { mode: 0o755 });
  writeFileSync(join(root, 'mockbin/node'), '#!/bin/bash\necho "$*" >> "$TEST_ROOT/node-calls"\n', { mode: 0o755 });
  writeFileSync(join(root, 'mockbin/sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', [join(root, 'tools/run_phase11_local_aggregation.sh')], {
    env: { ...process.env, TEST_ROOT: root, TEST_MODE: mode, PATH: `${root}/mockbin:${process.env.PATH}` }, encoding: 'utf8',
  });
  return { root, result };
}
const opts = { skip: process.platform === 'win32' };
test('transient daily download retries then publishes all 28 dates', opts, t => {
  const { root, result } = runFixture(t, 'transient');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete \(28 source objects/);
  assert.match(result.stderr, /retry 2\/5/);
  assert.match(readFileSync(join(root, 'node-calls'), 'utf8'), /publish_phase11_json_to_r2/);
});
for (const mode of ['missing', 'permanent']) {
  test(`${mode} daily download aborts before aggregation/publication`, opts, t => {
    const { root, result } = runFixture(t, mode);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'node-calls')), false);
    assert.match(result.stderr, /不完全な28日集計を公開せず/);
  });
}
