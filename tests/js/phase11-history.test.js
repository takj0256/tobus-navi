import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveDaily, validateDaily } from '../../tools/archive_phase11_history.mjs';
import { exportLegacy } from '../../tools/export_phase11_legacy.mjs';
import { buildHistoryProfiles, predictionExample } from '../../tools/phase11-history-model.js';
import { readJson } from '../../tools/phase11-storage.mjs';
import { publishPhase11Json } from '../../tools/publish_phase11_json_to_r2.mjs';

async function temp(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase11-history-test-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const daily = (date, samples = []) => ({ version: 2, date_key: date, groups: [{ segment_key: 'r|0|a>b', route_id: 'r', direction_id: '0', from_stop_id: 'a', to_stop_id: 'b', day_type: 'weekday', time_bin: '08:00', samples }] });
test('archive revisions preserve bytes, replace only active date and skip repeated remote writes', async t => {
  const root = await temp(t), writes = [];
  const client = { putVerified: async key => writes.push(key) };
  const a = Buffer.from(JSON.stringify(daily('2026-09-17', [[60, 1]])));
  const b = Buffer.from(JSON.stringify(daily('2026-09-17', [[70, 2]])));
  await archiveDaily(root, '2026-09-17', a, client);
  await archiveDaily(root, '2026-09-17', a, client);
  assert.equal(writes.length, 2);
  await archiveDaily(root, '2026-09-17', b, client);
  assert.equal(writes.length, 4);
  const index = await readJson(path.join(root, 'index.json'));
  assert.equal(Object.keys(index.dates).length, 1);
  assert.equal((await fs.readdir(path.join(root, 'history-v1/daily/2026-09-17'))).length, 2);
  assert.throws(() => validateDaily(daily('2026-09-16'), '2026-09-17'));
});
test('remote failure never advances active archive index', async t => {
  const root = await temp(t);
  await assert.rejects(archiveDaily(root, '2026-09-17', Buffer.from(JSON.stringify(daily('2026-09-17'))), { putVerified: async () => { throw Error('network'); } }));
  assert.equal(await readJson(path.join(root, 'index.json'), null), null);
});
test('legacy export resumes and persists budget across invocations', async t => {
  const root = await temp(t), writes = [], queries = [];
  const client = {
    identity: { database: 'test' }, putVerified: async (key, data) => writes.push([key, JSON.parse(data)]),
    query: async (sql, params) => {
      queries.push(sql);
      if (sql.includes('sqlite_master')) return [{ results: ['profiles','weather_profiles','job_status'].map(name => ({ name, sql: `CREATE TABLE ${name} (x TEXT)` })), meta: { rows_read: 3, rows_written: 0 } }];
      return [{ results: params[0] === 0 ? [{ export_rowid: 1, generated_at: '2026-09-10' }, { export_rowid: 2, generated_at: '2026-09-10' }] : [], meta: { rows_read: params[0] === 0 ? 2 : 0, rows_written: 0 } }];
    },
  };
  const options = { now: new Date('2026-09-18T00:00Z'), readBudget: 250, pageSize: 2, maxPages: 1 };
  const first = await exportLegacy(root, client, options);
  assert.equal(first.tables.profiles.after, 2);
  await exportLegacy(root, client, options);
  assert.equal(writes.filter(([key]) => key.includes('/profiles/')).length, 1);
  const before = queries.length;
  await exportLegacy(root, client, options);
  assert.equal(queries.length, before); // reserved schema budget prevents repeat queries
  assert.ok(queries.every(sql => sql.startsWith('SELECT')));
  assert.equal(writes.find(([key]) => key.includes('/profiles/'))[1].kind, 'legacy-aggregate-not-observations');
});
test('export failure reserves budget but does not advance cursor', async t => {
  const root = await temp(t);
  await assert.rejects(exportLegacy(root, { identity: {}, query: async () => { throw Error('timeout'); } }));
  assert.equal((await readJson(path.join(root, 'state.json'))).budgets[new Date().toISOString().slice(0,10)].reserved_reads, 100);
});
test('history baseline plus recent residual does not count recent data as baseline', () => {
  const now = Date.parse('2026-09-18T00:00Z'), rows = [];
  for (let day = 0; day < 4; day++) {
    const at = now - (365 + day) * 86400000;
    rows.push(daily(new Date(at).toISOString().slice(0,10), Array.from({length:3}, (_,i) => [100, at+i, 'clear','mild', null, `old${day}-${i}`])));
  }
  rows.push(daily('2026-09-17', Array.from({length:12}, (_,i) => [150, now-86400000+i, 'clear','mild',null,`new${i}`])));
  const result = buildHistoryProfiles(rows, now).profiles[0];
  assert.equal(result.history.strategy, 'seasonal-baseline');
  assert.equal(result.history.baseline_sample_count, 12);
  assert.equal(result.history.recent_sample_count, 12);
  assert.ok(result.profile_seconds > 100 && result.profile_seconds < 150);
  assert.throws(() => buildHistoryProfiles([...rows, rows[0]], now), /revision/);
});
test('future observations excluded and prediction inputs reject future weather', () => {
  const now = Date.parse('2026-09-18T00:00Z');
  assert.equal(buildHistoryProfiles([daily('2026-09-19', [[100,now+86400000]])], now).profiles.length, 0);
  assert.throws(() => predictionExample({ prediction_id:'p', predicted_at:'2026-09-18T00:00Z', target_at:'2026-09-18T01:00Z', segment_key:'s',generation:'g',predicted_seconds:100,features:{weather:{observed_at:'2026-09-18T00:01Z'}} }), /Future/);
});

test('production publisher refuses an unvalidated candidate before any request', async t => {
  const root = await temp(t);
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify({ candidate_only: true }));
  await assert.rejects(publishPhase11Json(root, { token: 'test', apiBase: 'http://127.0.0.1:1' }), /publication denied/);
});
test('legacy upload failure keeps cursor unchanged and retains reservation', async t => {
  const root = await temp(t);
  const client = { identity: {}, putVerified: async () => { throw Error('upload failed'); }, query: async sql => [{ results: sql.includes('sqlite_master') ? ['profiles','weather_profiles','job_status'].map(name=>({name,sql:'CREATE TABLE test(x TEXT)'})) : [{export_rowid:1,generated_at:'old'}], meta:{rows_read:1,rows_written:0} }] };
  await assert.rejects(exportLegacy(root, client), /upload failed/);
  const state = await readJson(path.join(root,'state.json'));
  assert.equal(state.tables.profiles.after, 0);
  assert.equal(state.tables.profiles.count, 0);
  assert.equal(Object.values(state.budgets)[0].reserved_reads, 610);
});
