import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverExpiredOAuth } from '../../tools/phase11-storage.mjs';

test('expired OAuth read refreshes and uses only changed credentials',async()=>{
 let refreshes=0; const credential={token:'old',oauth:true,expires:'2026-09-24T00:00Z'};
 const options={status:401,method:'GET',credential,now:Date.parse('2026-09-24T00:01Z'),refresh:async()=>{refreshes++;},reload:async()=>({token:'new',oauth:true})};
 assert.equal((await recoverExpiredOAuth(options)).token,'new');assert.equal(refreshes,1);
 assert.equal(await recoverExpiredOAuth({...options,reload:async()=>credential}),null);
});
test('near-expiry read waits at most 31 seconds before normal refresh',async()=>{
 let delay=0;const result=await recoverExpiredOAuth({status:401,method:'GET',credential:{token:'old',oauth:true,expires:'2026-09-24T00:00:20Z'},now:Date.parse('2026-09-24T00:00Z'),wait:async ms=>{delay=ms;},refresh:async()=>{},reload:async()=>({token:'new'})});
 assert.equal(delay,21000);assert.equal(result.token,'new');
});
test('writes, API tokens, 403 and non-expiry rejection never trigger refresh',async()=>{
 const options={status:401,method:'GET',credential:{token:'old',oauth:true,expires:'2026-09-24T00:00Z'},now:Date.parse('2026-09-24T00:01Z'),refresh:async()=>{throw Error('must not refresh');}};
 for(const override of [{method:'POST'},{method:'PUT'},{status:403},{credential:{token:'env',oauth:false}},{credential:{token:'old',oauth:true,expires:'2026-09-24T01:00Z'}}])assert.equal(await recoverExpiredOAuth({...options,...override}),null);
});
test('refresh failure propagates without returning a stale token',async()=>{
 await assert.rejects(recoverExpiredOAuth({status:401,method:'GET',credential:{token:'old',oauth:true,expires:'2026-09-24T00:00Z'},now:Date.parse('2026-09-24T00:01Z'),refresh:async()=>{throw Error('offline');}}),/offline/);
});
