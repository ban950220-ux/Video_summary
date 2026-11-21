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

function uncertainLine(transcript) {
  const flagged = (transcript?.segments ?? []).filter(s => s.flags?.length);
  if (!flagged.length) return null;
  return h('p', {class: 'warn'}, `전사가 불확실한 구간 ${flagged.length}개 (환각·낮은 확신·반복 등). 근거 구간에 ⚠로 표시됩니다.`);
}

function steps(status) {
  if (status === 'WAITING_PC') return h('p', {class: 'warn'}, 'PC 실행기 대기 중입니다. PC에서 실행기를 켜면 전사가 시작됩니다.');
  if (status === 'PC_RUNNING') return h('p', {class: 'muted'}, 'PC 실행기가 음성을 받아 전사하고 있습니다…');
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
      const unsure = seg?.flags?.length ? h('span', {class: 'warn'}, ` ⚠ 전사 불확실(${seg.flags.join(', ')})`) : null;
      box.replaceChildren(seg ? h('p', {class: 'quote'}, unsure, h('a', {href: watchUrl(videoId, seg.startMs),
        target: '_blank', rel: 'noopener'}, clock(seg.startMs)), ' ', seg.text) : h('p', {class: 'muted'}, '구간 없음'));
    }}, `#${id}`)));
  return [chips, box];
}

function point(p, transcript, videoId) {
  const speaker = p.attribution === 'SPEAKER';
  return h('li', {},
    h('span', {class: `badge ${speaker ? 'speaker' : 'ai'}`}, speaker ? '화자' : 'AI 해석'),
    p.synthesized ? h('span', {class: 'badge ai'}, '여러 구간 종합') : null, ' ', p.text,
    evidence(p.segmentIds, transcript, videoId));
}

const CODE_TEXT = {VALUE_CHANGED: '값이 원문과 다름', UNIT_CHANGED: '단위가 원문과 다름',
  QUALIFIER_CHANGED: '약·이상·미만 같은 한정어가 다름', KIND_CHANGED: '지표(비중·증가율 등)가 다름',
  QUOTE_NOT_FOUND: '근거 인용을 원문에서 못 찾음', NO_NUMBER_IN_SOURCE: '근거 구간에서 숫자를 못 읽음',
  NO_EVIDENCE: '원문 근거 없음'};
const MARK = {VERIFIED: '✓', MISMATCH: '⚠', UNVERIFIABLE: '?'};

function crossCheckBlock(cross, canRun, onCrossCheck) {
  const box = h('div', {id: 'crosscheck'}, h('h3', {}, '영상 다시 듣기 교차 확인'));
  if (cross?.status === 'RUNNING') {
    box.append(h('p', {class: 'muted'}, '숫자가 나온 구간을 다시 듣는 중입니다… 화면이 자동으로 갱신됩니다.'));
    return box;
  }
  if (cross?.status === 'DONE') {
    const {counts} = cross;
    box.append(h('p', {}, `숫자 ${counts.total}개: 교차 확인 ${counts.confirmed} · 다르게 들림 ${counts.differs} · `
      + `미확인 ${counts.notChecked}`));
    if (cross.sameEngineAsTranscript) {
      box.append(h('p', {class: 'muted'}, '전사와 같은 엔진(Gemini)으로 다시 들은 결과라 독립적인 확인은 아닙니다.'));
    }
    const differs = cross.items.filter(item => item.result === 'DIFFERS');
    if (differs.length) {
      box.append(h('ul', {class: 'points'}, differs.map(item => h('li', {class: 'verify-MISMATCH'},
        h('span', {class: 'badge'}, '⚠'), ' ', h('strong', {}, item.surface ?? String(item.value)),
        ` — 다시 들은 값: ${item.heardValues?.join(', ') || '숫자 없음'}`,
        item.heardText ? h('p', {class: 'quote'}, item.heardText) : null))));
    }
    return box;
  }
  box.append(h('p', {class: 'muted'}, '전사 자체가 숫자를 잘못 받아 적었는지 확인합니다. 숫자가 나온 구간만 Gemini가 영상에서 '
    + '다시 듣습니다(무료 한도 사용).'));
  if (cross?.status === 'FAILED') {
    box.append(h('p', {class: 'warn'}, `지난 확인 실패: ${cross.code} — ${cross.detail ?? ''}`));
  }
  if (canRun) {
    box.append(h('button', {type: 'button', id: 'crosscheck-run', class: 'secondary', onclick: event => {
      event.target.disabled = true;
      onCrossCheck();
    }}, '교차 확인 실행'));
  } else {
    box.append(h('p', {class: 'muted'}, '영상 주소가 연결된 작업에서만 실행할 수 있습니다.'));
  }
  return box;
}

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

