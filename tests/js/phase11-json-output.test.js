import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("Phase 11 profiles are written as verified JSON shards", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase11-json-"));
  const input = join(root, "daily-v2");
  const output = join(root, "profiles-json");
  await mkdir(input);
  const now = Date.now();
  await writeFile(join(input, "2026-09-08.json"), JSON.stringify({
    version: 2,
    date_key: "2026-09-08",
    groups: [{
      segment_key: "006|0|a>b",
      route_id: "006",
      direction_id: 0,
      from_stop_id: "a",
      to_stop_id: "b",
      day_type: "weekday",
      time_bin: "08:00",
      samples: [[100, now - 1000], [120, now - 2000], [140, now - 3000]],
    }],
  }));

  const script = resolve("tools/aggregate_phase11_json.mjs");
  const run = spawnSync(process.execPath, [script, input, output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const manifest = JSON.parse(await readFile(join(output, "current.json"), "utf8"));
  assert.equal(manifest.format, "phase11-profile-shards");
  assert.equal(manifest.source_objects, 1);
  assert.equal(manifest.profiles.count, 1);
  assert.equal(manifest.shards.length, 1);
  const shard = JSON.parse(await readFile(join(output, "generations", manifest.generation, manifest.shards[0].path), "utf8"));
  assert.equal(shard.profiles[0].segment_key, "006|0|a>b");
  assert.equal(shard.profiles[0].median_seconds, 120);
});
