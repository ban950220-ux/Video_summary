// Job result view: status, conclusion, key points (speaker vs AI interpretation, evidence),
// chapters with YouTube time links, warnings, export and delete.
import {clock, date, h, watchUrl} from './dom.js';

const SOURCE = {
  'legacy-d1': '기존 저장 전사(v0.7)', 'supadata-native': 'YouTube 기존 자막', 'gemini-video': 'Gemini 영상 전사',
  'pc-whisper': 'PC Whisper 전사', upload: '사용자 업로드',
};
const STEPS = [['QUEUED', '대기'], ['ACQUIRING', '자막·전사 확보'], ['SUMMARIZING', '요약'], ['DONE', '완료']];
export const ERROR_TEXT = {
  TRANSCRIPT_UNAVAILABLE: '자막·전사를 자동으로 가져오지 못했습니다. 자막 파일(SRT/VTT/TXT)을 올리거나 PC 실행기를 사용하세요.',
  DAILY_LIMIT_REACHED: '오늘의 무료 사용 한도에 도달했습니다. 내일 다시 시도하세요.',
  PROVIDER_KEY_MISSING: 'API 키가 등록되지 않았습니다. 기존 설정 화면에서 키를 등록하세요.',
  PROVIDER_INVALID_OUTPUT: '요약 형식이 두 번 연속 올바르지 않았습니다. 잠시 후 다시 시도하세요.',
  PROVIDER_RATE_LIMITED: '외부 서비스의 무료 한도에 걸렸습니다. 잠시 후 다시 시도하세요.',
};
const STEP_TEXT = {saved: '이전 v1 작업의 전사', legacy: '기존 저장 전사', supadata: 'YouTube 기존 자막',
  gemini: 'Gemini 영상 전사', providers: '외부 서비스',
  failure: '실패 지점'};
const OUTCOME_TEXT = {found: '사용', none: '없음', 'no-captions': '자막 없음', skipped: '건너뜀', error: '실패', used: '사용'};

function coverageText(transcript) {
  const c = transcript?.coverage ?? {};
  if (c.complete) return '영상 처음~끝 (시간축 기준 추정)';
  const span = c.lastSec ? `${clock((c.firstSec ?? 0) * 1000)}~${clock(c.lastSec * 1000)}` : '';
  // Captions carry no video length, so "partial" can only be claimed when the length is known.
  if (c.lastSec && (c.ratio === null || c.ratio === undefined) && !c.partial) return `${span} (영상 길이 미확인)`;
  if (c.lastSec) return `일부만 전사됨 (${span})`;
  return '전사 범위 확인 불가';
}

function steps(status) {
  const at = STEPS.findIndex(([key]) => key === status);
  return h('ol', {class: 'steps', 'aria-label': '진행 단계'},
    STEPS.map(([, label], i) => h('li', {class: i < at || status === 'DONE' ? 'done' : i === at ? 'now' : ''}, label)));
}

function evidence(ids, transcript, videoId) {
  const byId = new Map((transcript?.segments ?? []).map(s => [s.id, s]));
  const box = h('div');
  const chips = h('div', {class: 'evidence'}, ids.map(id => h('button', {type: 'button', 'data-segment': id,
    onclick: () => {
      const seg = byId.get(id);
      box.replaceChildren(seg ? h('p', {class: 'quote'}, h('a', {href: watchUrl(videoId, seg.startMs),
        target: '_blank', rel: 'noopener'}, clock(seg.startMs)), ' ', seg.text) : h('p', {class: 'muted'}, '구간 없음'));
    }}, `#${id}`)));
  return [chips, box];
}

function point(p, transcript, videoId) {
  const speaker = p.attribution === 'SPEAKER';
  return h('li', {},
    h('span', {class: `badge ${speaker ? 'speaker' : 'ai'}`}, speaker ? '화자' : 'AI 해석'), ' ', p.text,
    evidence(p.segmentIds, transcript, videoId));
}

const CODE_TEXT = {VALUE_CHANGED: '값이 원문과 다름', UNIT_CHANGED: '단위가 원문과 다름',
  QUALIFIER_CHANGED: '약·이상·미만 같은 한정어가 다름', KIND_CHANGED: '지표(비중·증가율 등)가 다름',
  QUOTE_NOT_FOUND: '근거 인용을 원문에서 못 찾음', NO_NUMBER_IN_SOURCE: '근거 구간에서 숫자를 못 읽음',
  NO_EVIDENCE: '원문 근거 없음'};
const MARK = {VERIFIED: '✓', MISMATCH: '⚠', UNVERIFIABLE: '?'};

