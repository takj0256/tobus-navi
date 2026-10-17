import {validatePackedStorage,MAX_DECODED_BYTES} from '../js/phase11-profile-codec.js';

export async function decodePackedProfileObject(object, storage, onVerifiedBytes = null) {
  validatePackedStorage(storage);
  if (Number.isFinite(object.size) && object.size !== storage.bytes) throw Error('Packed R2 size mismatch');
  const b = await object.arrayBuffer();
  if (b.byteLength !== storage.bytes) throw Error('Packed R2 byte length mismatch');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if (hash !== storage.sha256) throw Error('Packed R2 SHA mismatch');
  if (storage.encoding === 'identity') {
    onVerifiedBytes?.(b);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
  }
  const reader = new Response(b).body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let length=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>storage.decoded_bytes||length>MAX_DECODED_BYTES)throw Error('Packed decompression exceeds bound');chunks.push(value);}
  } catch(e) { await reader.cancel().catch(()=>{});throw e; }
  if(length!==storage.decoded_bytes)throw Error('Packed decompression length mismatch');
  const raw=new Uint8Array(length);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
}
