import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {PACKED_PROFILE_FORMAT,packProfilePayload,unpackProfilePayload,validatePackedStorage} from '../js/phase11-profile-codec.js';
const sha = b => createHash('sha256').update(b).digest('hex');

export async function validatePackedLocalObject(outputDir, descriptor, generatedAt, kind) {
  validatePackedStorage(descriptor.storage);
  if (descriptor.storage.encoding !== 'gzip') throw Error('Expected gzip archive');
  const b = await fs.readFile(path.join(outputDir, descriptor.storage.key));
  if (b.length !== descriptor.storage.bytes || sha(b) !== descriptor.storage.sha256) throw Error('Packed blob hash/size mismatch');
  const raw = gunzipSync(b, {maxOutputLength: descriptor.storage.decoded_bytes});
  if (raw.length !== descriptor.storage.decoded_bytes) throw Error('Packed decoded length mismatch');
  const packed = JSON.parse(raw);
  if (packed.kind !== kind || packed.rows?.length !== descriptor.count) throw Error('Packed kind/count mismatch');
  const restored = Buffer.from(JSON.stringify(unpackProfilePayload(packed, generatedAt)));
  if (restored.length !== descriptor.bytes || sha(restored) !== descriptor.sha256) throw Error('Lossless profile reconstruction failed');
  if (descriptor.read_storage) {
    validatePackedStorage(descriptor.read_storage);
    if (descriptor.read_storage.encoding !== 'identity') throw Error('Invalid read mirror encoding');
    const mirror = await fs.readFile(path.join(outputDir, descriptor.read_storage.key));
    if (mirror.length !== descriptor.read_storage.bytes || sha(mirror) !== descriptor.read_storage.sha256 || !mirror.equals(raw)) throw Error('Read mirror differs from verified archive');
  }
  return b;
}

export async function packProfileGeneration(inputDir, outputDir) {
  const m = JSON.parse(await fs.readFile(path.join(inputDir, 'current.json')));
  if (m.version !== 1 || m.format !== 'phase11-profile-shards' || typeof m.generation !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.generation) || !Number.isFinite(Date.parse(m.generated_at || ''))) throw Error('Expected legacy generation');
  const generation = m.generation + '-packed-v2-hot';
  let sourceBytes = 0, storedBytes = 0, readBytes = 0;
  async function convert(d, kind) {
    if (!(kind === 'profiles' ? /^profiles\/(weekday|saturday|holiday)\/\d{4}\.json$/.test(d.path) : d.path === 'weather-profiles.json')) throw Error('Unsafe logical profile path');
    const b = await fs.readFile(path.join(inputDir, 'generations', m.generation, d.path));
    if (b.length !== d.bytes || sha(b) !== d.sha256) throw Error('Source profile hash/size mismatch');
    const p = packProfilePayload(JSON.parse(b), kind, m.generated_at);
    if (p.rows.length !== d.count || JSON.stringify(unpackProfilePayload(p,m.generated_at)) !== b.toString()) throw Error('Source not exactly reversible');
    const raw = Buffer.from(JSON.stringify(p)), compressed = gzipSync(raw, {level:6}), hash = sha(compressed);
    const storage = {key:`blobs/gzip/${hash}.json.gz`,encoding:'gzip',bytes:compressed.length,sha256:hash,decoded_bytes:raw.length};
    validatePackedStorage(storage);
    const file = path.join(outputDir, storage.key);await fs.mkdir(path.dirname(file),{recursive:true});
    try { const prior=await fs.readFile(file);if(!prior.equals(compressed))throw Error('Existing local blob differs'); }
    catch(e) { if(e.code!=='ENOENT')throw e;await fs.writeFile(file,compressed,{flag:'wx'}); }
    const readRaw=raw;
    const rawHash=sha(readRaw),read_storage={key:`blobs/json/${rawHash}.json`,encoding:'identity',bytes:readRaw.length,sha256:rawHash,decoded_bytes:readRaw.length};
    validatePackedStorage(read_storage);
    const readFile=path.join(outputDir,read_storage.key);await fs.mkdir(path.dirname(readFile),{recursive:true});
    try {const prior=await fs.readFile(readFile);if(!prior.equals(readRaw))throw Error('Existing local read mirror differs');}
    catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(readFile,readRaw,{flag:'wx'});}
    const descriptor={...d,storage,read_storage};await validatePackedLocalObject(outputDir,descriptor,m.generated_at,kind);
    sourceBytes+=b.length;storedBytes+=compressed.length;readBytes+=readRaw.length;return descriptor;
  }
  const shards=[];for(const d of m.shards)shards.push(await convert(d,'profiles'));
  const weather=await convert(m.weather,'weather_profiles');
  const result={...m,version:2,format:PACKED_PROFILE_FORMAT,generation,source_generation:m.generation,shards,weather,storage_summary:{source_bytes:sourceBytes,compressed_bytes:storedBytes,read_bytes:readBytes,total_bytes:storedBytes+readBytes}};
  const body=Buffer.from(JSON.stringify(result,null,2)+'\n'),dir=path.join(outputDir,'generations',generation);await fs.mkdir(dir,{recursive:true});
  const manifestFile=path.join(dir,'manifest.json');
  try { const prior=await fs.readFile(manifestFile);if(!prior.equals(body))throw Error('Existing local manifest differs'); }
  catch(e) { if(e.code!=='ENOENT')throw e;await fs.writeFile(manifestFile,body,{flag:'wx'}); }
  await fs.writeFile(path.join(outputDir,'current.json'),body);
  return {generation,sourceBytes,storedBytes,readBytes,totalBytes:storedBytes+readBytes,reduction:1-(storedBytes+readBytes)/sourceBytes,archiveReduction:1-storedBytes/sourceBytes,objects:2*(shards.length+1)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: pack_phase11_profiles.mjs INPUT_DIR OUTPUT_DIR');
  console.log(JSON.stringify(await packProfileGeneration(input,output)));
}
