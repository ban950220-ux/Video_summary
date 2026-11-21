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

// Paid-tier guard (owner decision 2026-11-21): the Gemini key is on a billed Google project, so the
// app keeps its own monthly spend estimate and stops Gemini calls near the budget.
// Rates: gemini-3.8-flash standard, USD per 1M tokens (third-party listings; override if they change).
export const DEFAULT_BUDGET = Object.freeze({monthlyKrw: 3000, reserveKrw: 150, krwPerUsd: 1500,
  usdPerMInput: 0.75, usdPerMOutput: 3.75});

function nonNegative(raw, fallback) {
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

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
    // V1_LIVE_PROVIDERS is the v1-only switch; ENABLE_LIVE_FREE is the shared v0.7 switch.
    liveProvidersEnabled: env.V1_LIVE_PROVIDERS === 'true' || env.ENABLE_LIVE_FREE === 'true',
    budget: {
      monthlyKrw: nonNegative(env.V1_MONTHLY_BUDGET_KRW, DEFAULT_BUDGET.monthlyKrw),
      reserveKrw: DEFAULT_BUDGET.reserveKrw,
      // Spend before tracking existed, e.g. "2026-11:900" (counted only in that month).
      offset: /^\d{4}-\d{2}:\d{1,7}$/.test(env.V1_SPEND_OFFSET ?? '') ? env.V1_SPEND_OFFSET : null,
      krwPerUsd: nonNegative(env.V1_KRW_PER_USD, DEFAULT_BUDGET.krwPerUsd),
      usdPerMInput: nonNegative(env.V1_GEMINI_USD_PER_M_INPUT, DEFAULT_BUDGET.usdPerMInput),
      usdPerMOutput: nonNegative(env.V1_GEMINI_USD_PER_M_OUTPUT, DEFAULT_BUDGET.usdPerMOutput),
    },
    dailyLimits: {
      supadataCalls: cappedInteger(env.V1_LIMIT_SUPADATA_CALLS, DEFAULT_DAILY_LIMITS.supadataCalls),
      geminiVideoSeconds: cappedInteger(env.V1_LIMIT_GEMINI_VIDEO_SECONDS, DEFAULT_DAILY_LIMITS.geminiVideoSeconds),
      geminiCalls: cappedInteger(env.V1_LIMIT_GEMINI_CALLS, DEFAULT_DAILY_LIMITS.geminiCalls),
      groqCalls: cappedInteger(env.V1_LIMIT_GROQ_CALLS, DEFAULT_DAILY_LIMITS.groqCalls),
    },
  };
}
