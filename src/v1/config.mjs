// v1 runtime configuration. Paid API use is never enabled from configuration:
// the free-only rule is enforced in code, not by an environment flag.

export const VERSION = 'v1-dev';

// Conservative in-app daily caps. Provider-side free limits can change, so these are
// configurable, but they can only be lowered below the defaults, never raised.
export const DEFAULT_DAILY_LIMITS = Object.freeze({
  supadataCalls: 3,
  geminiVideoSeconds: 6 * 60 * 60,
  geminiCalls: 200,
  groqCalls: 200,
});

function cappedInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, fallback);
}

export function readConfig(env = {}) {
  return {
    version: VERSION,
    paidApiAllowed: false,
    // Reported so the UI can warn when the environment asks for something the code refuses.
    paidApiRequested: env.ALLOW_PAID_API === 'true',
    liveProvidersEnabled: env.ENABLE_LIVE_FREE === 'true',
    dailyLimits: {
      supadataCalls: cappedInteger(env.V1_LIMIT_SUPADATA_CALLS, DEFAULT_DAILY_LIMITS.supadataCalls),
      geminiVideoSeconds: cappedInteger(env.V1_LIMIT_GEMINI_VIDEO_SECONDS, DEFAULT_DAILY_LIMITS.geminiVideoSeconds),
      geminiCalls: cappedInteger(env.V1_LIMIT_GEMINI_CALLS, DEFAULT_DAILY_LIMITS.geminiCalls),
      groqCalls: cappedInteger(env.V1_LIMIT_GROQ_CALLS, DEFAULT_DAILY_LIMITS.groqCalls),
    },
  };
}