function verificationCard(verification, transcript, videoId) {
  const {counts, items} = verification;
  const rows = [...items].sort((a, b) => (a.status === 'VERIFIED') - (b.status === 'VERIFIED'));
  return h('section', {class: 'card', id: 'verification'}, h('h2', {}, '숫자 근거 검증'),
    h('p', {}, `숫자 ${counts.total}개: 원문 확인 ${counts.verified} · 불일치 ${counts.mismatch} · `
      + `확인 불가 ${counts.unverifiable}`),
    h('p', {class: 'muted'}, '숫자·단위·한정어·지표만 원문과 대조합니다. 문장 전체의 의미를 보증하지 않습니다.'),
    h('ul', {class: 'points'}, rows.map(item => h('li', {class: `verify-${item.status}`},
      h('span', {class: 'badge'}, MARK[item.status]), ' ', h('strong', {}, item.surface ?? ''),
      item.codes.length ? ` — ${item.codes.map(c => CODE_TEXT[c] ?? c).join(', ')}` : ' — 원문 확인',
      item.source && item.status === 'MISMATCH' ? h('span', {class: 'muted'}, ` (원문: ${item.source})`) : null,
      item.segmentIds?.length ? evidence(item.segmentIds, transcript, videoId) : null))));
}

export function renderResult({job, transcript, summary, verification}, {onDelete}) {
  const nodes = [h('section', {class: 'card'},
    h('h1', {}, job.title ?? job.videoId ?? '영상 요약'),
    h('p', {class: 'muted'}, date(job.createdAt), job.url ? ' · ' : '',
      job.url ? h('a', {href: job.url, target: '_blank', rel: 'noopener'}, 'YouTube에서 보기') : ''),
    h('div', {class: 'row'}, h('span', {class: `badge status-${job.status}`}, job.status)),
    job.status === 'DONE' || job.status === 'FAILED' ? null : steps(job.status),
    transcript ? h('p', {class: 'muted'}, `전사 출처: ${SOURCE[transcript.source] ?? transcript.source} · `
      + `범위: ${coverageText(transcript)}`) : null)];

  if (job.status === 'FAILED') {
    nodes.push(h('section', {class: 'card', id: 'failure'},
      h('h2', {}, '처리하지 못했습니다'),
      h('p', {}, ERROR_TEXT[job.errorCode] ?? `오류: ${job.errorCode ?? '알 수 없음'}`),
      h('ul', {}, (job.attempts ?? []).filter(a => a.step).map(a => h('li', {class: 'muted'},
        `${STEP_TEXT[a.step] ?? a.step}: ${OUTCOME_TEXT[a.outcome] ?? a.outcome}${a.code ? ` (${a.code})` : ''}`
        + (a.detail ? ` — ${a.detail}` : '')))),
      h('a', {class: 'button secondary', href: '#new'}, '자막 파일로 다시 시도')));
  }

  if (summary) {
    nodes.push(
      h('section', {class: 'card', id: 'conclusion'}, h('h2', {}, '핵심 결론'),
        h('p', {class: 'muted'}, '자동 생성 · 사람 검토 전'), h('p', {}, summary.conclusion.text),
        evidence(summary.conclusion.segmentIds, transcript, job.videoId)),
      h('section', {class: 'card', id: 'points'}, h('h2', {}, '핵심 요약'),
        h('ul', {class: 'points'}, summary.keyPoints.map(p => point(p, transcript, job.videoId)))),
      h('section', {class: 'card', id: 'chapters'}, h('h2', {}, '챕터'),
        summary.chapters.map(c => {
          const href = watchUrl(job.videoId, c.startMs);
          return h('div', {class: 'chapter'},
            href ? h('a', {class: 'time', href, target: '_blank', rel: 'noopener'}, clock(c.startMs))
              : h('span', {class: 'time'}, clock(c.startMs)),
            h('div', {}, h('strong', {}, c.title), h('p', {}, c.summary)));
        })),
    );
    if (verification?.counts.total) nodes.push(verificationCard(verification, transcript, job.videoId));
    if (summary.warnings?.length) {
      nodes.push(h('section', {class: 'card warn'}, h('h2', {}, '확인 필요'),
        h('p', {}, `숫자의 원문 근거가 기록되지 않은 항목 ${summary.warnings.length}개가 있습니다.`)));
    }
    nodes.push(h('section', {class: 'card row'},
      h('a', {class: 'button secondary', href: `/api/v1/jobs/${job.id}/export`}, 'Markdown 내보내기'),
      h('a', {class: 'button secondary', href: `/api/v1/jobs/${job.id}/export?format=txt`}, 'TXT 내보내기'),
      h('button', {type: 'button', class: 'secondary', onclick: onDelete}, '삭제')));
  }
  return nodes;
}
