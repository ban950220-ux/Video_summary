const sourceTuple = segment => [segment.id, segment.startMs, segment.endMs, segment.text];
const independentTuple = segment => [segment.chunk, segment.startMs, segment.endMs, segment.text];
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const midpoint = segment => (segment.startMs + segment.endMs) / 2;
const validWindow = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] >= 0 && value[1] > value[0];

async function digestTuples(segments, tuple) {
  const bytes = new TextEncoder().encode(JSON.stringify(segments.map(tuple)));
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function sourceBindingSha256(segments) {
  if (!Array.isArray(segments)) throw Error('저장 전사 형식을 확인할 수 없습니다.');
  return digestTuples(segments, sourceTuple);
}

export async function independentBindingSha256(segments) {
  if (!Array.isArray(segments)) throw Error('별도 자동 전사 형식을 확인할 수 없습니다.');
  return digestTuples(segments, independentTuple);
}

// The separately selected ASR file is evidence of local text only, never audio accuracy.
export async function validateContextReviewLayer(layer, source, independent) {
  const segments = source?.segments;
  if (!Array.isArray(segments) || !segments.length) throw Error('이 분석의 저장 전사가 없습니다.');
  if (!Array.isArray(independent) || !independent.length) throw Error('대조할 별도 자동 전사 원문 파일이 필요합니다.');
  if (layer?.schema !== 'offline-context-candidates/v3' || !Array.isArray(layer.candidates) || !Array.isArray(layer.semantic_review_candidates)) throw Error('검토 후보 파일 형식이 맞지 않습니다.');
  if (layer.source_mutated !== false || layer.external_search_executed !== false || layer.audio_verified !== false || layer.independent_evidence_status !== 'USER_SUPPLIED_ASR_NOT_AUDIO_VERIFIED') throw Error('미확정 로컬 검토 파일만 열 수 있습니다.');
  if (layer.source_segment_count !== segments.length || !/^[a-f0-9]{64}$/.test(layer.source_binding_sha256 || '') || layer.source_binding_sha256 !== await sourceBindingSha256(segments)) throw Error('검토 후보와 현재 저장 전사가 다릅니다.');
  if (layer.independent_segment_count !== independent.length || !/^[a-f0-9]{64}$/.test(layer.independent_binding_sha256 || '') || layer.independent_binding_sha256 !== await independentBindingSha256(independent)) throw Error('검토 후보와 별도 자동 전사 원문이 다릅니다.');
  if (layer.candidates.length > 200 || layer.semantic_review_candidates.length > 1000) throw Error('검토 후보가 너무 많습니다.');
  const duration = Math.max(...segments.map(s => s.endMs), ...independent.map(s => s.endMs));
  for (const item of layer.candidates) {
    if (item?.confirmed !== false || item.decision !== 'HUMAN_AUDIO_REVIEW_REQUIRED' || !Array.isArray(item.stored_context) || !Array.isArray(item.offline_context) || typeof item.proposed_phrase !== 'string' || !['stored_vs_offline_asr','context_inference_unverified','asr_variation'].includes(item.evidence_kind)) throw Error('확정되지 않은 검토 후보 형식이 아닙니다.');
    if (!Array.isArray(item.source_segment_ids) || item.source_segment_ids.length !== 2 || !item.source_segment_ids.every(Number.isSafeInteger) || item.source_segment_ids[0] > item.source_segment_ids[1]) throw Error('원문 구간 인덱스가 유효하지 않습니다.');
    const stored = segments.filter(s => s.id >= item.source_segment_ids[0] && s.id <= item.source_segment_ids[1]);
    const expectedStored = stored.map(s => ({ id: s.id, start_ms: s.startMs, end_ms: s.endMs, text: s.text }));
    if (!stored.length || !same(item.stored_context, expectedStored) || !same(item.time_ms, [stored[0].startMs, stored.at(-1).endMs]) || typeof item.original_phrase !== 'string' || !stored.map(s => s.text).join(' ').includes(item.original_phrase)) throw Error('후보의 원문·시각이 저장 전사와 다릅니다.');
    if (!validWindow(item.independent_window_ms) || item.independent_window_ms[0] < stored[0].startMs - 30000 || item.independent_window_ms[1] > stored.at(-1).endMs + 30000 || item.independent_window_ms[1] <= stored[0].startMs || item.independent_window_ms[0] >= stored.at(-1).endMs) throw Error('후보의 독립 전사 시각이 원문 구간과 다릅니다.');
    const expectedIndependent = independent.map((s, index) => ({ index, chunk: s.chunk, start_ms: s.startMs, end_ms: s.endMs, text: s.text })).filter(s => s.end_ms >= item.independent_window_ms[0] && s.start_ms <= item.independent_window_ms[1]);
    if (!expectedIndependent.length || !same(item.offline_context, expectedIndependent)) throw Error('후보의 독립 전사 인용이 별도 원문과 다릅니다.');
  }
  for (const item of layer.semantic_review_candidates) {
    if (item?.confirmed !== false || item.decision !== 'HUMAN_AUDIO_REVIEW_REQUIRED' || !Array.isArray(item.flags) || !item.flags.length || item.flags.some(flag => !['NEGATION_REVIEW', 'SUBJECT_REVERSAL_REVIEW', 'SUBJECT_POLARITY_REVERSAL_REVIEW'].includes(flag)) || !Array.isArray(item.source_segment_ids)) throw Error('의미 검토 후보 형식이 맞지 않습니다.');
    const start = item.start_ms, end = Math.min(start + 30000, duration);
    if (!Number.isSafeInteger(start) || start < 0 || start % 30000 !== 0 || item.end_ms !== end) throw Error('의미 검토 후보의 시각이 맞지 않습니다.');
    const stored = segments.filter(s => midpoint(s) >= start && midpoint(s) < end);
    const offline = independent.filter(s => midpoint(s) >= start && midpoint(s) < end);
    if (!same(item.source_segment_ids, stored.map(s => s.id)) || item.stored_text !== stored.map(s => s.text).join(' ') || item.offline_text !== offline.map(s => s.text).join(' ')) throw Error('의미 검토 후보의 원문 또는 독립 전사 인용이 다릅니다.');
  }
  return { candidates: layer.candidates, semantic: layer.semantic_review_candidates, evidenceStatus: 'USER_SUPPLIED_ASR_NOT_AUDIO_VERIFIED' };
}
