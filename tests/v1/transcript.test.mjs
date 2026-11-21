import assert from 'node:assert/strict';
import test from 'node:test';
import {acquireFromUpload} from '../../src/v1/acquire.mjs';
import {coverageOf, formatClock, makeTranscript, SOURCES, transcriptAsPromptText} from '../../src/v1/transcript.mjs';
import {parseYouTubeUrl, watchUrlAt} from '../../src/v1/youtube.mjs';

test('YouTube URL forms resolve to one canonical URL', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [
    `https://www.youtube.com/watch?v=${id}&t=10s`, `https://youtu.be/${id}?si=x`,
    `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, ` https://youtube.com/watch?v=${id} `,
  ]) {
    assert.deepEqual(parseYouTubeUrl(input), {videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`});
  }
  assert.equal(watchUrlAt(id, 61.9), `https://www.youtube.com/watch?v=${id}&t=61s`);
});

test('non-YouTube, non-HTTPS and malformed URLs are rejected', () => {
  for (const input of ['http://youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=short', 'https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ', 'not a url', 42]) {
    assert.throws(() => parseYouTubeUrl(input), {code: 'INVALID_URL'});
  }
});

test('makeTranscript trims, drops empty text, sorts by time and renumbers', () => {
  const t = makeTranscript({source: SOURCES.UPLOAD, durationSec: 30, segments: [
    {startMs: 20_000, endMs: 29_500, text: ' 둘째  문장 '},
    {startMs: 0, endMs: 5000, text: '첫 문장'},
    {startMs: 6000, endMs: 7000, text: '   '},
  ]});
  assert.deepEqual(t.segments.map(s => [s.id, s.startMs, s.text]), [[1, 0, '첫 문장'], [2, 20_000, '둘째 문장']]);
  assert.equal(t.timed, true);
  assert.equal(t.coverage.complete, true);
});

test('coverage is incomplete when the end or start is missing, or flagged partial', () => {
  const seg = (s, e) => ({id: 1, startMs: s * 1000, endMs: e * 1000, text: 'x'});
  assert.equal(coverageOf([seg(0, 300)], 600).complete, false);
  assert.equal(coverageOf([seg(120, 600)], 600).complete, false);
  assert.equal(coverageOf([seg(0, 600)], 600, true).complete, false);
  assert.equal(coverageOf([seg(0, 600)], null).complete, false);
  assert.equal(coverageOf([seg(0, 590)], 600).ratio, 0.9833);
});

test('invalid transcripts are rejected', () => {
  assert.throws(() => makeTranscript({source: SOURCES.UPLOAD, segments: []}), {code: 'INVALID_TRANSCRIPT'});
  assert.throws(() => makeTranscript({source: SOURCES.UPLOAD, segments: [{startMs: 5, endMs: 1, text: 'a'}]}),
    {code: 'INVALID_TRANSCRIPT'});
  assert.throws(() => makeTranscript({source: 'nope', segments: [{text: 'a'}]}), {code: 'INTERNAL'});
});

test('clock formatting and prompt text keep segment IDs', () => {
  assert.equal(formatClock(65_000), '01:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  const t = makeTranscript({source: SOURCES.UPLOAD, segments: [{startMs: 0, endMs: 1000, text: '안녕'},
    {startMs: 61_000, endMs: 62_000, text: '하세요'}]});
  assert.equal(transcriptAsPromptText(t), '[#1 00:00] 안녕\n[#2 01:01] 하세요');
  assert.equal(transcriptAsPromptText(t, {fromId: 2}), '[#2 01:01] 하세요');
});

test('SRT, VTT and TXT uploads become transcripts', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n첫 줄\n\n2\n00:00:04,000 --> 00:00:06,500\n<i>둘째</i> 줄\n';
  const fromSrt = acquireFromUpload({filename: 'a.srt', text: srt, url: 'https://youtu.be/dQw4w9WgXcQ'});
  assert.equal(fromSrt.videoId, 'dQw4w9WgXcQ');
  assert.equal(fromSrt.method, 'upload');
  assert.deepEqual(fromSrt.transcript.segments.map(s => s.text), ['첫 줄', '둘째 줄']);
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n';
  assert.equal(acquireFromUpload({filename: 'b.vtt', text: vtt}).transcript.segments[0].endMs, 2000);
  const txt = acquireFromUpload({filename: 'c.txt', text: '시간 없는 원고'}).transcript;
  assert.equal(txt.timed, false);
  assert.equal(txt.coverage.complete, false);
});

test('bad uploads fail with INVALID_TRANSCRIPT', () => {
  assert.throws(() => acquireFromUpload({filename: 'a.srt', text: 'no cues here'}), {code: 'INVALID_TRANSCRIPT'});
  assert.throws(() => acquireFromUpload({filename: 'a.pdf', text: 'x'}), {code: 'INVALID_TRANSCRIPT'});
  assert.throws(() => acquireFromUpload({filename: '../a.srt', text: 'x'}), {code: 'INVALID_TRANSCRIPT'});
});
