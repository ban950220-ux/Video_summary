// Prompts for the summary engine. Output language is Korean; quotes stay in the source language.
import {formatClock} from '../transcript.mjs';

export const SYSTEM_RULES = [
  '너는 영상 전사문을 한국어로 정확하게 요약하는 도우미다. 다음 규칙을 반드시 지킨다.',
  '1. 전사문에 있는 내용만 쓴다. 외부 지식이나 추측을 사실처럼 쓰지 않는다.',
  '2. 모든 항목에 근거가 되는 전사 구간 번호(#번호)를 segmentIds에 넣는다.',
  '3. 화자가 실제로 말한 내용은 attribution=SPEAKER, 너의 해석·정리는 INTERPRETATION으로 구분한다.',
  '   근거 구간이 없는 해석은 쓰지 않는다.',
  '4. 숫자·단위·비교 기준·조건을 바꾸지 않는다. "약 20%"를 "20% 이상"으로, "비중"을 "증가율"로 바꾸지 않는다.',
  '5. 문장에 숫자가 있으면 facts에 넣는다: surface(요약문에 쓴 표기), value(숫자 값, 억·만은 환산),',
  '   unit, qualifier(약=APPROXIMATE, 이상=AT_LEAST, 초과=MORE_THAN, 이하=AT_MOST, 미만=LESS_THAN,',
  '   정확한 값=EXACT, 표현 없음=UNQUALIFIED), segmentIds, quote(전사문에서 그대로 복사한 짧은 원문, 번역 금지).',
  '   %와 %p(퍼센트포인트)는 다른 단위다.',
  '6. 조건·예외·반론·위험 언급을 빠뜨리지 않는다. 서로 다른 구간의 수치나 발언을 하나로 합치지 않는다.',
  '7. 가정이나 예측을 사실로 바꾸지 않는다. 화자가 단정하지 않은 것은 단정하지 않는다.',
  '8. JSON만 출력한다.',
].join('\n');

function header({title, chunk, total}) {
  const lines = [];
  if (title) lines.push(`영상 제목: ${title}`);
  if (chunk) {
    lines.push(`이 부분: 전체 ${total}개 중 ${chunk.index + 1}번째, 구간 #${chunk.fromId}~#${chunk.toId}`
      + ` (${formatClock(chunk.startMs)}~${formatClock(chunk.endMs)})`);
  }
  return lines.join('\n');
}

export function segmentLines(segments) {
  return segments.map(s => `[#${s.id} ${formatClock(s.startMs)}] ${s.text}`).join('\n');
}

export function mapPrompt({title, chunk, total}) {
  return [
    header({title, chunk, total}),
    '',
    '아래 전사 부분을 요약하라.',
    '- points: 이 부분의 중요한 내용 3~10개 (한 항목 한두 문장).',
    '- chapters: 이 부분 안에서 주제가 바뀌는 지점 1~4개. startSegmentId는 그 주제가 시작되는 구간 번호,',
    '  title은 짧은 제목, summary는 한두 문장 요약.',
    `- segmentIds와 startSegmentId는 #${chunk.fromId}~#${chunk.toId} 범위만 쓴다.`,
    '',
    '전사문:',
    segmentLines(chunk.segments),
  ].join('\n');
}

export function reducePrompt({title, partials, firstId, lastId}) {
  const body = partials.map((p, i) => `## 부분 ${i + 1} (#${p.fromId}~#${p.toId})\n${JSON.stringify(p.output)}`);
  return [
    header({title}),
    '',
    '아래는 한 영상을 순서대로 나눠 요약한 결과다. 이를 바탕으로 영상 전체 결과를 만들어라.',
    '- conclusion: 영상의 핵심 결론 1~3문장.',
    '- keyPoints: 영상 전체에서 가장 중요한 내용 5~10개. 각 항목의 segmentIds·facts는 부분 요약의 것을 그대로 쓴다.',
    '- chapters: 시간순 챕터 3~20개. startSegmentId는 부분 요약의 chapters에서 고르고 오름차순으로 쓴다.',
    `- 모든 구간 번호는 #${firstId}~#${lastId} 안에서 부분 요약에 나온 것만 쓴다. 새 숫자를 만들지 않는다.`,
    '',
    ...body,
  ].join('\n');
}

export function singlePrompt({title, segments}) {
  return [
    header({title}),
    '',
    '아래 전사문 전체를 요약하라.',
    '- conclusion: 영상의 핵심 결론 1~3문장.',
    '- keyPoints: 가장 중요한 내용 3~10개.',
    '- chapters: 시간순 챕터 1~12개. startSegmentId는 주제가 시작되는 구간 번호, 오름차순.',
    '',
    '전사문:',
    segmentLines(segments),
  ].join('\n');
}
