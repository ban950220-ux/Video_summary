// Splits a transcript into summary chunks on segment boundaries.
// Timed transcripts: about CHUNK_SEC of video per chunk; every chunk also stays under CHUNK_CHARS.
export const CHUNK_SEC = 15 * 60;
export const CHUNK_CHARS = 12_000;
// Above this size the whole transcript is summarized in map-reduce mode instead of one call.
export const SINGLE_CALL_CHARS = 12_000;

export function chunkTranscript(transcript, {chunkSec = CHUNK_SEC, chunkChars = CHUNK_CHARS} = {}) {
  const chunks = [];
  let current = [];
  let chars = 0;
  let windowStart = null;
  const flush = () => {
    if (!current.length) return;
    chunks.push({
      index: chunks.length,
      fromId: current[0].id,
      toId: current.at(-1).id,
      startMs: current[0].startMs,
      endMs: current.at(-1).endMs ?? current.at(-1).startMs,
      segments: current,
    });
    current = [];
    chars = 0;
    windowStart = null;
  };
  for (const segment of transcript.segments) {
    const size = segment.text.length + 16;
    const timeFull = segment.startMs !== null && windowStart !== null
      && segment.startMs - windowStart >= chunkSec * 1000;
    if (current.length && (chars + size > chunkChars || timeFull)) flush();
    if (windowStart === null) windowStart = segment.startMs;
    current.push(segment);
    chars += size;
  }
  flush();
  return chunks;
}

export function totalChars(transcript) {
  return transcript.segments.reduce((sum, s) => sum + s.text.length + 16, 0);
}
