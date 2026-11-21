// User upload path: SRT / VTT / TXT. Reuses the tested legacy parser in src/core.mjs.
import {parseCaptions} from '../core.mjs';
import {AppError} from './errors.mjs';
import {makeTranscript, SOURCES} from './transcript.mjs';

const NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}\.(srt|vtt|txt)$/i;

export function transcriptFromUpload({filename, text, language = null, durationSec = null}) {
  if (typeof filename !== 'string' || !NAME.test(filename)) throw new AppError('INVALID_TRANSCRIPT', 'filename');
  let parsed;
  try {
    parsed = parseCaptions(text, filename);
  } catch (error) {
    throw new AppError('INVALID_TRANSCRIPT', error?.message);
  }
  return makeTranscript({source: SOURCES.UPLOAD, language, segments: parsed.segments, durationSec});
}
