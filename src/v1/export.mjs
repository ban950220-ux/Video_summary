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

const CODE_TEXT = Object.freeze({VALUE_CHANGED: '값이 원문과 다름', UNIT_CHANGED: '단위가 원문과 다름',
  QUALIFIER_CHANGED: '약·이상·미만 같은 한정어가 원문과 다름', KIND_CHANGED: '지표(비중·증가율 등)가 원문과 다름',
  QUOTE_NOT_FOUND: '근거 인용을 원문에서 찾지 못함', NO_NUMBER_IN_SOURCE: '근거 구간에서 숫자를 읽지 못함',
  NO_EVIDENCE: '원문 근거가 기록되지 않음'});
export const verificationCodeText = code => CODE_TEXT[code] ?? code;

export function exportMarkdown({job, transcript, summary, verification = null}) {
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
  if (verification) {
    const {counts} = verification;
    lines.push('## 숫자 근거 검증 (자동)', '',
      `숫자 ${counts.total}개: 원문 확인 ${counts.verified} · 불일치 ${counts.mismatch} · 확인 불가 ${counts.unverifiable}`,
      '(숫자·단위·한정어·지표만 대조하며 문장 전체의 의미를 보증하지 않음)', '',
      ...verification.items.filter(i => i.status !== 'VERIFIED')
        .map(i => `- ${i.status === 'MISMATCH' ? '⚠' : '?'} ${i.surface}: `
          + i.codes.map(verificationCodeText).join(', ')),
      '');
  }
  if (summary.crossCheck?.status === 'DONE') {
    const {counts, items} = summary.crossCheck;
    lines.push('## 영상 다시 듣기 교차 확인', '',
      `숫자 ${counts.total}개: 교차 확인 ${counts.confirmed} · 다르게 들림 ${counts.differs} · 미확인 ${counts.notChecked}`,
      '', ...items.filter(i => i.result === 'DIFFERS')
        .map(i => `- ⚠ ${i.surface}: 다시 들은 값 ${i.heardValues?.join(', ') || '숫자 없음'}`), '');
  }
  return lines.join('\n');
}

export function exportText(input) {
  return exportMarkdown(input).replace(/^#{1,3} /gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
