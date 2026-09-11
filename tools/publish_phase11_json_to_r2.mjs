#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_ACCOUNT_ID = "280d634e84421957ce4f72c88ae47051";
const DEFAULT_BUCKET = "tobus-phase11-events";
const DEFAULT_PREFIX = "profiles-v1";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function publishPhase11Json(outputDir, options = {}) {
  const token = options.token || await oauthToken();
  const bucket = options.bucket || process.env.PHASE11_R2_BUCKET || DEFAULT_BUCKET;
  const prefix = normalizePrefix(options.prefix || process.env.PHASE11_PROFILE_PREFIX || DEFAULT_PREFIX);
  const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const apiBase = options.apiBase || process.env.PHASE11_R2_API_BASE
    || `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
  const concurrency = integerOption(options.concurrency ?? process.env.PHASE11_R2_CONCURRENCY, 3, 1, 12);
  const requestPolicy = {
    attempts: integerOption(options.retryAttempts, 8, 1, 12),
    baseDelayMs: integerOption(options.retryBaseDelayMs, 1000, 1, 30_000),
    timeoutMs: integerOption(options.requestTimeoutMs, 120_000, 1000, 600_000),
  };
  const currentPayload = await fs.readFile(path.resolve(outputDir, "current.json"));
  const manifest = JSON.parse(currentPayload.toString("utf8"));
  if (manifest.format !== "phase11-profile-shards" || !manifest.generation) {
    throw new Error("current.json is not a Phase 11 profile manifest");
  }

  const generationDir = path.resolve(outputDir, "generations", manifest.generation);
  const objects = [
    ...manifest.shards.map((shard) => ({ relativePath: shard.path, bytes: shard.bytes, sha256: shard.sha256 })),
    { relativePath: manifest.weather.path, bytes: manifest.weather.bytes, sha256: manifest.weather.sha256 },
  ];
  for (const object of objects) await validateLocalObject(generationDir, object);

  const generationPrefix = `${prefix}/generations/${manifest.generation}`;
  let uploaded = 0;
  await mapConcurrent(objects, concurrency, async (object) => {
    const payload = await fs.readFile(safeResolve(generationDir, object.relativePath));
    await putObject(apiBase, `${generationPrefix}/${object.relativePath}`, payload, token, requestPolicy);
    uploaded += 1;
    if (uploaded % 20 === 0 || uploaded === objects.length) {
      process.stderr.write(`uploaded ${uploaded}/${objects.length} profile objects\n`);
    }
  });

  const generationManifestPayload = await fs.readFile(safeResolve(generationDir, "manifest.json"));
  await putObject(apiBase, `${generationPrefix}/manifest.json`, generationManifestPayload, token, requestPolicy);
  await verifyObject(apiBase, `${generationPrefix}/manifest.json`, generationManifestPayload, token, requestPolicy);

  // current.json is the atomic publication pointer and must always be written last.
  await putObject(apiBase, `${prefix}/current.json`, currentPayload, token, requestPolicy);
  await verifyObject(apiBase, `${prefix}/current.json`, currentPayload, token, requestPolicy);
  return {
    bucket,
    prefix,
    generation: manifest.generation,
    sourceObjects: manifest.source_objects,
    profiles: manifest.profiles.count,
    weatherProfiles: manifest.weather_profiles.count,
    uploadedObjects: objects.length + 2,
  };
}

async function oauthToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    path.join(os.homedir(), ".wrangler/config/default.toml"),
    path.join(os.homedir(), ".config/.wrangler/config/default.toml"),
  ];
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      if (token) return token;
    } catch {}
  }
  throw new Error("Wrangler OAuth token not found");
}

async function validateLocalObject(generationDir, object) {
  const payload = await fs.readFile(safeResolve(generationDir, object.relativePath));
  if (payload.length !== object.bytes) throw new Error(`${object.relativePath}: byte length mismatch`);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  if (sha256 !== object.sha256) throw new Error(`${object.relativePath}: SHA-256 mismatch`);
}

function safeResolve(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe manifest path: ${relativePath}`);
  }
  return resolved;
}

function normalizePrefix(prefix) {
  const normalized = String(prefix).replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) throw new Error(`invalid R2 prefix: ${prefix}`);
  return normalized;
}

function integerOption(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`invalid numeric option: ${value}`);
  }
  return parsed;
}

async function putObject(apiBase, key, payload, token, requestPolicy) {
  await fetchWithRetry(`${apiBase}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload,
  }, `R2 PUT ${key}`, requestPolicy);
}

async function verifyObject(apiBase, key, expected, token, requestPolicy) {
  const response = await fetchWithRetry(`${apiBase}/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, `R2 GET ${key}`, requestPolicy);
  const actual = Buffer.from(await response.arrayBuffer());
  if (!actual.equals(expected)) throw new Error(`R2 verification failed for ${key}`);
}

async function fetchWithRetry(url, init, label, policy) {
  let lastError;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 300);
      const error = new Error(`${label} failed with HTTP ${response.status}: ${body}`);
      error.retryable = RETRYABLE_STATUS.has(response.status);
      if (!error.retryable || attempt === policy.attempts) throw error;
      lastError = error;
    } catch (error) {
      if (error.retryable === false || attempt === policy.attempts) {
        throw new Error(`${label} failed after ${attempt} attempt(s): ${error.message}`, { cause: error });
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    const delayMs = Math.min(policy.baseDelayMs * (2 ** (attempt - 1)), 30_000);
    process.stderr.write(`${label}: retry ${attempt + 1}/${policy.attempts} in ${delayMs}ms (${lastError.message})\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await operation(items[index]);
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error("Usage: node tools/publish_phase11_json_to_r2.mjs OUTPUT_DIR");
    process.exit(2);
  }
  console.log(JSON.stringify(await publishPhase11Json(outputDir), null, 2));
}
