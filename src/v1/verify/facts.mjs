// Deterministic numeric evidence check of a saved summary against its transcript (no model calls).
// Design: docs/v1/NUMERIC_VERIFICATION_DESIGN.md. Each number gets VERIFIED / MISMATCH / UNVERIFIABLE.
import {extractNumbers, KIND_WORDS, kindNear, qualifierNear, sameAtPrecision} from './numbers.mjs';

export const VERIFY_VERSION = 'v1-numbers-1';
const BOUNDS = new Set(['AT_LEAST', 'MORE_THAN', 'AT_MOST', 'LESS_THAN']);
const PERCENTS = new Set(['PERCENT', 'PERCENT_POINT']);
const CURRENCIES = new Set(['KRW', 'USD', 'OTHER_CURRENCY']);

const squash = text => String(text ?? '').toLowerCase().replace(/[\s.,·…'"“”‘’!?()[\]{}~\-–—:;]/g, '');

function evidenceText(fact, byId) {
  const ids = new Set();
  for (const id of fact.segmentIds) [id - 1, id, id + 1].forEach(n => byId.has(n) && ids.add(n));
  return [...ids].sort((a, b) => a - b).map(id => byId.get(id).text).join(' ');
}

function factKind(fact, itemText) {
  const label = `${fact.kind ?? ''} ${fact.surface ?? ''}`;
  for (const [name, pattern] of KIND_WORDS) if (pattern.test(label) || new RegExp(name).test(label)) return name;
  const at = itemText.indexOf(fact.surface ?? '\u0000');
  return at >= 0 ? kindNear(itemText, at) : null;
}

function unitConflict(factUnit, sourceUnit) {
  if (PERCENTS.has(factUnit) && PERCENTS.has(sourceUnit)) return factUnit !== sourceUnit;
  if (CURRENCIES.has(factUnit) && CURRENCIES.has(sourceUnit)) return factUnit !== sourceUnit;
  return false;
}

function qualifierConflict(factQ, sourceQ) {
  if (factQ === sourceQ) return false;
  if (BOUNDS.has(factQ) || BOUNDS.has(sourceQ)) return true; // "약 20%" -> "20% 이상" and the reverse
  return factQ === 'EXACT' && sourceQ === 'APPROXIMATE';
}

function shownQualifier(fact, itemText) {
  const surface = String(fact.surface ?? '');
  const inSurface = extractNumbers(surface).find(n => sameAtPrecision(n.value, fact.value));
  if (!inSurface) return null;
  const at = itemText.indexOf(surface);
  const q = at >= 0 ? qualifierNear(itemText, at + inSurface.index, at + inSurface.end)
    : qualifierNear(surface, inSurface.index, inSurface.end);
  return q === 'UNQUALIFIED' ? null : q;
}

export function verifyFact(fact, itemText, byId) {
  const source = evidenceText(fact, byId);
  const quoteFound = Boolean(fact.quote) && squash(source).includes(squash(fact.quote));
  const numbers = extractNumbers(source);
  const matches = numbers.filter(n => sameAtPrecision(n.value, fact.value));
  const base = {surface: fact.surface, value: fact.value, unit: fact.unit, segmentIds: fact.segmentIds, quoteFound};
  if (!matches.length) {
    const code = quoteFound ? 'NO_NUMBER_IN_SOURCE' : 'QUOTE_NOT_FOUND';
    if (!numbers.length) return {...base, status: 'UNVERIFIABLE', codes: [code]};
    return {...base, status: 'MISMATCH', codes: ['VALUE_CHANGED'], sourceValues: numbers.map(n => n.raw).slice(0, 5)};
  }
  const match = matches.find(n => n.unit === fact.unit) ?? matches[0];
  const codes = [];
  if (unitConflict(fact.unit, match.unit)) codes.push('UNIT_CHANGED');
  const sourceQ = qualifierNear(source, match.index, match.end);
  // Compare with what the reader actually sees: "최고 33%" in the summary text carries its qualifier even
  // when the model labelled the fact EXACT.
  const summaryQ = shownQualifier(fact, itemText) ?? fact.qualifier;
  // "최고 33%" vs "최고세율을 33%로": the upper bound is stated by a nearby word on both sides.
  const top = (text, at) => /(최고|최대|top|maximum|highest)/i.test(text.slice(Math.max(0, at - 24), at));
  const itemAt = itemText.indexOf(String(fact.surface ?? ''));
  const bothTop = (summaryQ === 'AT_MOST' || sourceQ === 'AT_MOST') && top(source, match.index)
    && (summaryQ === 'AT_MOST' || (itemAt >= 0 && top(itemText, itemAt + 1)));
  if (!bothTop && qualifierConflict(summaryQ, sourceQ)) codes.push('QUALIFIER_CHANGED');
  const sourceKind = kindNear(source, match.index);
  const summaryKind = factKind(fact, itemText);
  if (sourceKind && summaryKind && sourceKind !== summaryKind) codes.push('KIND_CHANGED');
  return {...base, status: codes.length ? 'MISMATCH' : 'VERIFIED', codes, source: match.raw, sourceQualifier: sourceQ};
}

// Numbers written in the summary text that no fact accounts for. Years and small counts
// ("세 가지", "3곳") are left out to avoid noise.
function uncovered(itemText, facts) {
  return extractNumbers(itemText)
    .filter(n => n.unit !== 'YEAR' && !(['COUNT', 'OTHER'].includes(n.unit) && n.value <= 20))
    .filter(n => !facts.some(f => sameAtPrecision(n.value, f.value)))
    .map(n => ({surface: n.raw, value: n.value, unit: n.unit, segmentIds: [], status: 'UNVERIFIABLE',
      codes: ['NO_EVIDENCE']}));
}

export function verifySummary(summary, transcript) {
  const byId = new Map((transcript?.segments ?? []).map(s => [s.id, s]));
  const containers = [
    ['conclusion', summary.conclusion],
    ...summary.keyPoints.map((p, i) => [`keyPoints[${i}]`, p]),
    ...summary.chapters.map((c, i) => [`chapters[${i}]`, c]),
    ...(summary.analysis?.items ?? []).map((a, i) => [`analysis[${i}]`, a]),
  ];
  const items = [];
  for (const [path, item] of containers) {
    const text = item.text ?? item.summary ?? '';
    for (const fact of item.facts ?? []) items.push({path, ...verifyFact(fact, text, byId)});
    for (const extra of uncovered(text, item.facts ?? [])) items.push({path, ...extra});
  }
  const count = status => items.filter(i => i.status === status).length;
  const counts = {total: items.length, verified: count('VERIFIED'), mismatch: count('MISMATCH'),
    unverifiable: count('UNVERIFIABLE')};
  const judged = counts.verified + counts.mismatch;
  const judgedRatio = items.length ? Number((judged / items.length).toFixed(3)) : null;
  return {version: VERIFY_VERSION, counts, judgedRatio,
    items};
}