function reviewCard(review, videoId, {onCorrect, onResummarize}) {
  const corrected = review.filter(item => item.corrected).length;
  const card = h('section', {class: 'card', id: 'review'}, h('h2', {}, `검토할 곳 (${review.length})`),
    h('p', {class: 'muted'}, '전사가 불확실하거나 숫자가 맞지 않은 구간입니다. 영상을 듣고 고치면 원본은 그대로 두고 교정본을 '
      + '따로 저장합니다.'));
  card.append(h('ul', {class: 'points'}, review.map(item => {
    const input = h('textarea', {rows: 2, 'aria-label': `구간 ${item.segmentId} 교정`}, item.corrected ?? item.text);
    const href = watchUrl(videoId, item.startMs);
    return h('li', {'data-review': item.segmentId},
      href ? h('a', {href, target: '_blank', rel: 'noopener'}, clock(item.startMs)) : clock(item.startMs),
      ` #${item.segmentId} `, h('span', {class: 'warn'}, item.reasons.join(' · ')),
      item.corrected ? h('p', {class: 'muted'}, `원본: ${item.text}`) : null, input,
      h('button', {type: 'button', class: 'secondary', onclick: () => onCorrect(item.segmentId, input.value)},
        '교정 저장'));
  })));
  if (corrected) {
    card.append(h('button', {type: 'button', id: 'resummarize', onclick: event => {
      event.target.disabled = true;
      onResummarize();
    }}, `교정 ${corrected}곳 반영해 새로 요약`));
  }
  return card;
}

const TYPE_TEXT = {CLAIM: '주장', CAUSE: '인과', CONTEXT: '맥락', UNCERTAINTY: '불확실성·예측'};

function analysisCard(analysis, transcript, videoId, onAnalyze) {
  const card = h('section', {class: 'card', id: 'analysis'}, h('h2', {}, '상세 분석'));
  if (!analysis || analysis.status === 'FAILED') {
    card.append(h('p', {class: 'muted'}, '주장·인과·맥락·불확실성을 근거 구간과 함께 정리합니다. 무료 한도에서 요약과 비슷한 수의 '
      + 'Gemini 호출을 씁니다.'));
    if (analysis?.status === 'FAILED') {
      card.append(h('p', {class: 'warn'}, `지난 분석 실패: ${analysis.code} — ${analysis.detail ?? ''}`));
    }
    card.append(h('button', {type: 'button', id: 'analyze', onclick: event => {
      event.target.disabled = true;
      onAnalyze();
    }}, analysis ? '상세 분석 다시 만들기' : '상세 분석 만들기'));
    return card;
  }
  if (analysis.status === 'RUNNING') {
    card.append(h('p', {class: 'muted'}, '분석 중입니다… 화면이 자동으로 갱신됩니다.'));
    return card;
  }
  for (const type of Object.keys(TYPE_TEXT)) {
    const items = analysis.items.filter(item => item.type === type);
    if (!items.length) continue;
    card.append(h('h3', {}, TYPE_TEXT[type]),
      h('ul', {class: 'points'}, items.map(p => point(p, transcript, videoId))));
  }
  return card;
}

export function renderResult({job, transcript, summary, verification, review = []}, handlers) {
  const {onDelete, onAnalyze, onCrossCheck} = handlers;
  const nodes = [h('section', {class: 'card'},
    h('h1', {}, job.title ?? job.videoId ?? '영상 요약'),
    h('p', {class: 'muted'}, date(job.createdAt), job.url ? ' · ' : '',
      job.url ? h('a', {href: job.url, target: '_blank', rel: 'noopener'}, 'YouTube에서 보기') : ''),
    h('div', {class: 'row'}, h('span', {class: `badge status-${job.status}`}, job.status)),
    job.options?.correctedFrom ? h('p', {}, h('span', {class: 'badge speaker'}, '수동 교정 반영'),
      ` ${job.options.correctedSegments}개 구간 · `, h('a', {href: `#job/${job.options.correctedFrom}`}, '교정 전 요약 보기'))
      : null,
    job.status === 'DONE' || job.status === 'FAILED' ? null : steps(job.status),
    transcript ? h('p', {class: 'muted'}, `전사 출처: ${SOURCE[transcript.source] ?? transcript.source} · `
      + `범위: ${coverageText(transcript)}`) : null,
    uncertainLine(transcript))];

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
    nodes.push(analysisCard(summary.analysis, transcript, job.videoId, onAnalyze));
    if (verification?.counts.total) {
      const card = verificationCard(verification, transcript, job.videoId);
      card.append(crossCheckBlock(summary.crossCheck, Boolean(job.url), onCrossCheck));
      nodes.push(card);
    }
    if (review.length) nodes.push(reviewCard(review, job.videoId, handlers));
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
