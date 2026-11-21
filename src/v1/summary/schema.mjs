// Summary output schemas (Gemini responseSchema format) and validators.
// Validators turn any shape problem into PROVIDER_INVALID_OUTPUT so the retry policy applies.
import {AppError} from '../errors.mjs';

export const ATTRIBUTION = Object.freeze(['SPEAKER', 'INTERPRETATION']);
export const UNITS = Object.freeze(['PERCENT', 'PERCENT_POINT', 'KRW', 'USD', 'OTHER_CURRENCY', 'COUNT', 'PEOPLE',
  'TIMES', 'YEAR', 'DURATION', 'OTHER']);
export const QUALIFIERS = Object.freeze(['EXACT', 'APPROXIMATE', 'AT_LEAST', 'MORE_THAN', 'AT_MOST', 'LESS_THAN',
  'UNQUALIFIED']);

const S = {type: 'STRING'};
const IDS = {type: 'ARRAY', items: {type: 'INTEGER'}};
const FACT = {
  type: 'OBJECT',
  properties: {
    surface: S, value: {type: 'NUMBER'}, unit: {type: 'STRING', enum: [...UNITS]},
    qualifier: {type: 'STRING', enum: [...QUALIFIERS]}, kind: S, subject: S, segmentIds: IDS, quote: S,
  },
  required: ['surface', 'value', 'unit', 'qualifier', 'segmentIds', 'quote'],
};
const FACTS = {type: 'ARRAY', items: FACT};
const POINT = {
  type: 'OBJECT',
  properties: {text: S, attribution: {type: 'STRING', enum: [...ATTRIBUTION]}, segmentIds: IDS, facts: FACTS},
  required: ['text', 'attribution', 'segmentIds', 'facts'],
};
const CHAPTER = {
  type: 'OBJECT',
  properties: {startSegmentId: {type: 'INTEGER'}, title: S, summary: S, facts: FACTS},
  required: ['startSegmentId', 'title', 'summary', 'facts'],
};

export const MAP_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {points: {type: 'ARRAY', items: POINT}, chapters: {type: 'ARRAY', items: CHAPTER}},
  required: ['points', 'chapters'],
});

export const FINAL_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    conclusion: {type: 'OBJECT', properties: {text: S, segmentIds: IDS, facts: FACTS},
      required: ['text', 'segmentIds', 'facts']},
    keyPoints: {type: 'ARRAY', items: POINT},
    chapters: {type: 'ARRAY', items: CHAPTER},
  },
  required: ['conclusion', 'keyPoints', 'chapters'],
});

