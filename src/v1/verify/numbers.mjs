// Number extraction and normalization for numeric evidence checks (docs/v1/NUMERIC_VERIFICATION_DESIGN.md).
// Handles digits with separators, Korean scale words (만·억·조), Korean sino numerals as spoken in
// transcripts (이십, 삼백만), basic English number words, and units (% vs %p, 원, 달러, 배 ...).

const KO_DIGIT = {영: 0, 공: 0, 일: 1, 한: 1, 이: 2, 두: 2, 삼: 3, 세: 3, 사: 4, 네: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8,
  구: 9};
const KO_SMALL = {십: 10, 백: 100, 천: 1000};
const KO_BIG = {만: 1e4, 억: 1e8, 조: 1e12};
const EN_WORDS = {zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90};
const EN_SCALE = {hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12};

export const UNIT_PATTERNS = [
  ['PERCENT_POINT', /^\s*(%p|％p|퍼센트\s*포인트|%\s*포인트|포인트|percentage points?|pp\b)/i],
  ['PERCENT', /^\s*(%|％|퍼센트|프로|percent|per cent)/i],
  ['KRW', /^\s*(원|won\b)/i],
  ['USD', /^\s*(달러|불|dollars?|usd\b)/i],
  ['TIMES', /^\s*(배|times\b|x\b)/i],
  ['YEAR', /^\s*(년도?|years?\b)/i],
  ['PEOPLE', /^\s*(명|people\b|persons?\b)/i],
  ['COUNT', /^\s*(개|곳|건|가지|위|차례|번)/],
];

// Qualifiers only count in their grammatical slot: right before the number ("약 20%", "최고 33%",
// "about 20%") or right after it, allowing a particle ("20% 이상", "40%를 넘는"). A qualifier that
// belongs to a neighbouring number ("0.8배 미만인 상장사는 2,521") is not picked up.
export const QUALIFIER_PREFIX = [
  ['APPROXIMATE', /(?:^|\s)(약|대략|거의|about|around|approximately|roughly|nearly|almost)\s*$/i],
  ['AT_MOST', /(?:^|\s)(최대|최고|up to|at most)\s*$/i],
  ['AT_LEAST', /(?:^|\s)(최소|at least)\s*$/i],
  ['MORE_THAN', /(?:^|\s)(more than|over|above|exceed(?:s|ed|ing)?|surpass(?:es|ed|ing)?)\s*$/i],
  ['LESS_THAN', /(?:^|\s)(less than|under|below)\s*$/i],
];
export const QUALIFIER_SUFFIX = [
  ['AT_LEAST', /^\s*(?:[을를이가은는의]\s*)?(이상|or more|plus)/i],
  ['AT_MOST', /^\s*(?:[을를이가은는의]\s*)?(이하|or less)/i],
  ['MORE_THAN', /^\s*(?:[을를이가은는의]\s*)?(초과|넘[는게을어었기겨]|웃도)/i],
  ['LESS_THAN', /^\s*(?:[을를이가은는의]\s*)?(미만|밑도)/i],
  ['APPROXIMATE', /^\s*(?:[을를이가은는의]\s*)?(정도|가량|쯤|안팎|내외)/i],
];

export const KIND_WORDS = [
  ['SHARE', /(비중|비율|점유율|share|proportion)/i],
  ['GROWTH', /(증가율|성장률|상승률|증가|성장|growth|increase|rise)/i],
  ['DECLINE', /(감소율|하락률|감소|하락|decline|decrease|drop)/i],
];

function parseKoreanNumeral(text) {
  let total = 0;
  let section = 0;
  let digit = null;
  for (const ch of text) {
    if (ch in KO_DIGIT) {
      digit = KO_DIGIT[ch];
    } else if (ch in KO_SMALL) {
      section += (digit ?? 1) * KO_SMALL[ch];
      digit = null;
    } else if (ch in KO_BIG) {
      total += (section + (digit ?? 0) || 1) * KO_BIG[ch];
      section = 0;
      digit = null;
    } else {
      return null;
    }
  }
  return total + section + (digit ?? 0);
}

function parseEnglishWords(words) {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word in EN_WORDS) current += EN_WORDS[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word in EN_SCALE) {
      total += (current || 1) * EN_SCALE[word];
      current = 0;
    } else if (word !== 'and') return null;
  }
  return total + current;
}

function unitAt(text, from) {
  const rest = text.slice(from, from + 24);
  for (const [unit, pattern] of UNIT_PATTERNS) {
    const m = rest.match(pattern);
    if (m) return {unit, length: m[0].length};
  }
  return {unit: 'OTHER', length: 0};
}

