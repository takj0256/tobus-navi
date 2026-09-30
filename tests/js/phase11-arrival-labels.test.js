import test from 'node:test';import assert from 'node:assert/strict';
import {ArrivalLabels} from '../../tools/build_phase11_arrival_dataset.mjs';
const feed=(seq,t,trip='trip')=>({vehicles:[{vehicle:{id:'bus'},trip:{tripId:trip,routeId:'r',directionId:0},stopId:`s${seq}`,currentStopSequence:seq,timestamp:t/1000}]});
test('first sighting is left censored; repeated stop retains first transition time',()=>{
  const a=new ArrivalLabels();
  for(const [seq,t] of [[1,100000],[2,160000],[2,220000],[3,280000]])a.push(feed(seq,t),t+1000);
  assert.equal(a.rows.length,1);assert.equal(a.rows[0].seconds,120);
  assert.equal(a.rows[0].crossing_lower,220000);assert.equal(a.rows[0].crossing_upper,280000);
  assert.ok(a.rows[0].queries.every(q=>q.available<280000));
});
test('trip reset, skipped stop and capture outage never manufacture a label',()=>{
  for(const mode of ['trip','skip','gap']){
    const a=new ArrivalLabels();a.push(feed(1,100000),101000);a.push(feed(2,160000),161000);
    a.push(feed(mode==='skip'?4:3,mode==='gap'?400000:220000,mode==='trip'?'other':'trip'),mode==='gap'?401000:221000);
    assert.equal(a.rows.length,0);
  }
});
test('repeated timestamps do not create training examples or refresh freshness',()=>{
  const a=new ArrivalLabels();a.push(feed(1,100000),101000);a.push(feed(2,160000),161000);
  a.push(feed(2,160000),210000);a.push(feed(3,400000),401000);assert.equal(a.rows.length,0);
});
test('stale and future timestamps are rejected',()=>{
  const a=new ArrivalLabels();a.push(feed(1,1000),500000);a.push(feed(2,900000),500000);
  assert.equal(a.audit.stale,2);assert.equal(a.rows.length,0);
});
