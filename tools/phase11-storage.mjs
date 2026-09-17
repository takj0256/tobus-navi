import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file);
}
export async function withDirectoryLock(root, fn) {
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, '.writer-lock');
  try { await fs.mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw Error(`Writer lock exists: ${lock}; inspect processes before recovery`); throw error; }
  try { return await fn(); } finally { await fs.rmdir(lock); }
}
export async function cloudflareClient() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  for (const name of ['.wrangler/config/default.toml', '.config/.wrangler/config/default.toml']) {
    if (token) break;
    try { token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(await fs.readFile(path.join(os.homedir(), name), 'utf8'))?.[1]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!token) throw Error('Cloudflare credentials unavailable; run wrangler whoami first');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '280d634e84421957ce4f72c88ae47051';
  const bucket = process.env.PHASE11_R2_BUCKET || 'tobus-phase11-events';
  const database = process.env.PHASE11_D1_DATABASE_ID || '6888b506-2f45-4913-849e-57d9aff6c3a1';
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function request(suffix, init = {}, retry = true) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(base + suffix, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(120000) });
        if (!response.ok) {
          const error = Error(`Cloudflare HTTP ${response.status}: ${init.method || 'GET'} ${suffix}`);
          error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
          await response.arrayBuffer();
          throw error;
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (!retry || error.retryable === false || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
  const objectRoot = `/r2/buckets/${bucket}/objects`;
  let retentionChecked = false;
  return {
    identity: { account, bucket, database },
    get: key => request(`${objectRoot}/${key}`),
    async list(prefix) {
      const entries = [];
      let cursor;
      do {
        const q = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) });
        const result = JSON.parse(await request(`${objectRoot}?${q}`));
        if (!result.success || !Array.isArray(result.result)) throw Error('Invalid R2 listing');
        entries.push(...result.result);
        cursor = result.result_info?.cursor;
      } while (cursor);
      return entries;
    },
    async putVerified(key, data) {
      if (!key.startsWith('history-v1/') && !key.startsWith('legacy-d1-v1/')) throw Error('Archive write prefix denied');
      if (!retentionChecked) {
        const lifecycle = await this.lifecycle();
        if (!lifecycle.success || !Array.isArray(lifecycle.result?.rules)) throw Error('Cannot verify archive retention');
        if (lifecycle.result.rules.some(r => r.enabled && r.deleteObjectsTransition && ['history-v1/', 'legacy-d1-v1/'].some(prefix => prefix.startsWith(r.conditions?.prefix || '') || String(r.conditions?.prefix || '').startsWith(prefix)))) throw Error('R2 expiration rule overlaps long-term archive');
        retentionChecked = true;
      }
      await request(`${objectRoot}/${key}`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
      if (sha256(await this.get(key)) !== sha256(data)) throw Error(`R2 verification mismatch: ${key}`);
    },
    async lifecycle() { return JSON.parse(await request(`/r2/buckets/${bucket}/lifecycle`)); },
    async query(sql, params = []) {
      if (!/^\s*(SELECT|EXPLAIN QUERY PLAN|PRAGMA table_info)\b/i.test(sql)) throw Error('Only diagnostic/read SQL allowed');
      // No automatic retries: a timed-out query may already have consumed its budget.
      const result = JSON.parse(await request(`/d1/database/${database}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) }, false));
      if (!result.success || !result.result?.every(item => item.success)) throw Error('D1 read failed');
      return result.result;
    },
  };
}
