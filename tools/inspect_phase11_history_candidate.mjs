import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readJson, atomicJson, sha256 } from './phase11-storage.mjs';
import { validateDaily } from './archive_phase11_history.mjs';
import { buildHistoryProfiles } from './phase11-history-model.js';

// Offline per-segment diagnostics: avoids loading years of whole-fleet data into RAM.
const [root, segment, asOf, output] = process.argv.slice(2);
if (!root || !segment || !Number.isFinite(Date.parse(asOf)) || !output) throw Error('Usage: inspect_phase11_history_candidate.mjs ARCHIVE_ROOT SEGMENT_KEY AS_OF_ISO OUTPUT_JSON');
const index = await readJson(path.join(root, 'index.json'));
const payloads = [];
for (const [date, entry] of Object.entries(index.dates).sort()) {
  if (Date.parse(date + 'T00:00:00+09:00') >= Date.parse(asOf)) continue;
  if (!/^history-v1\/daily\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json.gz$/.test(entry.key)) throw Error('Unsafe archive index path');
  const raw = gunzipSync(await fs.readFile(path.join(root, entry.key)));
  if (sha256(raw) !== entry.sha256) throw Error(`Archive hash mismatch: ${date}`);
  const p = validateDaily(JSON.parse(raw), date);
  payloads.push({ ...p, groups: p.groups.filter(g => g.segment_key === segment) });
}
const result = buildHistoryProfiles(payloads, Date.parse(asOf));
await atomicJson(path.resolve(output), { version: 1, candidate_only: true, as_of: asOf, ...result });
console.log(JSON.stringify({ source_dates: payloads.length, profiles: result.profiles.length, candidate_only: true }));
