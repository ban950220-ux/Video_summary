// Machine-readable export for other projects (e.g. BANSIGHT: company, macro and market analysis).
// Keeps what the reader needs to judge trust: who said it (speaker vs AI), where in the video,
// the source sentence, and for each number the verification and re-listen results.
// Nothing here is investment advice or a verified fact; it is what the video said, with evidence.
import {watchUrlAt} from './youtube.mjs';

export const EXPORT_SCHEMA = 'video-summary-export-v1';

export function exportJson({job, transcript, summary, verification, corrections = {}}) {
  const byId = new Map((transcript?.segments ?? []).map(s => [s.id, s]));
  const cross = new Map((summary.crossCheck?.items ?? []).map(i => [`${i.value}|${i.segmentIds.join(',')}`, i]));
  const checks = new Map();
  for (const item of verification?.items ?? []) {
    checks.set(`${item.path}|${item.value}|${(item.segmentIds ?? []).join(',')}`, item);
  }
  const evidence = ids => ids.map(id => byId.get(id)).filter(Boolean).map(s => ({
    segmentId: s.id,
    startSec: Number.isFinite(s.startMs) ? Math.floor(s.startMs / 1000) : null,
    url: job.videoId && Number.isFinite(s.startMs) ? watchUrlAt(job.videoId, s.startMs / 1000) : null,
    text: s.text,
    transcriptFlags: s.flags ?? [],
  }));
  const numbers = (path, facts) => (facts ?? []).map(fact => {
    const check = checks.get(`${path}|${fact.value}|${fact.segmentIds.join(',')}`);
    const heard = cross.get(`${fact.value}|${fact.segmentIds.join(',')}`);
    return {
      surface: fact.surface, value: fact.value, unit: fact.unit, qualifier: fact.qualifier,
      kind: fact.kind ?? null, subject: fact.subject ?? null, quote: fact.quote,
      segmentIds: fact.segmentIds,
      verification: check ? {status: check.status, codes: check.codes} : null,
      reListen: heard ? {result: heard.result, heardValues: heard.heardValues ?? []} : null,
    };
  });
  const statement = (kind, path, item) => ({
    kind,
    attribution: item.attribution ?? 'SPEAKER',
    synthesized: item.synthesized === true,
    text: item.text ?? item.summary,
    evidence: evidence(item.segmentIds ?? []),
    numbers: numbers(path, item.facts),
  });
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    video: {id: job.videoId, url: job.url, title: job.title, publishedAt: job.options?.publishedAt ?? null},
    summarizedAt: job.createdAt,
    language: 'ko',
    reviewState: job.options?.correctedFrom ? 'AUTO_WITH_MANUAL_TRANSCRIPT_CORRECTIONS' : 'AUTO_NOT_HUMAN_REVIEWED',
    transcript: {
      source: transcript?.source ?? null,
      coverage: transcript?.coverage ?? null,
      // Counts come from the stored checks when the export reads only the segments it cites.
      segments: transcript?.counts?.segments ?? transcript?.segments.length ?? 0,
      uncertainSegments: transcript?.counts?.uncertain
        ?? (transcript?.segments ?? []).filter(s => s.flags?.some(f => f !== 'CORRECTED')).length,
      pendingCorrections: Object.keys(corrections).length,
    },
    conclusion: statement('CONCLUSION', 'conclusion', {...summary.conclusion, attribution: 'INTERPRETATION'}),
    statements: [
      ...summary.keyPoints.map((p, i) => statement('KEY_POINT', `keyPoints[${i}]`, p)),
      ...(summary.analysis?.items ?? []).map((a, i) => statement(a.type, `analysis[${i}]`, a)),
    ],
    chapters: summary.chapters.map((c, i) => ({
      startSec: Number.isFinite(c.startMs) ? Math.floor(c.startMs / 1000) : null,
      endSec: Number.isFinite(c.endMs) ? Math.floor(c.endMs / 1000) : null,
      url: job.videoId && Number.isFinite(c.startMs) ? watchUrlAt(job.videoId, c.startMs / 1000) : null,
      title: c.title, summary: c.summary, numbers: numbers(`chapters[${i}]`, c.facts),
    })),
    checks: {
      numbers: verification?.counts ?? null,
      reListen: summary.crossCheck?.status === 'DONE' ? {...summary.crossCheck.counts,
        sameEngineAsTranscript: summary.crossCheck.sameEngineAsTranscript === true} : null,
      analysis: summary.analysis?.status ?? 'NOT_RUN',
    },
    notes: [
      'Statements report what the video says; they are not externally fact-checked.',
      'verification compares numbers with the transcript; reListen compares them with a second listen of the video.',
    ],
  };
}
