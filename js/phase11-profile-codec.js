// A lossless, generation-independent representation. No rounding or averaging.
export const PACKED_PROFILE_FORMAT = 'phase11-profile-shards-v2';
export const MAX_PACKED_BYTES = 2 * 1024 * 1024;
export const MAX_DECODED_BYTES = 8 * 1024 * 1024;

export function packProfilePayload(payload, kind, generatedAt) {
  if (!['profiles', 'weather_profiles'].includes(kind) || payload?.version !== 1
    || payload.generated_at !== generatedAt || !Array.isArray(payload[kind])
    || Object.keys(payload).join('|') !== `version|generated_at|${kind}`) throw Error('Unsupported profile payload');
  const columns = Object.keys(payload[kind][0] || {});
  const rows = payload[kind].map(row => {
    if (Object.keys(row).join('|') !== columns.join('|') || row.generated_at !== generatedAt) throw Error('Mixed profile metadata or columns');
    return columns.filter(k => k !== 'generated_at').map(k => row[k]);
  });
  const packed = { version: 2, kind, columns, rows };
  validatePackedPayload(packed, kind, rows.length);
  return packed;
}

export function validatePackedPayload(payload, kind, count) {
  if (!['profiles', 'weather_profiles'].includes(kind) || payload?.version !== 2 || payload.kind !== kind || !Array.isArray(payload.columns)
    || payload.columns.length > 32 || !Number.isInteger(count) || count < 0
    || payload.columns.some(k => typeof k !== 'string' || !/^[a-z][a-z0-9_]*$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k))
    || new Set(payload.columns).size !== payload.columns.length || (count > 0 && !payload.columns.includes('generated_at'))
    || (count > 0 && kind === 'profiles' && !payload.columns.includes('segment_key'))
    || !Array.isArray(payload.rows) || payload.rows.length !== count || count > 50000
    || payload.rows.some(row => !Array.isArray(row) || row.length !== payload.columns.length - 1)) throw Error('Invalid packed profile payload');
}

export function unpackProfileRows(packed, generatedAt, wanted = null) {
  const keyIndex = packed.columns.filter(k => k !== 'generated_at').indexOf('segment_key');
  const rows = wanted ? packed.rows.filter(row => wanted.has(row[keyIndex])) : packed.rows;
  return rows.map(row => {
    let i = 0;
    return Object.fromEntries(packed.columns.map(k => [k, k === 'generated_at' ? generatedAt : row[i++]]));
  });
}

export function unpackProfilePayload(packed, generatedAt) {
  validatePackedPayload(packed, packed.kind, packed.rows?.length);
  return { version: 1, generated_at: generatedAt, [packed.kind]: unpackProfileRows(packed, generatedAt) };
}

export function validatePackedStorage(storage) {
  const identity = storage?.encoding === 'identity';
  if ((!identity && storage?.encoding !== 'gzip') || !/^[a-f0-9]{64}$/.test(storage.sha256 || '')
    || storage.key !== (identity ? `blobs/json/${storage.sha256}.json` : `blobs/gzip/${storage.sha256}.json.gz`)
    || !Number.isInteger(storage.bytes) || storage.bytes < 1 || storage.bytes > (identity ? MAX_DECODED_BYTES : MAX_PACKED_BYTES)
    || (identity && storage.bytes !== storage.decoded_bytes)
    || !Number.isInteger(storage.decoded_bytes) || storage.decoded_bytes < 1 || storage.decoded_bytes > MAX_DECODED_BYTES) throw Error('Invalid packed profile storage');
}
