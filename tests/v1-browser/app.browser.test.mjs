// Browser tests for the v1 PWA (Playwright + Chromium, mocked /api/v1 and /api/jobs).
// Run: npm run test:v1:browser   (not part of `npm test`: CI has no browser installed)
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname} from 'node:path';
import {after, before, test} from 'node:test';
import {createRequire} from 'node:module';

// Playwright is provided by the environment (global install), not a project dependency.
const {chromium} = createRequire(import.meta.url)('playwright');

const APP = new URL('../../web/app/', import.meta.url);
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const VIDEO = 'dQw4w9WgXcQ';

const segments = Array.from({length: 6}, (_, i) => ({id: i + 1, startMs: i * 60_000, endMs: i * 60_000 + 5000,
  text: `원문 문장 ${i + 1}`}));
const summary = {
  version: 'v1-summary-1', conclusion: {text: '핵심 결론 문장', segmentIds: [1], facts: []},
  keyPoints: [{text: '화자가 말한 요점', attribution: 'SPEAKER', segmentIds: [2], facts: []},
    {text: 'AI가 정리한 해석', attribution: 'INTERPRETATION', segmentIds: [3, 4], facts: []}],
  chapters: [{startSegmentId: 1, startMs: 0, endMs: 120_000, title: '도입', summary: '시작 부분'},
    {startSegmentId: 3, startMs: 120_000, endMs: 360_000, title: '본론', summary: '본론 부분'}],
  warnings: [{path: 'keyPoints[0]', code: 'NUMBER_WITHOUT_FACT'}], generation: {mode: 'single'},
};

