import test from 'node:test';import assert from 'node:assert/strict';
import { qualityFromAudit, observedEventsOutsideGaps, AVAILABLE_OBSERVATIONS_POLICY } from '../../tools/phase11-publication-quality.mjs';
import { buildLocalProfiles } from '../../tools/phase11-local-model.js';
import { summarizeInputQuality } from '../../tools/phase11-approved-gaps.mjs';
const audit={date_key:'2026-10-01',start_at:'2026-09-22T23:07Z',checked_at:'2026-10-01T19:15:00Z',publication_policy:AVAILABLE_OBSERVATIONS_POLICY,backlog:0,pending_hours:0,missing_raw_keys:['raw-v1/2026-10-01/04/18.pb']};
test('partial day is disclosed, unfinished and mismatched audits remain blocked',()=>{
 const q=qualityFromAudit('2026-10-01',audit);assert.equal(q.missing_capture_minutes,1);assert.equal(q.imputed_observations,0);
 for(const changes of [{backlog:1},{pending_hours:1},{date_key:'2026-09-30'},{checked_at:'2026-10-01T14:00Z'},{missing_raw_keys:['raw-v1/2026-10-01/16/00.pb']}])assert.throws(()=>qualityFromAudit('2026-10-01',{...audit,...changes}));
 assert.equal(summarizeInputQuality([{date_key:'2026-10-01',data_quality:q}]).status,'contains-partial-observations');
 assert.throws(()=>qualityFromAudit('2026-10-01',{...audit,start_at:'2026-10-02T00:00Z'}));
});
test('an interval crossing a missing minute is excluded while other time ranges survive',()=>{
 const t=Date.parse('2026-10-01T04:18Z'),q=qualityFromAudit('2026-10-01',audit);
 const events=[{event_id:'before',timestamp_ms:t-1,seconds:60},{event_id:'cross',timestamp_ms:t+120000,seconds:180},{event_id:'after',timestamp_ms:t+180000,seconds:60}];
 assert.deepEqual(observedEventsOutsideGaps(events,q).map(e=>e.event_id),['before','after']);
});
test('missing day/time is predicted from real same-bin observations on other days with no sample inflation',()=>{
 const now=Date.parse('2026-10-02T00:00Z');
 const base={segment_key:'r|0|a>b',route_id:'r',direction_id:'0',from_stop_id:'a',to_stop_id:'b',day_type:'weekday',time_bin:'13:15'};
 const observed={date_key:'2026-09-24',groups:[{...base,samples:[100,120,140].map((s,i)=>[s,now-7*86400000+i*60000])}]};
 const partial={date_key:'2026-10-01',data_quality:qualityFromAudit('2026-10-01',audit),groups:[{...base,time_bin:'14:00',samples:[70,80,90].map((s,i)=>[s,now-86400000+i*60000])}]};
 const rows=buildLocalProfiles([observed,partial],now).profiles;
 const predicted=rows.find(p=>p.time_bin==='13:15');assert.equal(predicted.profile_seconds,120);assert.equal(predicted.sample_count,3);
 assert.ok(rows.some(p=>p.time_bin==='14:00'));assert.equal(rows.reduce((s,p)=>s+p.sample_count,0),6);
});
