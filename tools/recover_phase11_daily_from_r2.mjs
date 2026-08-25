#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { buildCompactDailyGroups } from "../worker/worker.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "280d634e84421957ce4f72c88ae47051";
const BUCKET = process.env.PHASE11_R2_BUCKET || "tobus-phase11-events";
const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const dateKey = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) {
  throw new Error("usage: recover_phase11_daily_from_r2.mjs YYYY-MM-DD");
}

const configCandidates = [
  path.join(os.homedir(), ".wrangler/config/default.toml"),
  path.join(os.homedir(), ".config/.wrangler/config/default.toml"),
];

async function oauthToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  for (const candidate of configCandidates) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      if (token) return token;
    } catch {}
  }
  throw new Error("Wrangler OAuth token not found");
}

const token = await oauthToken();

async function api(url, options = {}, allowMissing = false) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare R2 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function listObjects(prefix) {
  const objects = [];
  let cursor = "";
  do {
    const url = new URL(API_BASE);
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await (await api(url)).json();
    objects.push(...(payload.result || []));
    cursor = payload.result_info?.is_truncated ? payload.result_info.cursor : "";
  } while (cursor);
  return objects;
}

function utcDateParts(timestampMs) {
  const date = new Date(timestampMs);
  return {
    date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
  };
}

function objectTokyoDate(key) {
  const match = /^(?:events|hourly)\/(\d{4}-\d{2}-\d{2})\/(\d{2})/.exec(key);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T${match[2]}:00:00Z`);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timestamp));
}

async function readJsonObject(key) {
  const response = await api(`${API_BASE}/${key}`, {}, true);
  return response ? { key, payload: await response.json() } : null;
}

const startMs = Date.parse(`${dateKey}T00:00:00+09:00`);
const utcDates = [...new Set([
  utcDateParts(startMs).date,
  utcDateParts(startMs + 86_400_000 - 1).date,
])];
const listed = (await Promise.all(utcDates.flatMap((utcDate) => [
  listObjects(`events/${utcDate}/`),
  listObjects(`hourly/${utcDate}/`),
]))).flat().filter((object) => objectTokyoDate(object.key) === dateKey);
if (!listed.length) throw new Error(`${dateKey}: recoverable events/hourly objects not found`);

const dailyKey = `daily-v2/${dateKey}.json`;
if (await api(`${API_BASE}/${dailyKey}`, {}, true)) {
  throw new Error(`${dailyKey} already exists; refusing to overwrite`);
}

const payloads = [];
for (let index = 0; index < listed.length; index += 16) {
  const batch = (await Promise.all(listed.slice(index, index + 16).map((object) => readJsonObject(object.key)))).filter(Boolean);
  payloads.push(...batch);
  process.stderr.write(`\rdownloaded ${payloads.length}/${listed.length}`);
}
process.stderr.write("\n");

const events = [];
for (const { payload } of payloads) events.push(...(payload.events || []));
const uniqueEvents = [...new Map(events.map((event) => [event.event_id || JSON.stringify(event), event])).values()];
const daily = {
  version: 2,
  generated_at: new Date().toISOString(),
  date_key: dateKey,
  source_keys: payloads.map((item) => item.key).sort(),
  groups: buildCompactDailyGroups(uniqueEvents),
};
const sampleCount = daily.groups.reduce((sum, group) => sum + (group.samples || []).length, 0);
if (!daily.groups.length || !sampleCount) throw new Error(`${dateKey}: generated daily object is empty`);

await api(`${API_BASE}/${dailyKey}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(daily),
});
const verified = await (await api(`${API_BASE}/${dailyKey}`)).json();
const verifiedSamples = (verified.groups || []).reduce((sum, group) => sum + (group.samples || []).length, 0);
if (verified.date_key !== dateKey || verifiedSamples !== sampleCount) {
  throw new Error(`${dateKey}: uploaded daily object verification failed`);
}
console.log(JSON.stringify({
  dateKey,
  sourceObjects: payloads.length,
  uniqueEvents: uniqueEvents.length,
  groups: daily.groups.length,
  samples: sampleCount,
  dailyKey,
}));