let server;
let base;
let browser;
const state = {jobs: new Map(), polls: new Map(), writes: []};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'content-security-policy': CSP});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function mockApi(req, res, url, body) {
  if (url.pathname === '/api/v1/jobs' && req.method === 'POST') {
    const id = `00000000-0000-4000-8000-${String(state.jobs.size + 1).padStart(12, '0')}`;
    const failing = body.url.includes('failfailfai');
    state.jobs.set(id, {id, videoId: failing ? 'failfailfai' : VIDEO, url: body.url, status: 'QUEUED', failing,
      title: '<img src=x onerror="window.__xss=1">테스트 영상', createdAt: '2026-11-21T00:00:00Z'});
    return send(res, 202, {job: state.jobs.get(id), reused: false});
  }
  if (/\/(analysis|crosscheck)$/.test(url.pathname) && req.method === 'POST') {
    state.writes.push([url.pathname.split('/').pop(), req.headers['content-type']]);
    return send(res, 202, {started: true});
  }
  const match = url.pathname.match(/^\/api\/v1\/jobs\/([0-9a-f-]{36})$/);
  if (match && req.method === 'GET') {
    const job = state.jobs.get(match[1]);
    const order = ['QUEUED', 'ACQUIRING', 'SUMMARIZING'];
    const polls = (state.polls.get(job.id) ?? 0) + 1;
    state.polls.set(job.id, polls);
    job.status = polls <= 2 ? order[polls - 1] : job.failing ? 'FAILED' : 'DONE';
    if (job.status === 'FAILED') {
      Object.assign(job, {errorCode: 'TRANSCRIPT_UNAVAILABLE', attempts: [{step: 'legacy', outcome: 'none'},
        {step: 'supadata', outcome: 'no-captions'}, {step: 'gemini', outcome: 'error', code: 'PROVIDER_FAILED'}]});
    }
    const done = job.status === 'DONE';
    const verification = done ? {counts: {total: 2, verified: 1, mismatch: 1, unverifiable: 0}, items: [
      {surface: '약 20%', status: 'VERIFIED', codes: [], segmentIds: [2]},
      {surface: '1003개사', status: 'MISMATCH', codes: ['VALUE_CHANGED'], source: '103개사', segmentIds: [5]}]} : null;
    const review = done ? [{segmentId: 5, startMs: 240_000, text: '원문 문장 5', corrected: null,
      reasons: ['숫자 불일치: 1003개사']}] : [];
    return send(res, 200, {job, verification, review, transcript: done ? {source: 'supadata-native', segments,
      coverage: {complete: true, firstSec: 0, lastSec: 305}} : null, summary: done ? summary : null});
  }
  if (url.pathname === '/api/v1/jobs' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    return send(res, 200, {jobs: [...state.jobs.values()].filter(j => j.title.includes(q))});
  }
  if (url.pathname === '/api/jobs') {
    return send(res, 200, {jobs: [{id: 'old-1', video_id: VIDEO, title: '예전 보고서',
      created_at: '2026-10-20T00:00:00Z'}]});
  }
  if (url.pathname === '/api/v1/legacy-sources') {
    return send(res, 200, {sources: [{legacyJobId: 'old-2', title: null, videoId: null, sourceType: 'audio',
      createdAt: '2026-10-14T00:00:00Z', bytes: 116145}]});
  }
  if (url.pathname === '/api/v1/usage') {
    return send(res, 200, {usage: {day: '2026-11-21', items: [{key: 'geminiCalls', used: 9, limit: 200}]},
      keys: {supadata: true, gemini: true, groq: false}});
  }
  if (url.pathname === '/api/v1/health') return send(res, 200, {paidApiAllowed: false, liveProvidersEnabled: true});
  return send(res, 404, {error: {code: 'NOT_FOUND'}});
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (url.pathname.startsWith('/api/')) return mockApi(req, res, url, raw ? JSON.parse(raw) : {});
      if (!url.pathname.startsWith('/v1/')) return send(res, 404, 'not found', 'text/plain');
      const file = url.pathname.slice(4) || 'index.html';
      try {
        send(res, 200, readFileSync(new URL(file, APP)), TYPES[extname(file)] ?? 'application/octet-stream');
      } catch {
        send(res, 404, 'not found', 'text/plain');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function page(viewport) {
  const context = await browser.newContext({viewport});
  const p = await context.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => m.type() === 'error' && p.errors.push(m.text()));
  await p.goto(`${base}/v1/`);
  return p;
}

for (const [name, viewport] of [['desktop', {width: 1280, height: 900}], ['phone 390px', {width: 390, height: 844}]]) {
  test(`${name}: URL -> progress -> result with chapters, attribution and evidence`, async () => {
    const p = await page(viewport);
    await p.fill('#url-form input', `https://youtu.be/${VIDEO}`);
    await p.click('#url-form button');
    await p.waitForSelector('.steps li.now');
    await p.waitForSelector('#chapters', {timeout: 15_000});
    assert.equal(await p.textContent('#conclusion p:nth-of-type(2)'), '핵심 결론 문장');
    assert.deepEqual(await p.$$eval('#points .badge', els => els.map(e => e.textContent)), ['화자', 'AI 해석']);
    const times = await p.$$eval('#chapters a.time', els => els.map(e => [e.textContent, e.href]));
    assert.deepEqual(times, [['00:00', `https://www.youtube.com/watch?v=${VIDEO}&t=0s`],
      ['02:00', `https://www.youtube.com/watch?v=${VIDEO}&t=120s`]]);
    await p.click('#points [data-segment="3"]');
    assert.match(await p.textContent('#points .quote'), /02:00 원문 문장 3/);
    assert.match(await p.textContent('h1'), /<img src=x/);
    assert.equal(await p.evaluate(() => window.__xss), undefined);
    assert.match(await p.textContent('main'), /YouTube 기존 자막/);
    assert.deepEqual(await p.$$eval('#glance .badge', els => els.map(e => e.textContent)), ['숫자 ⚠ 1/2', '검토할 곳 1']);
    assert.equal(await p.$eval('#verification', el => el.open), false);
    await p.click('#glance [data-open="verification"]');
    assert.equal(await p.$eval('#verification', el => el.open), true);
    await p.click('#analysis > summary');
    assert.match(await p.textContent('#verification'), /숫자 2개: 원문 확인 1 · 불일치 1/);
    assert.equal(await p.textContent('#analyze'), '상세 분석 만들기');
    assert.match(await p.textContent('#review'), /검토할 곳 \(1\).*04:00 #5 숫자 불일치: 1003개사/s);
    assert.equal(await p.inputValue('#review textarea'), '원문 문장 5');
    state.writes.length = 0;
    await p.click('#crosscheck-run');
    await p.waitForFunction(() => document.querySelector('#analyze') && !document.querySelector('#analyze').disabled);
    await p.click('#analyze');
    await p.waitForTimeout(300);
    assert.deepEqual(state.writes, [['crosscheck', 'application/json'], ['analysis', 'application/json']]);
    assert.match(await p.textContent('#verification .verify-MISMATCH'), /1003개사 — 값이 원문과 다름 \(원문: 103개사\)/);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'no horizontal scroll');
    assert.deepEqual(p.errors, []);
    // Optional visual check: V1_SCREENSHOT_DIR=/some/dir npm run test:v1:browser
    if (process.env.V1_SCREENSHOT_DIR) {
      await p.screenshot({path: `${process.env.V1_SCREENSHOT_DIR}/result-${viewport.width}.png`, fullPage: true});
    }
    await p.context().close();
  });
}

test('failed job explains why and offers the upload path', async () => {
  const p = await page({width: 390, height: 844});
  await p.fill('#url-form input', 'https://youtu.be/failfailfai');
  await p.click('#url-form button');
  await p.waitForSelector('#failure', {timeout: 15_000});
  const text = await p.textContent('#failure');
  assert.match(text, /자막 파일\(SRT\/VTT\/TXT\)을 올리거나/);
  assert.match(text, /YouTube 기존 자막: 자막 없음/);
  assert.match(text, /Gemini 영상 전사: 실패 \(PROVIDER_FAILED\)/);
  await p.context().close();
});

test('library search, previous reports and settings', async () => {
  const p = await page({width: 390, height: 844});
  await p.click('a[data-tab="library"]');
  await p.waitForSelector('#library-list li a');
  assert.ok((await p.$$('#library-list li a')).length >= 1);
  await p.fill('input[type=search]', '없는제목');
  await p.waitForFunction(() => document.querySelector('#library-list').textContent.includes('저장된 요약이 없습니다'));
  await p.click('a[data-tab="legacy"]');
  await p.waitForSelector('#legacy-list a');
  assert.match(await p.textContent('#legacy-list'), /예전 보고서/);
  assert.match(await p.textContent('#legacy-sources'), /MP3 업로드 전사.*113KB/);
  assert.equal(await p.$eval('#legacy-sources button', b => b.textContent), '이 전사로 v1 요약');
  await p.click('a[data-tab="settings"]');
  await p.waitForSelector('#usage');
  assert.match(await p.textContent('#keys'), /groq: 없음/);
  assert.match(await p.textContent('#usage'), /Gemini 호출: 9 \/ 200/);
  assert.equal(await p.$eval('#usage .meter span', el => el.style.width), '4.5%');
  assert.match(await p.textContent('main'), /유료 API 차단됨/);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('PWA: manifest with credentials, icons of the right size, service worker registered', async () => {
  const p = await page({width: 390, height: 844});
  assert.equal(await p.$eval('link[rel=manifest]', el => el.crossOrigin), 'use-credentials');
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', APP), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/v1/');
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(icon.src, APP));
    const [w, hgt] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.equal(`${w}x${hgt}`, icon.sizes, icon.src);
    const res = await p.request.get(`${base}/v1/${icon.src}`);
    assert.equal(res.status(), 200);
  }
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
  await p.waitForFunction(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  assert.equal(await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope), `${base}/v1/`);
  await p.context().close();
});

test('a link shared from the YouTube app is filled in but not started', async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const p = await context.newPage();
  const before = state.jobs.size;
  const shared = encodeURIComponent(`https://youtu.be/${VIDEO}?si=abc`);
  await p.goto(`${base}/v1/?title=${encodeURIComponent('영상 제목')}&text=${shared}`);
  await p.waitForSelector('#url-form input');
  assert.equal(await p.inputValue('#url-form input[type=url]'), `https://youtu.be/${VIDEO}?si=abc`);
  assert.equal(new URL(p.url()).search, '');
  assert.equal(state.jobs.size, before);
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', APP), 'utf8'));
  assert.deepEqual(manifest.share_target, {action: '/v1/', method: 'GET', params: {title: 'title', text: 'text',
    url: 'url'}});
  await context.close();
});
