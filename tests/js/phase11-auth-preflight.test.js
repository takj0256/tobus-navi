import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const helper=fileURLToPath(new URL('../../tools/phase11_auth.sh',import.meta.url));
for(const [failures,expectedCalls,expectedStatus] of [[0,1,0],[1,2,0],[2,3,0],[3,3,7]]){
 test(`auth preflight handles ${failures} failures with bounded retry`,()=>{
  const r=spawnSync('bash',['-c',`source "$1"; calls=0; sleep(){ :; }; mock(){ test "$1" = whoami || exit 99; calls=$((calls+1)); if ((calls <= ${failures})); then return 7; fi; }; if phase11_auth_check mock; then code=0; else code=$?; fi; echo "$calls $code"; exit "$code"`,'bash',helper],{encoding:'utf8'});
  assert.equal(r.status,expectedStatus,r.stderr);assert.equal(r.stdout.trim(),`${expectedCalls} ${expectedStatus}`);
 });
}
