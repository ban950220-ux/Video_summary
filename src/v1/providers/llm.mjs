// JSON-output text models behind one interface:
//   model.generateJson({system, prompt, schema, maxOutputTokens}) -> {data, usage}
// Gemini (primary, Flash family only) and Groq (fallback, allowlisted free models only).
import {AppError} from '../errors.mjs';
import {toJsonSchema} from '../summary/schema.mjs';
import {assertFreeModel, DEFAULT_GEMINI_MODEL, GEMINI_BASE} from './gemini.mjs';
import {failedResponse, providerFetch, readProviderJson} from './http.mjs';

export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_FREE_MODELS = Object.freeze(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile']);
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

function parseJsonText(raw, name) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('PROVIDER_INVALID_OUTPUT', `${name} output is not JSON`);
  }
}

export function geminiTextModel({apiKey, model = DEFAULT_GEMINI_MODEL, fetchFn = fetch}) {
  assertFreeModel(model);
  return {
    provider: 'gemini',
    model,
    usageKey: 'geminiCalls',
    async generateJson({system, prompt, schema, maxOutputTokens = 16_384}) {
      if (!apiKey) throw new AppError('PROVIDER_KEY_MISSING', 'gemini');
      const body = {
        systemInstruction: {parts: [{text: system}]},
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema,
          maxOutputTokens},
      };
      const response = await providerFetch(`${GEMINI_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {'x-goog-api-key': apiKey, 'content-type': 'application/json'},
        body: JSON.stringify(body),
      }, {fetchFn, name: 'gemini', timeoutMs: 180_000});
      if (!response.ok) throw failedResponse(response, 'gemini');
      const json = await readProviderJson(response, 'gemini');
      const candidate = json?.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') throw new AppError('PROVIDER_INVALID_OUTPUT', 'gemini MAX_TOKENS');
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new AppError('PROVIDER_FAILED', `gemini finish ${candidate.finishReason}`);
      }
      const raw = candidate?.content?.parts?.map(p => p?.text ?? '').join('') ?? '';
      return {
        data: parseJsonText(raw, 'gemini'),
        usage: {promptTokens: json?.usageMetadata?.promptTokenCount ?? null,
          outputTokens: json?.usageMetadata?.candidatesTokenCount ?? null},
      };
    },
  };
}

export function groqTextModel({apiKey, model = DEFAULT_GROQ_MODEL, fetchFn = fetch}) {
  if (!GROQ_FREE_MODELS.includes(model)) throw new AppError('PAID_API_BLOCKED', `model ${model}`);
  return {
    provider: 'groq',
    model,
    usageKey: 'groqCalls',
    async generateJson({system, prompt, schema, maxOutputTokens = 8192}) {
      if (!apiKey) throw new AppError('PROVIDER_KEY_MISSING', 'groq');
      const body = {
        model,
        temperature: 0.2,
        max_completion_tokens: maxOutputTokens,
        response_format: {type: 'json_object'},
        messages: [
          {role: 'system', content: `${system}\n출력 JSON 스키마:\n${JSON.stringify(toJsonSchema(schema))}`},
          {role: 'user', content: prompt},
        ],
      };
      const response = await providerFetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
        body: JSON.stringify(body),
      }, {fetchFn, name: 'groq', timeoutMs: 180_000});
      if (!response.ok) throw failedResponse(response, 'groq');
      const json = await readProviderJson(response, 'groq');
      const choice = json?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new AppError('PROVIDER_INVALID_OUTPUT', 'groq length');
      if (typeof choice?.message?.content !== 'string') throw new AppError('PROVIDER_INVALID_OUTPUT', 'groq content');
      return {
        data: parseJsonText(choice.message.content, 'groq'),
        usage: {promptTokens: json?.usage?.prompt_tokens ?? null, outputTokens: json?.usage?.completion_tokens ?? null},
      };
    },
  };
}
