// Backend-only provider key vault. Never import this module into a frontend.
// A 32-byte root key must be provided as KEY_ENCRYPTION_KEY_B64, a Worker Secret.
const PROVIDERS = new Set(['supadata','gemini','groq','assemblyai']);
export function providerAllowed(name) { return PROVIDERS.has(name); }
export function configuredMasterKey(env) {
  const secret = env?.KEY_ENCRYPTION_KEY_B64;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) return null;
  try {
    const chars=atob(secret);
    if(chars.length!==32) return null;
    return Uint8Array.from(chars, c=>c.charCodeAt(0));
  } catch { return null; }
}
function base64(bytes) { let out=''; for(const v of bytes)out+=String.fromCharCode(v);return btoa(out); }
function decode(s) { return Uint8Array.from(atob(s),ch=>ch.charCodeAt(0)); }
async function cryptKey(root) {return crypto.subtle.importKey('raw', root, {name:'AES-GCM'}, false, ['encrypt','decrypt']);}
export async function encryptProviderKey(root,provider,apiKey,owner='owner'){
  if(!providerAllowed(provider)) throw new Error('INVALID_PROVIDER');
  if(typeof apiKey!=='string'||apiKey.length<8||apiKey.length>1024||/[\r\n\0]/.test(apiKey))throw new Error('INVALID_API_KEY');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const add=new TextEncoder().encode(`yta-key:v1:${owner}:${provider}`);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:add,tagLength:128},await cryptKey(root),new TextEncoder().encode(apiKey));
  return {version:1,ivB64:base64(iv),ciphertextB64:base64(new Uint8Array(encrypted))};
}
export async function decryptProviderKey(root,provider,record,owner='owner') {
  if(record.version!==1||!providerAllowed(provider))throw new Error('INVALID_VAULT_RECORD');
  const add=new TextEncoder().encode(`yta-key:v1:${owner}:${provider}`);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(record.ivB64),additionalData:add,tagLength:128},await cryptKey(root),decode(record.ciphertextB64));
  return new TextDecoder().decode(plain);
}
