// Transcript acquisition chain (docs/v1/DESIGN.md 4.1):
//   0 legacy D1 transcript -> 1 Supadata native captions -> 2 Gemini clip transcription
//   (3 PC Whisper arrives in stage 7; 4 user upload is a separate entry point)
// Each step is recorded in `attempts` so the UI can show why a path was or was not used.
import {transcriptFromUpload} from './captions.mjs';
import {AppError} from './errors.mjs';
import {findLegacyTranscript} from './legacy-transcripts.mjs';
import {DEFAULT_GEMINI_MODEL, transcribeVideo} from './providers/gemini.mjs';
import {safeReason} from './providers/http.mjs';
import {fetchNativeCaptions} from './providers/supadata.mjs';
import {withRetry} from './retry.mjs';
import {parseYouTubeUrl} from './youtube.mjs';

function codeOf(error) {
  return error instanceof AppError ? error.code : 'INTERNAL';
}

function detailOf(error) {
  return safeReason(error instanceof AppError ? error.detail : error?.message);
}

export function acquireFromUpload({url = null, filename, text, durationSec = null}) {
  const video = url ? parseYouTubeUrl(url) : {videoId: null, canonicalUrl: null};
  const transcript = transcriptFromUpload({filename, text, durationSec});
  return {...video, transcript, method: transcript.source, attempts: [{step: 'upload', outcome: 'used'}]};
}

export async function acquireTranscript({url, db = null, keys = {}, liveProvidersEnabled = false,
  usage, fetchFn = fetch, sleep, geminiModel = DEFAULT_GEMINI_MODEL, durationSec = null, geminiOnly = false}) {
  const {videoId, canonicalUrl} = parseYouTubeUrl(url);
  const attempts = [];
  const done = (transcript, extra = {}) => ({videoId, canonicalUrl, transcript, method: transcript.source,
    attempts, ...extra});

  let legacy = null;
  if (geminiOnly) {
    // Owner-chosen test mode: skip saved transcripts and existing captions, transcribe with Gemini.
    attempts.push({step: 'legacy', outcome: 'skipped', reason: 'GEMINI_ONLY'});
  } else {
    try {
      legacy = await findLegacyTranscript(db, videoId);
      attempts.push({step: 'legacy', outcome: legacy ? 'found' : 'none',
        complete: legacy?.transcript.coverage.complete});
    } catch (error) {
      attempts.push({step: 'legacy', outcome: 'error', code: codeOf(error), detail: detailOf(error)});
    }
  }
  if (legacy?.transcript.coverage.complete) return done(legacy.transcript, {legacyJobId: legacy.legacyJobId});

  if (!liveProvidersEnabled) {
    attempts.push({step: 'providers', outcome: 'skipped', reason: 'LIVE_DISABLED'});
  } else {
    if (geminiOnly) {
      attempts.push({step: 'supadata', outcome: 'skipped', reason: 'GEMINI_ONLY'});
    } else if (keys.supadata) {
      const tries = [];
      try {
        const captions = await withRetry('supadata', async () => {
          await usage?.consume({supadataCalls: 1});
          return fetchNativeCaptions({canonicalUrl, apiKey: keys.supadata, fetchFn, sleep});
        }, {sleep, attempts: tries});
        attempts.push({step: 'supadata', outcome: captions ? 'found' : 'no-captions', tries});
        if (captions) return done(captions);
      } catch (error) {
        attempts.push({step: 'supadata', outcome: 'error', code: codeOf(error), detail: detailOf(error), tries});
      }
    } else {
      attempts.push({step: 'supadata', outcome: 'skipped', reason: 'PROVIDER_KEY_MISSING'});
    }

    if (keys.gemini) {
      const tries = [];
      try {
        const result = await transcribeVideo({canonicalUrl, apiKey: keys.gemini, model: geminiModel,
          durationSec: durationSec ?? legacy?.transcript.durationSec ?? null, fetchFn, usage, sleep, attempts: tries});
        attempts.push({step: 'gemini', outcome: 'found', calls: result.calls, model: result.model, tries});
        return done(result.transcript);
      } catch (error) {
        attempts.push({step: 'gemini', outcome: 'error', code: codeOf(error), detail: detailOf(error), tries});
      }
    } else {
      attempts.push({step: 'gemini', outcome: 'skipped', reason: 'PROVIDER_KEY_MISSING'});
    }
  }

  // A partial legacy transcript is better than nothing; coverage.complete=false keeps it labelled.
  if (legacy) return done(legacy.transcript, {legacyJobId: legacy.legacyJobId});
  const error = new AppError('TRANSCRIPT_UNAVAILABLE', videoId);
  error.attempts = attempts;
  throw error;
}
