// Regression cases for numeric evidence checks (NUMERIC_VERIFICATION_DESIGN.md 5). Several mirror the
// earlier synthetic package (비중→증가율, 약 20%→20% 이상) and real cases seen in production.
import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyFact, verifySummary} from '../../src/v1/verify/facts.mjs';
import {extractNumbers} from '../../src/v1/verify/numbers.mjs';

const byId = texts => new Map(texts.map((text, i) => [i + 1, {id: i + 1, text}]));
const fact = over => ({surface: '약 20%', value: 20, unit: 'PERCENT', qualifier: 'APPROXIMATE', kind: 'SHARE',
  segmentIds: [1], quote: '매출 비중은 약 20%', ...over});
const check = (source, f, itemText = '') => verifyFact(fact(f), itemText, byId([source]));

test('number extraction: digits, Korean scales and numerals, English words, units', () => {
  const get = t => extractNumbers(t).map(n => [n.value, n.unit]);
  assert.deepEqual(get('1.2억 원'), [[120_000_000, 'KRW']]);
  assert.deepEqual(get('5천억 원'), [[500_000_000_000, 'KRW']]);
  assert.deepEqual(get('증가율은 20%p'), [[20, 'PERCENT_POINT']]);
  assert.deepEqual(get('이십 퍼센트 정도'), [[20, 'PERCENT']]);
  assert.deepEqual(get('삼백만 원을'), [[3_000_000, 'KRW']]);
  assert.deepEqual(get('이 일곱 가지를 확인'), [[7, 'COUNT']]);
  assert.deepEqual(get('twenty percent'), [[20, 'PERCENT']]);
  assert.deepEqual(get('1.5 million dollars'), [[1_500_000, 'USD']]);
  assert.deepEqual(get('2024년에 3,500명'), [[2024, 'YEAR'], [3500, 'PEOPLE']]);
  assert.deepEqual(get('구조개혁과 임금 구조 개편'), []);
  assert.deepEqual(get('1만 3,000원에 사들여'), [[13_000, 'KRW']]);
  assert.deepEqual(get('1억 2천만 원'), [[120_000_000, 'KRW']]);
  assert.deepEqual(get('3조 원, 5명'), [[3e12, 'KRW'], [5, 'PEOPLE']]);
});

test('same fact, same meaning is verified (incl. spoken numerals and English source)', () => {
  assert.equal(check('매출 비중은 약 20%다', {}).status, 'VERIFIED');
  assert.equal(check('매출 비중이 한 이십 퍼센트 정도 되고요', {quote: '이십 퍼센트 정도'}).status, 'VERIFIED');
  assert.equal(check('revenue share is about twenty percent', {quote: 'about twenty percent'}).status, 'VERIFIED');
  assert.equal(check('평균 PBR은 약 0.254배', {surface: '약 0.25배', value: 0.25, unit: 'TIMES', kind: null,
    quote: '약 0.254배'}).status, 'VERIFIED');
});

test('meaning changes are caught: metric kind, qualifier, value, unit, scale', () => {
  assert.deepEqual(check('매출 비중은 약 20%다', {surface: '증가율 약 20%', kind: 'GROWTH'}).codes, ['KIND_CHANGED']);
  assert.deepEqual(check('매출 비중은 약 20%다', {surface: '20% 이상', qualifier: 'AT_LEAST'}).codes,
    ['QUALIFIER_CHANGED']);
  assert.deepEqual(check('매출 비중은 20% 이상이다', {surface: '약 20%'}).codes, ['QUALIFIER_CHANGED']);
  assert.deepEqual(check('매출 비중은 약 20%다', {surface: '약 25%', value: 25}).codes, ['VALUE_CHANGED']);
  assert.deepEqual(check('금리를 2%p 올렸다', {surface: '2%', value: 2, kind: null, qualifier: 'EXACT'}).codes,
    ['UNIT_CHANGED']);
  assert.deepEqual(check('예산은 1.2억 원', {surface: '1.2만 원', value: 12_000, unit: 'KRW', kind: null,
    qualifier: 'EXACT'}).codes, ['VALUE_CHANGED']);
  assert.deepEqual(check('상장사는 2,521개사 중 103개사였습니다', {surface: '1003개사', value: 1003, unit: 'COUNT',
    kind: null, qualifier: 'EXACT'}).codes, ['VALUE_CHANGED']);
});

test('qualifiers belong to their own number; "최고" wording on both sides is the same bound', () => {
  assert.equal(check('PBR 0.8배 미만인 상장사는 2,521개사 중', {surface: '2,521개사', value: 2521, unit: 'COUNT',
    kind: null, qualifier: 'EXACT'}).status, 'VERIFIED');
  assert.equal(check('지방세를 포함하면 최고 33%입니다', {surface: '33%', value: 33, kind: null, qualifier: 'EXACT'},
    '최고세율을 33%로 낮춘다').status, 'VERIFIED');
  assert.equal(check('배당성향이 40%를 넘을 때', {surface: '40% 초과', value: 40, kind: null,
    qualifier: 'MORE_THAN'}).status, 'VERIFIED');
});

test('missing evidence is never shown as verified', () => {
  assert.deepEqual(check('관련 없는 문장', {quote: '없는 인용'}).codes, ['QUOTE_NOT_FOUND']);
  const summary = {
    conclusion: {text: '매출이 30% 늘었다', segmentIds: [1], facts: []},
    keyPoints: [{text: '매출 비중은 약 20%', segmentIds: [1], facts: [fact({})]}],
    chapters: [{title: 't', summary: '세 가지 이유', facts: []}],
  };
  const result = verifySummary(summary, {segments: [{id: 1, text: '매출 비중은 약 20%다'}]});
  assert.deepEqual(result.items.map(i => [i.path, i.status, i.codes.join()]), [
    ['conclusion', 'UNVERIFIABLE', 'NO_EVIDENCE'],
    ['keyPoints[0]', 'VERIFIED', ''],
  ]);
  assert.deepEqual(result.counts, {total: 2, verified: 1, mismatch: 0, unverifiable: 1});
  assert.equal(result.judgedRatio, 0.5);
});
