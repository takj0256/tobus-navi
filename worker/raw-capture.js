// Raw capture only: no decoding, D1, weather, or historical backfill.
const MAX_BYTES = 512 * 1024;
const RETRY_HTTP = new Set([408, 429, 500, 502, 503, 504]);
class CaptureError extends Error {}

function failure(stage, code, retryable = false, status) {
  return Object.assign(new CaptureError(`Raw capture ${stage}: ${code}${status ? ` HTTP ${status}` : ''}`),
    { stage, code, retryable, status });
}

export async function captureWithPolicy({ bucket, source, scheduledAt, fetchImpl, runtime = {} }) {
  const clock = runtime.clock || Date.now;
  const sleep = runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = runtime.log || (entry => console.log(entry));
  // Runtime overrides are for local deterministic tests, not environment settings.
  const attemptMs = runtime.attemptMs ?? 8000;
  const budgetMs = runtime.budgetMs ?? 20000;
  const started = clock(), deadline = started + budgetMs;
  const minute = new Date(Math.floor(scheduledAt.getTime() / 60000) * 60000).toISOString();
  const key = `raw-v1/${minute.slice(0, 10)}/${minute.slice(11, 13)}/${minute.slice(14, 16)}.pb`;
  const emit = data => log({ phase11_raw: true, key, scheduled_at: scheduledAt.toISOString(),
    elapsed_ms: Math.max(0, clock() - started), ...data });
  let bytes, attempt, lastError;
  for (attempt = 1; attempt <= 2; attempt++) {
    try {
      const remaining = deadline - clock();
      if (remaining <= 0) throw failure('fetch', 'budget_exhausted');
      bytes = await readAttempt(fetchImpl, source, Math.min(attemptMs, remaining));
      if (clock() > deadline) throw failure('body', 'budget_exhausted');
      break;
    } catch (error) {
      lastError = error;
      const delay = Math.max(500, error.retryAfterMs || 0);
      const retry = error.retryable === true && attempt < 2 && clock() + delay < deadline;
      emit({ outcome: retry ? 'retry' : 'failed', stage: error.stage, code: error.code,
        attempt, http_status: error.status ?? null });
      if (!retry) throw error;
      await sleep(delay);
    }
  }
  const capturedAt = new Date(clock()).toISOString();
  const saveStarted = clock();
  let saved;
  try {
    // Never repeat an uncertain PUT or replace the first delivery for this key.
    saved = await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/x-protobuf' },
      customMetadata: { scheduled_at: scheduledAt.toISOString(), captured_at: capturedAt,
        format: 'gtfs-rt-v1', capture_attempts: String(attempt),
        ...(lastError ? { recovered_stage: lastError.stage, recovered_code: lastError.code } : {}) },
    });
  } catch {
    emit({ outcome: 'failed', stage: 'storage', code: 'put_failed', attempt,
      bytes: bytes.byteLength, storage_ms: Math.max(0, clock() - saveStarted) });
    throw failure('storage', 'put_failed');
  }
  emit({ outcome: saved === null ? 'duplicate' : 'saved', stage: 'storage', attempt,
    bytes: bytes.byteLength, captured_at: capturedAt, duplicate: saved === null,
    storage_ms: Math.max(0, clock() - saveStarted) });
  return { enabled: true, raw: true, key, bytes: bytes.byteLength, duplicate: saved === null, attempts: attempt };
}

async function readAttempt(fetchImpl, source, timeoutMs) {
  const controller = new AbortController();
  let stage = 'fetch', response, reader, stopped = false, timer;
  const cancel = () => {
    controller.abort();
    // Cleanup must not delay the timeout or mask the original error.
    try { const p = reader ? reader.cancel() : response?.body?.cancel(); p?.catch(() => {}); } catch {}
  };
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { stopped = true; reject(failure(stage, 'timeout', true)); cancel(); }, timeoutMs);
  });
  const operation = (async () => {
    try {
      response = await fetchImpl(source, { signal: controller.signal, cache: 'no-store' });
      if (stopped) { cancel(); throw failure('fetch', 'timeout', true); }
      if (!response.ok) {
        const error = failure('http', 'upstream_http', RETRY_HTTP.has(response.status), response.status);
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          error.retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : Infinity;
        }
        throw error;
      }
      stage = 'body';
      // Enforce the size cap during streaming, not after allocating an unlimited body.
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_BYTES) throw failure(stage, 'size_exceeded');
      reader = response.body?.getReader();
      if (!reader) throw failure(stage, 'empty_body');
      const chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (stopped) throw failure(stage, 'timeout', true);
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) throw failure(stage, 'size_exceeded');
        chunks.push(value);
      }
      if (!length) throw failure(stage, 'empty_body');
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw failure(stage, 'network_error', true);
    }
  })();
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); cancel(); }
}
