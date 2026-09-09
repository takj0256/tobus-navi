#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildLocalProfiles } from "./phase11-local-model.js";

const [inputDir, outputDir] = process.argv.slice(2);
if (!inputDir || !outputDir) {
  console.error("Usage: node tools/aggregate_phase11_json.mjs INPUT_DIR OUTPUT_DIR");
  process.exit(2);
}

const files = (await readdir(inputDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
if (!files.length) throw new Error("集計できるdaily-v2 JSONがありません");
const payloads = [];
for (const file of files) payloads.push(JSON.parse(await readFile(resolve(inputDir, file), "utf8")));

const generatedAt = new Date();
const result = buildLocalProfiles(payloads, generatedAt.getTime());
if (!result.profiles.length) throw new Error("プロファイルが0件のためJSONを生成できません");

const generation = generatedAt.toISOString().replaceAll(":", "-");
const generationDir = resolve(outputDir, "generations", generation);
await mkdir(resolve(generationDir, "profiles"), { recursive: true });

const groups = new Map();
for (const profile of result.profiles) {
  const key = `${profile.day_type}/${String(profile.time_bin).replaceAll(":", "")}`;
  const rows = groups.get(key) || [];
  rows.push(profile);
  groups.set(key, rows);
}

const shards = [];
for (const [key, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  rows.sort((left, right) => left.segment_key.localeCompare(right.segment_key));
  const relativePath = `profiles/${key}.json`;
  const payload = JSON.stringify({ version: 1, generated_at: generatedAt.toISOString(), profiles: rows });
  await mkdir(resolve(generationDir, "profiles", key.split("/")[0]), { recursive: true });
  await writeFile(resolve(generationDir, relativePath), payload);
  shards.push({
    day_type: rows[0].day_type,
    time_bin: rows[0].time_bin,
    path: relativePath,
    count: rows.length,
    bytes: Buffer.byteLength(payload),
    sha256: createHash("sha256").update(payload).digest("hex"),
  });
}

result.weatherProfiles.sort((left, right) => [left.scope, left.route_id, left.direction_id, left.weather_class, left.temperature_band]
  .join("|").localeCompare([right.scope, right.route_id, right.direction_id, right.weather_class, right.temperature_band].join("|")));
const weatherPayload = JSON.stringify({ version: 1, generated_at: generatedAt.toISOString(), weather_profiles: result.weatherProfiles });
await writeFile(resolve(generationDir, "weather-profiles.json"), weatherPayload);

const manifest = {
  version: 1,
  format: "phase11-profile-shards",
  generation,
  generated_at: generatedAt.toISOString(),
  source_objects: result.sourceObjects,
  source_dates: files.map((file) => basename(file, ".json")),
  profiles: summarize(result.profiles),
  weather_profiles: summarize(result.weatherProfiles),
  shards,
  weather: {
    path: "weather-profiles.json",
    count: result.weatherProfiles.length,
    bytes: Buffer.byteLength(weatherPayload),
    sha256: createHash("sha256").update(weatherPayload).digest("hex"),
  },
};
const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(resolve(generationDir, "manifest.json"), manifestPayload);
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "current.json"), manifestPayload);
console.log(JSON.stringify({ outputDir: generationDir, ...manifest }, null, 2));

function summarize(rows) {
  const confidences = rows.map((row) => Number(row.confidence)).filter(Number.isFinite);
  const samples = rows.map((row) => Number(row.sample_count)).filter(Number.isFinite);
  return {
    count: rows.length,
    average_confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
    maximum_confidence: confidences.length ? confidences.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
    maximum_sample_count: samples.length ? samples.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
  };
}
