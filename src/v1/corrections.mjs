// Human corrections of transcript segments. The original transcript stays as it was; corrections are
// kept separately and applied on top when a corrected summary is requested.
export function applyCorrections(transcript, corrections) {
  const ids = Object.keys(corrections ?? {});
  if (!ids.length) return transcript;
  return {...transcript, segments: transcript.segments.map(segment => (corrections[segment.id]
    ? {...segment, text: corrections[segment.id], flags: [...new Set([...(segment.flags ?? []), 'CORRECTED'])]}
    : segment))};
}

// Segments worth a human look: engine uncertainty flags, numeric mismatches, numbers heard differently.
export function reviewList(transcript, verification, crossCheck, corrections = {}) {
  const reasons = new Map();
  const add = (id, reason) => {
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id).add(reason);
  };
  for (const segment of transcript?.segments ?? []) {
    for (const flag of segment.flags ?? []) if (flag !== 'CORRECTED') add(segment.id, `전사 불확실(${flag})`);
  }
  for (const item of verification?.items ?? []) {
    if (item.status === 'MISMATCH') for (const id of item.segmentIds ?? []) add(id, `숫자 불일치: ${item.surface}`);
  }
  for (const item of crossCheck?.items ?? []) {
    if (item.result === 'DIFFERS') {
      const heard = item.heardValues?.join(', ') || '숫자 없음';
      for (const id of item.segmentIds ?? []) add(id, `다시 들은 값이 다름: ${item.surface} → ${heard}`);
    }
  }
  for (const id of Object.keys(corrections)) add(Number(id), '교정함');
  const byId = new Map((transcript?.segments ?? []).map(s => [s.id, s]));
  return [...reasons.entries()].filter(([id]) => byId.has(id)).sort((a, b) => a[0] - b[0]).slice(0, 100)
    .map(([id, set]) => ({segmentId: id, startMs: byId.get(id).startMs, text: byId.get(id).text,
      corrected: corrections[id] ?? null, reasons: [...set]}));
}
