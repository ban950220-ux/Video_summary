// Markdown / TXT export of a finished job.
import {formatClock} from './transcript.mjs';
import {watchUrlAt} from './youtube.mjs';

const SOURCE_LABELS = Object.freeze({
  'legacy-d1': '기존 저장 전사(v0.7)', 'supadata-native': 'YouTube 기존 자막', 'gemini-video': 'Gemini 영상 전사',
  'pc-whisper': 'PC Whisper 전사', upload: '사용자 업로드',
});
const ATTRIBUTION_LABELS = Object.freeze({SPEAKER: '화자', INTERPRETATION: 'AI 해석'});

function coverageLine(transcript) {
  const c = transcript?.coverage ?? {};
  if (c.complete) return '전사 범위: 영상 처음~끝 (시간축 기준 추정, 모든 발화 보증 아님)';
  const span = c.lastSec ? `${formatClock((c.firstSec ?? 0) * 1000)}~${formatClock(c.lastSec * 1000)}` : '';
  if (c.lastSec && (c.ratio === null || c.ratio === undefined) && !c.partial) return `전사 범위: ${span} (영상 길이 미확인)`;
  if (c.lastSec) return `전사 범위: 일부 (${span})`;
  return '전사 범위: 확인 불가';
}

export function exportMarkdown({job, transcript, summary}) {
  const link = sec => (job.videoId && Number.isFinite(sec) ? ` ([${formatClock(sec)}](${watchUrlAt(job.videoId,
    sec / 1000)}))` : '');
  const lines = [
    `# ${job.title ?? job.videoId ?? '영상 요약'}`,
    '',
    `- 영상: ${job.url ?? '없음'}`,
    `- 전사 출처: ${SOURCE_LABELS[transcript?.source] ?? transcript?.source ?? '알 수 없음'}`,
    `- ${coverageLine(transcript)}`,
    `- 요약 생성: 자동 (${summary.generation?.mode ?? ''}, 사람 검토 전)`,
    '',
    '## 핵심 결론',
    '',
    summary.conclusion.text,
    '',
    '## 핵심 요약',
    '',
    ...summary.keyPoints.map(p => `- [${ATTRIBUTION_LABELS[p.attribution]}] ${p.text}`
      + ` (근거 #${p.segmentIds.join(', #')})`),
    '',
    '## 챕터',
    '',
    ...summary.chapters.map(c => `### ${formatClock(c.startMs)} ${c.title}${link(c.startMs)}\n\n${c.summary}\n`),
  ];
  if (summary.warnings?.length) {
    lines.push('## 확인 필요', '', ...summary.warnings.map(w => `- ${w.path}: 숫자의 원문 근거가 기록되지 않음`), '');
  }
  return lines.join('\n');
}

export function exportText(input) {
  return exportMarkdown(input).replace(/^#{1,3} /gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
