import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson, sha256, cloudflareClient, withDirectoryLock } from './phase11-storage.mjs';

// Legacy aggregates are NOT raw observations. They must never enter daily training input.
export async function exportLegacy(root, client, { now = new Date(), readBudget = 10000, pageSize = 500, maxPages = 10 } = {}) {
  if (![readBudget, pageSize, maxPages].every(n => Number.isInteger(n) && n > 0) || pageSize > 1000 || readBudget > 10000 || maxPages > 20) throw Error('Invalid bounded export options');
  return withDirectoryLock(root, async () => {
    const file = path.join(root, 'state.json');
    const state = await readJson(file, { version: 1, identity: client.identity, snapshot: now.toISOString().replaceAll(':', '-'), tables: {}, budgets: {} });
    if (JSON.stringify(state.identity) !== JSON.stringify(client.identity)) throw Error('Archive state belongs to another Cloudflare source');
    // UTC budget day matches D1 accounting. Persist reservations before each query.
    const day = now.toISOString().slice(0, 10);
    state.budgets[day] ||= { reserved_reads: 0, rows_exported: 0 };
    const budget = state.budgets[day];
    async function query(sql, params, reserve) {
      if (budget.reserved_reads + reserve > readBudget) return null;
      budget.reserved_reads += reserve;
      await atomicJson(file, state);
      const result = await client.query(sql, params);
      const reads = result.reduce((n, r) => n + Number(r.meta?.rows_read || 0), 0);
      budget.reserved_reads += Math.max(0, reads - reserve);
      await atomicJson(file, state);
      if (result.some(r => Number(r.meta?.rows_written || 0) !== 0)) throw Error('Unexpected D1 write');
      if (reads > reserve) throw Error('D1 scan exceeded reservation; stop and inspect query plan');
      return result[0].results;
    }
    const schema = await query("SELECT name,sql FROM sqlite_master WHERE type='table'", [], 100);
    if (!schema) return { paused: 'daily-read-budget', ...budget };
    let pages = 0;
    for (const table of ['profiles', 'weather_profiles', 'job_status']) {
      const definition = schema.find(x => x.name === table)?.sql;
      if (!definition || /WITHOUT ROWID/i.test(definition)) throw Error(`Unsupported real schema: ${table}`);
      const cursor = state.tables[table] ||= { after: 0, count: 0, complete: false };
      while (!cursor.complete && pages < maxPages && budget.rows_exported + pageSize <= 5000) {
        const rows = await query(`SELECT rowid AS export_rowid,* FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [cursor.after, pageSize], pageSize + 10);
        if (!rows) break;
        pages++;
        if (!rows.length) { cursor.complete = true; await atomicJson(file, state); break; }
        for (const row of rows) {
          if (row.export_rowid <= cursor.after) throw Error('Non-monotonic cursor');
          if (table !== 'job_status') {
            cursor.generated_at ||= row.generated_at;
            if (row.generated_at !== cursor.generated_at) throw Error('Legacy generation changed; stop instead of mixing snapshots');
          }
        }
        const data = Buffer.from(JSON.stringify({ version: 1, kind: 'legacy-aggregate-not-observations', source: client.identity, table, exported_at: now.toISOString(), rows }));
        const key = `legacy-d1-v1/${state.snapshot}/${table}/${cursor.after}-${rows.at(-1).export_rowid}-${sha256(data)}.json`;
        await client.putVerified(key, data);
        await fs.mkdir(path.join(root, table), { recursive: true });
        await fs.writeFile(path.join(root, table, path.basename(key)), data);
        cursor.after = rows.at(-1).export_rowid;
        cursor.count += rows.length;
        cursor.complete = rows.length < pageSize;
        budget.rows_exported += rows.length;
        (state.chunks ||= []).push({ key, sha256: sha256(data), table, count: rows.length });
        await atomicJson(file, state);
      }
    }
    await client.putVerified(`legacy-d1-v1/${state.snapshot}/manifest.json`, Buffer.from(JSON.stringify(state)));
    return { snapshot: state.snapshot, tables: state.tables, budget_day_utc: day, ...budget, complete: ['profiles', 'weather_profiles', 'job_status'].every(t => state.tables[t]?.complete) };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) throw Error('Usage: export_phase11_legacy.mjs STATE_ROOT');
  console.log(JSON.stringify(await exportLegacy(root, await cloudflareClient())));
}
