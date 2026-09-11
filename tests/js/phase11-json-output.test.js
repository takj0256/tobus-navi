import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { publishPhase11Json } from "../../tools/publish_phase11_json_to_r2.mjs";

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

test("Phase 11 JSON publication validates objects and switches current last", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "phase11-publish-"));
  const input = join(root, "daily-v2");
  const output = join(root, "profiles-json");
  await mkdir(input);
  await writeFile(join(input, "2026-09-09.json"), JSON.stringify({
    version: 2,
    date_key: "2026-09-09",
    groups: [{
      segment_key: "006|0|a>b", route_id: "006", direction_id: 0,
      from_stop_id: "a", to_stop_id: "b", day_type: "weekday", time_bin: "08:00",
      samples: [[100, Date.now() - 1000], [120, Date.now() - 2000], [140, Date.now() - 3000]],
    }],
  }));
  const generated = spawnSync(process.execPath, [resolve("tools/aggregate_phase11_json.mjs"), input, output], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);

  const stored = new Map();
  const writes = [];
  let transientFailures = 1;
  let permanentFailure = false;
  let requestCount = 0;
  const server = http.createServer(async (request, response) => {
    const key = request.url.slice(1);
    if (request.method === "PUT") {
      requestCount += 1;
      if (permanentFailure) {
        response.writeHead(401).end("not authorized");
        return;
      }
      if (transientFailures > 0) {
        transientFailures -= 1;
        response.writeHead(503).end("temporary failure");
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stored.set(key, Buffer.concat(chunks));
      writes.push(key);
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET" && stored.has(key)) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(stored.get(key));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const address = server.address();
  const result = await publishPhase11Json(output, {
    token: "test-token", bucket: "test-bucket", prefix: "profiles-v1",
    apiBase: `http://127.0.0.1:${address.port}`,
    concurrency: 1,
    retryBaseDelayMs: 1,
  });

  assert.equal(result.sourceObjects, 1);
  assert.equal(result.profiles, 1);
  assert.equal(writes.at(-1), "profiles-v1/current.json");
  assert.ok(writes.at(-2).endsWith("/manifest.json"));
  assert.equal(writes.some((key) => key.includes("profiles-v1/generations/")), true);
  assert.equal(requestCount, writes.length + 1);

  permanentFailure = true;
  const requestsBeforeUnauthorized = requestCount;
  await assert.rejects(publishPhase11Json(output, {
    token: "test-token", bucket: "test-bucket", prefix: "profiles-v2",
    apiBase: `http://127.0.0.1:${address.port}`,
    concurrency: 1,
    retryBaseDelayMs: 1,
  }), /401/);
  assert.equal(requestCount, requestsBeforeUnauthorized + 1);
});

test("scheduled Phase 11 runner has no D1 write path", async () => {
  const script = await readFile(resolve("tools/run_phase11_local_aggregation.sh"), "utf8");
  assert.doesNotMatch(script, /d1 execute|aggregate_phase11_local\.mjs|profiles\.sql/);
  assert.match(script, /aggregate_phase11_json\.mjs/);
  assert.match(script, /publish_phase11_json_to_r2\.mjs/);
});
