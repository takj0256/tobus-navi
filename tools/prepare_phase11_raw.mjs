// Local provisioning only. Never print secret values or store them in the repo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cloudflareClient, atomicJson } from './phase11-storage.mjs';

const [rootArg, workerUrl] = process.argv.slice(2);
if (!rootArg || !workerUrl) throw Error('usage: prepare_phase11_raw.mjs EXTERNAL_PROCESSOR_ROOT WORKER_URL');
const root = path.resolve(rootArg);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
if (root === repo || root.startsWith(repo + '/')) throw Error('Secrets must be outside the repository');
if (!/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(workerUrl)) throw Error('Expected HTTPS workers.dev URL');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const configFile = path.join(root, 'config.json');
try { await fs.access(configFile); throw Error('Processor already configured; inspect before changing'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const client = await cloudflareClient();
const objects = await client.list('');
if (objects.some(o => o.key.startsWith('raw-v1/'))) throw Error('Raw namespace already in use; inspect before initial cutover');
const used = objects.reduce((n, o) => n + Number(o.size), 0);
if (used + 512 * 1024 * 1440 * 3 > 8e9) throw Error('Insufficient storage headroom for bounded raw buffer');
await atomicJson(path.join(root, 'lifecycle-before.json'), await client.lifecycle());
const legacy = await client.get('state/latest.json');
await fs.writeFile(path.join(root, 'legacy-state-before.json'), legacy, { flag: 'wx', mode: 0o600 });
// Activate after the first actual Cron capture: avoids claiming uncaptured startup minutes.
const token = randomBytes(32).toString('hex');
await fs.writeFile(path.join(root, 'pending-config.json'), JSON.stringify({ worker_url: workerUrl, processor_token: token }), { flag: 'wx', mode: 0o600 });
await fs.writeFile(path.join(root, 'worker-secrets.json'), JSON.stringify({ PHASE11_PROCESSOR_TOKEN: token }), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ prepared: true, storage_bytes: used, raw_buffer_max_bytes: 512 * 1024 * 1440 * 3 }));