function scaleAfter(text, from) {
  const ko = text.slice(from).match(/^\s*(천|백)?\s*(만|억|조)?/);
  if (ko && (ko[1] || ko[2])) {
    return {scale: (ko[1] ? KO_SMALL[ko[1]] : 1) * (ko[2] ? KO_BIG[ko[2]] : 1), length: ko[0].length};
  }
  const en = text.slice(from).match(/^\s*(thousand|million|billion|trillion|k\b|bn\b)/i);
  if (!en) return {scale: 1, length: 0};
  const scale = {thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, bn: 1e9}[en[1].toLowerCase()];
  return {scale, length: en[0].length};
}

// A counter may carry one particle ("가지를") but must not start a longer word ("개혁").
const ENDS = '(?:[을를이가은는의도로와과에만](?![가-힣])|(?![가-힣]))';
const DIGITS = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const KO_RUN = new RegExp(`(?<![\\d.]\\s?)[영공일이삼사오육륙칠팔구십백천만억조]{2,}(?=\\s*(?:퍼센트|%|프로|원|달러|명|배|개|곳|건)${ENDS})`, 'g');
const EN_WORD = `(?:${[...Object.keys(EN_WORDS), ...Object.keys(EN_SCALE)].join('|')})`;
const EN_RUN = new RegExp(`(?<![\\d.]\\s?)\\b(?:${EN_WORD}(?:[\\s-]+(?:and[\\s-]+)?)?)*${EN_WORD}\\b`, 'gi');
// Korean native numbers before a counter: "세 가지", "두 차례", "일곱 가지", "열 명".
const KO_NATIVE = {한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10};
const KO_NATIVE_WORDS = '(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)';
const KO_COUNTERS = '(?:가지|차례|번|명|개|곳|살|시간|달|해|배)';
const KO_NATIVE_RUN = new RegExp(`(?<![가-힣])${KO_NATIVE_WORDS}\\s?(?=${KO_COUNTERS}${ENDS})`, 'g');

// Returns [{raw, value, unit, index, end}] in text order.
export function extractNumbers(text) {
  const out = [];
  const source = String(text ?? '');
  for (const m of source.matchAll(DIGITS)) {
    let value = Number(m[0].replace(/,/g, ''));
    let end = m.index + m[0].length;
    const {scale, length} = scaleAfter(source, end);
    value *= scale;
    end += length;
    const unit = unitAt(source, end);
    let kind = unit.unit;
    if (kind === 'YEAR' && !(value >= 1900 && value <= 2100 && scale === 1)) kind = 'DURATION';
    out.push({raw: source.slice(m.index, end + unit.length), value, unit: kind, index: m.index,
      end: end + unit.length});
  }
  for (const m of source.matchAll(KO_RUN)) {
    const value = parseKoreanNumeral(m[0]);
    if (value === null) continue;
    const unit = unitAt(source, m.index + m[0].length);
    out.push({raw: m[0], value, unit: unit.unit, index: m.index, end: m.index + m[0].length + unit.length});
  }
  for (const m of source.matchAll(EN_RUN)) {
    const value = parseEnglishWords(m[0].toLowerCase().split(/[\s-]+/));
    if (value === null) continue;
    const unit = unitAt(source, m.index + m[0].length);
    out.push({raw: m[0], value, unit: unit.unit, index: m.index, end: m.index + m[0].length + unit.length});
  }
  for (const m of source.matchAll(KO_NATIVE_RUN)) {
    const unit = unitAt(source, m.index + m[0].length);
    out.push({raw: m[0].trim(), value: KO_NATIVE[m[1]], unit: unit.unit, index: m.index,
      end: m.index + m[0].length + unit.length});
  }
  return out.sort((a, b) => a.index - b.index);
}

export function qualifierNear(text, index, end) {
  const before = text.slice(Math.max(0, index - 16), index);
  const after = text.slice(end, end + 10);
  for (const [name, pattern] of QUALIFIER_PREFIX) if (pattern.test(before)) return name;
  for (const [name, pattern] of QUALIFIER_SUFFIX) if (pattern.test(after)) return name;
  return 'UNQUALIFIED';
}

export function kindNear(text, index) {
  const window = text.slice(Math.max(0, index - 20), index);
  for (const [name, pattern] of KIND_WORDS) if (pattern.test(window)) return name;
  return null;
}

export function sameValue(a, b) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale < 1e-9;
}

// "0.254" in the source may be written "0.25" in a summary: equal at the summary's precision.
export function sameAtPrecision(sourceValue, factValue) {
  if (sameValue(sourceValue, factValue)) return true;
  const decimals = (String(factValue).split('.')[1] ?? '').length;
  return Math.abs(sourceValue - factValue) <= 0.5 * 10 ** -decimals + 1e-12 && decimals > 0;
}
