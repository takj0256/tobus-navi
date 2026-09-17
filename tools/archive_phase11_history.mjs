import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson, sha256, cloudflareClient, withDirectoryLock } from './phase11-storage.mjs';

export function validateDaily(payload, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || payload.version !== 2 || payload.date_key !== date || !Array.isArray(payload.groups)) throw Error(`Invalid daily-v2: ${date}`);
  const keys = new Set();
  for (const group of payload.groups) {
    const key = `${group.segment_key}|${group.day_type}|${group.time_bin}`;
    if (!group.segment_key || keys.has(key) || !Array.isArray(group.samples)) throw Error(`Invalid/duplicate group: ${date}`);
    keys.add(key);
    for (const s of group.samples) if (!Array.isArray(s) || !Number.isFinite(s[0]) || !Number.isFinite(s[1])) throw Error(`Invalid sample: ${date}`);
  }
  return payload;
}

export async function archiveDaily(root, date, bytes, client = null) {
  const payload = validateDaily(JSON.parse(bytes), date);
  const hash = sha256(bytes), key = `history-v1/daily/${date}/${hash}.json.gz`;
  const indexPath = path.join(root, 'index.json');
  const index = await readJson(indexPath, { version: 1, kind: 'daily-observations', dates: {} });
  if (client?.identity) {
    if (index.remote_identity && JSON.stringify(index.remote_identity) !== JSON.stringify(client.identity)) throw Error('History belongs to a different Cloudflare source');
    index.remote_identity = client.identity;
  }
  const compressed = gzipSync(bytes);
  const local = path.join(root, key);
  await fs.mkdir(path.dirname(local), { recursive: true });
  // Content addressed: never replace an existing version with different bytes.
  try { await fs.writeFile(local, compressed, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stored = await fs.readFile(local);
  if (sha256(gunzipSync(stored)) !== hash) throw Error(`Local archive corrupt: ${date}`);
  const previous = index.dates[date];
  if (client && (previous?.sha256 !== hash || !previous?.remote_verified)) {
    await client.putVerified(key, stored);
    await client.putVerified(`history-v1/daily/${date}/latest.json`, Buffer.from(JSON.stringify({ version: 1, date, key, sha256: hash })));
  }
  index.dates[date] = {
    key, sha256: hash, bytes: bytes.length, compressed_bytes: stored.length,
    groups: payload.groups.length, source_keys: payload.source_keys || [],
    remote_verified: Boolean(client || (previous?.sha256 === hash && previous.remote_verified)),
    archived_at: new Date().toISOString(),
  };
  await atomicJson(indexPath, index);
  return index.dates[date];
}

export async function archiveDirectory(input, root, client = null) {
  return withDirectoryLock(root, async () => {
    let count = 0;
    for (const name of (await fs.readdir(input)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
      await archiveDaily(root, name.slice(0, 10), await fs.readFile(path.join(input, name)), client);
      count++;
    }
    return { archived_dates: count, remote: Boolean(client) };
  });
}

export async function backfillHistory(root, client, limit = 3) {
  return withDirectoryLock(root, async () => {
    const index = await readJson(path.join(root, 'index.json'), { dates: {} });
    const objects = (await client.list('daily-v2/')).filter(x => /^daily-v2\/\d{4}-\d{2}-\d{2}\.json$/.test(x.key));
    const pending = objects.filter(x => !index.dates[x.key.slice(9, 19)]).sort((a, b) => a.key.localeCompare(b.key));
    let done = 0;
    for (const object of pending.slice(0, limit)) {
      await archiveDaily(root, object.key.slice(9, 19), await client.get(object.key), client);
      done++;
    }
    return { backfilled: done, remaining: pending.length - done };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, input, root] = process.argv.slice(2);
  if (!['local', 'remote', 'backfill'].includes(mode) || !input || !root) throw Error('Usage: archive_phase11_history.mjs local|remote INPUT_DIR ARCHIVE_ROOT; backfill MAX_DATES ARCHIVE_ROOT');
  const client = mode === 'local' ? null : await cloudflareClient();
  if (mode === 'backfill' && (!Number.isInteger(Number(input)) || Number(input) < 1 || Number(input) > 28)) throw Error('Backfill limit must be 1..28');
  console.log(JSON.stringify(mode === 'backfill' ? await backfillHistory(root, client, Number(input)) : await archiveDirectory(input, root, client)));
}
