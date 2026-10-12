import test from 'node:test';
import assert from 'node:assert/strict';
import { phase11DayType } from '../../js/phase11.js';
import { buildCompactDailyGroups } from '../../worker/worker.js';
import { buildLocalProfiles } from '../../tools/phase11-local-model.js';
import { buildHistoryProfiles } from '../../tools/phase11-history-model.js';

test('official Japanese holidays include substitute and citizens holidays in JST', () => {
  for (const date of ['2026-05-06', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2027-03-22']) {
    assert.equal(phase11DayType(Date.parse(date+'T12:00+09:00')), 'holiday');
  }
  assert.equal(phase11DayType(Date.parse('2026-10-11T15:00:00Z')), 'holiday');
  assert.equal(phase11DayType(Date.parse('2026-10-12T15:00:00Z')), 'weekday');
  assert.equal(phase11DayType(Date.parse('2026-10-13T12:00+09:00'), new Set(['2026-10-13'])), 'holiday');
});

test('raw event daily generation classifies a Monday public holiday without configuration', () => {
  const event={event_id:'observed',segment_key:'r|0|a>b',route_id:'r',seconds:80,timestamp_ms:Date.parse('2026-10-12T12:00+09:00')};
  const groups=buildCompactDailyGroups([event]);
  assert.equal(groups[0].day_type,'holiday');
  assert.equal(groups[0].samples[0][5],'observed');
});

test('stored weekday samples are regrouped by actual official holiday without mutation or duplication', () => {
  const make=(day,seconds)=>Array.from({length:3},(_,i)=>[seconds,Date.parse(day+'T12:00+09:00')+i*1000,null,null,null,day+i]);
  const input=[{groups:[{segment_key:'r|0|a>b',route_id:'r',direction_id:'0',from_stop_id:'a',to_stop_id:'b',day_type:'weekday',time_bin:'12:00',samples:[...make('2026-10-12',120),...make('2026-10-05',60)]}]}];
  const before=JSON.stringify(input),result=buildLocalProfiles(input,Date.parse('2026-10-13T04:15+09:00'));
  assert.equal(result.profiles.length,2);
  assert.equal(result.profiles.find(p=>p.day_type==='holiday').median_seconds,120);
  assert.equal(result.profiles.find(p=>p.day_type==='weekday').median_seconds,60);
  assert.equal(result.profiles.reduce((s,p)=>s+p.sample_count,0),6);
  assert.equal(JSON.stringify(input),before);
  const historical=buildHistoryProfiles([{date_key:'2026-10-12',...input[0]}],Date.parse('2026-10-13T04:15+09:00'));
  assert.deepEqual(historical.profiles.map(p=>[p.day_type,p.median_seconds]).sort(),[['holiday',120],['weekday',60]]);
  assert.equal(JSON.stringify(input),before);
});
