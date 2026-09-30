// Offline only. Original protobufs are never rewritten or uploaded.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodeGtfsRealtime } from '../js/realtime.js';

export class ArrivalLabels {
  constructor() { this.states = new Map(); this.rows = []; this.audit = { stale: 0, reset: 0, explicit_stop: 0 }; }
  push(feed, available) {
    for (const v of feed.vehicles) {
      const id = v.vehicle?.id || v.entityId, trip = v.trip?.tripId;
      const t = Number(v.timestamp) * 1000, seq = v.currentStopSequence;
      if (!id || !trip || !v.stopId || !Number.isInteger(seq) || !Number.isFinite(t)) continue;
      if (v.hasCurrentStatus && v.currentStatus === 1) this.audit.explicit_stop++;
      if (t > available || available - t > 120000) { this.audit.stale++; this.states.delete(id); continue; }
      const route = v.trip?.routeId || '', direction = v.trip?.directionId ?? '';
      const old = this.states.get(id);
      const point = { t, available };
      const current = { trip, route, direction, seq, stop: v.stopId, first: t, last: t,
        available, points: [point], anchored: false };
      if (!old || old.trip !== trip || old.route !== route || old.direction !== direction
          || available - old.available > 120000 || t - old.last > 120000 || t < old.last) {
        this.states.set(id, current); this.audit.reset++; continue;
      }
      if (t === old.last) continue; // repeated feed cannot add evidence or refresh age
      if (v.stopId === old.stop && seq === old.seq) {
        old.last = t; old.available = available; old.points.push(point); continue;
      }
      if (seq === old.seq + 1 && v.stopId !== old.stop) {
        const seconds = (t - old.first) / 1000;
        if (old.anchored && seconds >= 15 && seconds <= 1800) {
          this.rows.push({ version: 2, provenance: 'observed', target: 'next_stop_first_observed',
            route, direction, from_sequence: old.seq, from_stop: old.stop, to_stop: v.stopId,
            segment: JSON.stringify([route, direction, old.seq, old.stop, v.stopId]),
            started_at: old.first, ended_at: t, known_at: available,
            crossing_lower: old.last, crossing_upper: t, seconds,
            queries: old.points.filter(p => p.available < t && t - p.available >= 15000)
              .filter((_, i) => i % 2 === 0).slice(0, 12) });
        }
        current.anchored = true;
      } else this.audit.reset++;
      this.states.set(id, current);
    }
    for (const [id, s] of this.states) if (available - s.available > 120000) this.states.delete(id);
  }
}

async function walk(root) {
  const files = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) files.push(...await walk(p));
    else if (e.name.endsWith('.pb.gz')) files.push(p);
  }
  return files.sort();
}
export async function build(root, output, from, through) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through) || from > through) throw Error('Invalid date range');
  // Exclusive output creation: never overwrite a prior experiment.
  const out = await fs.open(output, 'wx');
  try {
    const labels = new ArrivalLabels(), inputs = [];
    for (const file of await walk(root)) {
      const rel = path.relative(root, file).replaceAll(path.sep, '/');
      const m = /^(\d{4}-\d{2}-\d{2})\/(\d{2})\/(\d{2})\.pb\.gz$/.exec(rel);
      if (!m) continue;
      const minute = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
      const day = new Date(minute + 9 * 3600000).toISOString().slice(0, 10);
      if (day < from || day > through) continue;
      const bytes = gunzipSync(await fs.readFile(file));
      const feed = decodeGtfsRealtime(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      // Historical capture metadata is not local: this is a replay clock, NOT proven receive time.
      labels.push(feed, Math.max(minute + 60000, Number(feed.timestamp) * 1000));
      inputs.push({ key: rel, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const data = { version: 2, candidate_only: true, target: 'next_stop_first_observed',
      receive_time: 'replay-clock-not-live-receipt', range: [from, through], inputs,
      audit: labels.audit, segments: labels.rows };
    await out.writeFile(JSON.stringify(data));
    console.log(JSON.stringify({ files: inputs.length, segments: labels.rows.length, audit: labels.audit }));
  } finally { await out.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, output, from, through] = process.argv.slice(2);
  if (!through) throw Error('Usage: node build_phase11_arrival_dataset.mjs RAW_ROOT OUTPUT_JSON FROM_JST THROUGH_JST');
  await build(root, output, from, through);
}
