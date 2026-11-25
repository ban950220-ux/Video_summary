// Provider keys for v1: the existing v0.7 encrypted vault (provider_credentials, AES-GCM with the
// KEY_ENCRYPTION_KEY_B64 Worker Secret) first, then a plain Worker Secret. Keys never leave the server.
import {configuredMasterKey, decryptProviderKey} from '../vault.mjs';

const PROVIDERS = Object.freeze({supadata: 'SUPADATA_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY'});

// All vault rows in one query (each D1 call costs Worker CPU under the Free plan's 10ms limit).
async function vaultRows(env) {
  if (!configuredMasterKey(env) || !env?.DB) return new Map();
  try {
    const {results = []} = await env.DB.prepare(`SELECT provider, cipher_version, iv_b64, ciphertext_b64
      FROM provider_credentials WHERE owner_id = 'owner'`).all();
    return new Map(results.map(row => [row.provider, row]));
  } catch {
    return new Map();
  }
}

async function vaultKey(env, provider, row) {
  if (!row) return null;
  try {
    return await decryptProviderKey(configuredMasterKey(env), provider, {version: row.cipher_version,
      ivB64: row.iv_b64, ciphertextB64: row.ciphertext_b64});
  } catch {
    return null;
  }
}

export async function loadProviderKeys(env) {
  const keys = {};
  const rows = await vaultRows(env);
  for (const [provider, secretName] of Object.entries(PROVIDERS)) {
    const fromVault = await vaultKey(env, provider, rows.get(provider));
    const secret = typeof env?.[secretName] === 'string' && env[secretName].length >= 8 ? env[secretName] : null;
    keys[provider] = fromVault ?? secret;
  }
  return keys;
}

export function keyStatus(keys) {
  return Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, Boolean(keys[p])]));
}

// Which keys are registered, without decrypting any (the settings screen only shows yes/no).
// One query; a vault row that exists but cannot be decrypted still shows as registered.
export async function registeredKeys(env) {
  const stored = new Set();
  if (configuredMasterKey(env) && env?.DB) {
    try {
      const {results = []} = await env.DB.prepare(`SELECT provider FROM provider_credentials
        WHERE owner_id = 'owner'`).all();
      for (const row of results) stored.add(row.provider);
    } catch {
      // No vault table: fall back to Worker Secrets only.
    }
  }
  return Object.fromEntries(Object.entries(PROVIDERS).map(([provider, secretName]) => [provider,
    stored.has(provider) || (typeof env?.[secretName] === 'string' && env[secretName].length >= 8)]));
}
