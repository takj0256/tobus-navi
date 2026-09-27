import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedMissingKeys, unapprovedMissingKeys, dailyQuality, summarizeInputQuality } from '../../tools/phase11-approved-gaps.mjs';
test('approval covers exactly nine historical minutes, not future gaps',()=>{
 assert.equal(['2026-09-24','2026-09-25','2026-09-26'].flatMap(approvedMissingKeys).length,9);
 assert.equal(approvedMissingKeys('2026-09-27').length,0);
 const key=approvedMissingKeys('2026-09-26')[0];
 assert.deepEqual(unapprovedMissingKeys('2026-09-26',[key]),[]);
 assert.deepEqual(unapprovedMissingKeys('2026-09-25',[key]),[key]);
 assert.equal(unapprovedMissingKeys('2026-09-26',[key,'raw-v1/2026-09-26/01/55.pb']).length,1);
});
test('daily and manifest metadata disclose gaps without imputing observations',()=>{
 const days=['2026-09-24','2026-09-25','2026-09-26'].map(date_key=>({date_key,data_quality:dailyQuality(date_key)}));
 const q=summarizeInputQuality(days);assert.equal(q.missing_capture_minutes,9);assert.equal(q.days.length,3);
 assert.ok(q.days.every(d=>d.imputed_observations===0));
 assert.equal(dailyQuality('2026-09-27'),undefined);assert.equal(summarizeInputQuality([{date_key:'2026-09-27'}]),undefined);
});