// Gemini schema -> standard JSON Schema (for providers that take JSON Schema, e.g. Groq).
export function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'type' ? String(value).toLowerCase() : toJsonSchema(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

function bad(path, why) {
  return new AppError('PROVIDER_INVALID_OUTPUT', `${path}: ${why}`);
}

function text(value, path, max) {
  if (typeof value !== 'string' || !value.trim()) throw bad(path, 'empty text');
  if (value.length > max) throw bad(path, `text longer than ${max}`);
  return value.trim();
}

function ids(value, path, allowed, {required = true} = {}) {
  if (!Array.isArray(value)) throw bad(path, 'segmentIds not array');
  if (required && value.length === 0) throw bad(path, 'no evidence segment');
  if (value.length > 50) throw bad(path, 'too many segmentIds');
  for (const id of value) {
    if (!Number.isSafeInteger(id) || !allowed(id)) throw bad(path, `unknown segment #${id}`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function facts(value, path, allowed) {
  if (!Array.isArray(value)) throw bad(path, 'facts not array');
  if (value.length > 20) throw bad(path, 'too many facts');
  return value.map((fact, i) => {
    const p = `${path}[${i}]`;
    if (!fact || typeof fact !== 'object') throw bad(p, 'fact not object');
    if (!Number.isFinite(fact.value)) throw bad(p, 'value not number');
    if (!UNITS.includes(fact.unit)) throw bad(p, 'unit');
    if (!QUALIFIERS.includes(fact.qualifier)) throw bad(p, 'qualifier');
    return {
      surface: text(fact.surface, `${p}.surface`, 80),
      value: fact.value,
      unit: fact.unit,
      qualifier: fact.qualifier,
      kind: typeof fact.kind === 'string' ? fact.kind.slice(0, 40) : null,
      subject: typeof fact.subject === 'string' ? fact.subject.slice(0, 80) : null,
      segmentIds: ids(fact.segmentIds, `${p}.segmentIds`, allowed),
      quote: text(fact.quote, `${p}.quote`, 300),
    };
  });
}

function point(value, path, allowed) {
  if (!value || typeof value !== 'object') throw bad(path, 'not object');
  if (!ATTRIBUTION.includes(value.attribution)) throw bad(path, 'attribution');
  return {
    text: text(value.text, `${path}.text`, 600),
    attribution: value.attribution,
    segmentIds: ids(value.segmentIds, `${path}.segmentIds`, allowed),
    facts: facts(value.facts, `${path}.facts`, allowed),
  };
}

function chapters(value, path, allowed, {min, max}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw bad(path, `need ${min}-${max}`);
  const out = value.map((chapter, i) => {
    const p = `${path}[${i}]`;
    if (!chapter || typeof chapter !== 'object') throw bad(p, 'not object');
    const startSegmentId = chapter.startSegmentId;
    if (!Number.isSafeInteger(startSegmentId) || !allowed(startSegmentId)) throw bad(p, 'startSegmentId');
    return {
      startSegmentId,
      title: text(chapter.title, `${p}.title`, 120),
      summary: text(chapter.summary, `${p}.summary`, 800),
      facts: facts(chapter.facts, `${p}.facts`, allowed),
    };
  });
  out.forEach((c, i) => {
    if (i && c.startSegmentId <= out[i - 1].startSegmentId) throw bad(path, 'chapters not ascending');
  });
  return out;
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(path, 'not object');
  return value;
}

export function validateMapOutput(raw, {fromId, toId}) {
  const allowed = id => id >= fromId && id <= toId;
  const value = object(raw, 'map');
  if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > 15) throw bad('points', '1-15');
  return {
    points: value.points.map((p, i) => point(p, `points[${i}]`, allowed)),
    chapters: chapters(value.chapters, 'chapters', allowed, {min: 1, max: 6}),
  };
}

export function validateFinal(raw, {segmentIds}) {
  const known = new Set(segmentIds);
  const allowed = id => known.has(id);
  const value = object(raw, 'final');
  const conclusion = object(value.conclusion, 'conclusion');
  if (!Array.isArray(value.keyPoints) || value.keyPoints.length < 3 || value.keyPoints.length > 12) {
    throw bad('keyPoints', '3-12');
  }
  return {
    conclusion: {
      text: text(conclusion.text, 'conclusion.text', 800),
      segmentIds: ids(conclusion.segmentIds, 'conclusion.segmentIds', allowed),
      facts: facts(conclusion.facts, 'conclusion.facts', allowed),
    },
    keyPoints: value.keyPoints.map((p, i) => point(p, `keyPoints[${i}]`, allowed)),
    chapters: chapters(value.chapters, 'chapters', allowed, {min: 1, max: 40}),
  };
}

// Stage 3 only records numbers that lack a matching fact; stage 8 turns this into checks.
export function numberWarnings(summary) {
  const warnings = [];
  const check = (item, path) => {
    const digits = (item.text ?? item.summary ?? '').match(/\d+(?:[.,]\d+)*/g) ?? [];
    if (digits.length && item.facts.length === 0) warnings.push({path, code: 'NUMBER_WITHOUT_FACT'});
  };
  check(summary.conclusion, 'conclusion');
  summary.keyPoints.forEach((p, i) => check(p, `keyPoints[${i}]`));
  summary.chapters.forEach((c, i) => check(c, `chapters[${i}]`));
  return warnings;
}
