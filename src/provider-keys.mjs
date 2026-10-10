// Server-only credential bridge. NEVER import from browser assets.
// No credential is included in HTTP responses, logs, D1 plaintext or usage events.
import {configuredMasterKey,decryptProviderKey,providerAllowed} from './vault.mjs';
import {ProviderError,assertLive,fetchSupadataCaption,transcribeOwnedAudio,summarizeTranscriptWithGemini} from './adapters.mjs';

const CONFIG={supadata:'SUPADATA',groq:'GROQ',gemini:'GEMINI',assemblyai:'ASSEMBLYAI'};

/** Resolve a provider key transiently in Worker memory. Prefer site-managed encrypted D1 credentials.
 * The root encryption secret MUST stay in the Worker Secret store. */
export async function resolveProviderKey(env,provider){
  if(!providerAllowed(provider))throw new ProviderError('PROVIDER_NOT_SUPPORTED','지원하지 않는 제공자입니다.');
  const scope=CONFIG[provider];
  assertLive(env,scope); // denied plans/missing approval MUST fail before reading secrets
  if(env.DB){
    const row=await env.DB.prepare('SELECT cipher_version,iv_b64,ciphertext_b64 FROM provider_credentials WHERE owner_id = ? AND provider = ?')
      .bind('owner',provider).first();
    if(row){
      const root=configuredMasterKey(env);
      if(!root)throw new ProviderError('VAULT_NOT_READY','암호화 키 저장소 구성이 필요합니다.');
      try {
        return await decryptProviderKey(root,provider,{version:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64});
      } catch {throw new ProviderError('VAULT_DECRYPT_FAILED','저장된 연결 정보를 읽을 수 없습니다. 키를 다시 등록하세요.');}
    }
  }
  // Operator-managed Worker Secrets fallback, not exposed to frontend settings.
  const secret=env?.[`${scope}_API_KEY`];
  if(typeof secret==='string'&&secret.length>=8)return secret;
  throw new ProviderError('KEY_MISSING','사이트 설정에서 무료 제공자 키를 등록해야 합니다.');
}

async function ephemeralEnv(env,provider){
  const scope=CONFIG[provider],value=await resolveProviderKey(env,provider);
  return {...env,[`${scope}_API_KEY`]:value};
}

/** One native-caption request. Requires an independently verified free plan and explicit live gate.
 * Even no-captions (206) can cost one provider credit. Caller must reserve/settle quota BEFORE/AFTER this function. */
export async function runNativeCaption({env,url,fetchFn=fetch}){
  return fetchSupadataCaption(url,await ephemeralEnv(env,'supadata'),fetchFn);
}
/** Transcript-based Korean summary (not a verified verbatim transcript). Needs quota reservation by caller. */
export async function runTranscriptSummary({env,text,fetchFn=fetch}){
  return summarizeTranscriptWithGemini(text,await ephemeralEnv(env,'gemini'),fetchFn);
}
/** Only lawful owner-uploaded audio, <=24MB per call. 120 minute chunking is NOT implemented. */
export async function runOwnedAudioTranscription({env,bytes,name,mime,durationSeconds,fetchFn=fetch}){
  return transcribeOwnedAudio({env:await ephemeralEnv(env,'groq'),bytes,name,mime,durationSeconds,fetchFn});
}
