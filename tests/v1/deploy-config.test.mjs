// Guards the v1 deploy config against drifting from the existing production target.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';
import {handleV1Site, V1_PAGE_CSP, withV1PageHeaders} from '../../src/v1/entry.mjs';
import {buildAssets} from '../../scripts/v1-build-assets.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const value = (toml, key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const section = (toml, name) => toml.split(`[${name}]`)[1]?.split(/\n\[/)[0] ?? '';

test('v1 config targets the same Worker, D1, vars and observability as wrangler.toml', () => {
  const v07 = read('wrangler.toml');
  const v1 = read('wrangler.v1.toml');
  for (const key of ['name', 'compatibility_date', 'database_name', 'database_id']) {
    assert.equal(value(v1, key), value(v07, key), key);
  }
  // Like the production deploy template: existing dashboard vars are kept, never overwritten.
  const vars = section(v1, 'vars');
  for (const key of ['ENABLE_LIVE_FREE', 'ALLOW_PAID_API', 'SITE_DEPLOYED', 'ACCESS_AUD']) {
    assert.doesNotMatch(vars, new RegExp(`^${key}\\s*=`, 'm'), key);
  }
  assert.equal(value(vars, 'V1_LIVE_PROVIDERS'), 'true');
  for (const name of ['observability', 'observability.logs', 'observability.traces', 'previews.vars']) {
    assert.equal(section(v1, name).trim(), section(v07, name).trim(), name);
  }
  assert.match(v1, /^keep_vars = true$/m);
  assert.match(v1, /^preview_urls = false$/m);
});

test('v1 config wires the v1 entry, combined assets and the Workflow class', () => {
  const v1 = read('wrangler.v1.toml');
  assert.equal(value(v1, 'main'), 'src/v1/workflow-entry.mjs');
  assert.equal(value(v1, 'directory'), './dist/v1-assets');
  assert.match(v1, /\[\[workflows\]\]\nname = "video-summary-v1"\nbinding = "SUMMARY_WORKFLOW"\n/);
  assert.match(v1, /class_name = "SummaryWorkflow"/);
  assert.match(read('src/v1/workflow-entry.mjs'), /export class SummaryWorkflow extends WorkflowEntrypoint/);
  assert.match(read('src/v1/pipeline.mjs'), /SUMMARY_WORKFLOW|runSummaryJob/);
  assert.match(read('src/v1/router.mjs'), /env\.SUMMARY_WORKFLOW/);
});

test('asset build keeps every production file at / and adds the v1 app at /v1/', () => {
  const {out} = buildAssets();
  const review = JSON.parse(read('production/dede9fb3/DEPLOYMENT-REVIEW.json'));
  for (const {file, sha256} of review.contents.filter(c => c.file.startsWith('assets/'))) {
    const bytes = readFileSync(`${out}/${file.slice('assets/'.length)}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, file);
  }
  for (const file of ['index.html', 'app.js', 'manifest.webmanifest', 'sw.js', 'icons/icon-512.png']) {
    assert.ok(existsSync(`${out}/v1/${file}`), file);
  }
});

test('/v1 pages: redirect, Access required, CSP allows manifest and worker', async () => {
  const redirect = await handleV1Site(new Request('https://s.test/v1'), {});
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), 'https://s.test/v1/');
  const env = {ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-123456789012',
    ACCESS_OWNER_EMAIL: 'o@x.io'};
  assert.equal((await handleV1Site(new Request('https://s.test/v1/'), env)).status, 401);
  const page = withV1PageHeaders(new Response('ok', {headers: {'content-security-policy': "default-src 'none'"}}),
    '/v1/sw.js');
  assert.equal(page.headers.get('content-security-policy'), V1_PAGE_CSP);
  assert.match(V1_PAGE_CSP, /manifest-src 'self'/);
  assert.equal(page.headers.get('service-worker-allowed'), '/v1/');
  const denied = withV1PageHeaders(new Response('no', {status: 401}), '/v1/');
  assert.equal(denied.headers.get('content-security-policy'), null);
});

test('production bundle is byte-identical to the deployed version dede9fb3', () => {
  const review = JSON.parse(read('production/dede9fb3/DEPLOYMENT-REVIEW.json'));
  const receipt = JSON.parse(read('production/dede9fb3/PRODUCTION-RECEIPT.json'));
  assert.equal(receipt.versionId, 'dede9fb3-38d2-49b8-ad67-32b4ed51937a');
  for (const {file, bytes, sha256} of review.contents) {
    const body = readFileSync(new URL(`../../production/dede9fb3/${file}`, import.meta.url));
    assert.equal(body.length, bytes, file);
    assert.equal(createHash('sha256').update(body).digest('hex'), sha256, file);
  }
  assert.ok(!existsSync(new URL('../../production/dede9fb3/.wrangler', import.meta.url)), 'no location cache');
});

test('non-v1 paths go to the production handler with its own Access check', async () => {
  const env = {ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-123456789012',
    ACCESS_OWNER_EMAIL: 'o@x.io'};
  for (const path of ['/', '/api/text-review-summaries', '/api/jobs']) {
    const response = await handleV1Site(new Request(`https://s.test${path}`), env);
    assert.equal(response.status, 401, path);
  }
  assert.equal((await handleV1Site(new Request('https://s.test/'), {})).status, 503);
});

test('deploy workflow never prints account identity into public logs', () => {
  const workflow = read('.github/workflows/deploy-v1.yml');
  assert.doesNotMatch(workflow, /wrangler\s+whoami/);
  assert.doesNotMatch(workflow, /echo\s+"?\$\{?\{?\s*secrets\./);
  assert.match(workflow, /if: inputs\.mode == 'deploy'/);
});

test('deploy output is not streamed to the public log', () => {
  const workflow = read('.github/workflows/deploy-v1.yml');
  assert.doesNotMatch(workflow, /wrangler deploy -c wrangler\.v1\.toml \| tee/);
  assert.match(workflow, /wrangler deploy -c wrangler\.v1\.toml > deploy\.log 2>&1/);
});

test('CPU measurement prints aggregates only and never the account ID or raw response', async () => {
  const {measure, report, safeError} = await import('../../scripts/v1-measure-cpu.mjs');
  const account = 'acc0123456789abcdef0123456789abcd';
  const row = (status, max, requests = 3) => ({dimensions: {datetimeFifteenMinutes: '2026-11-25T01:15:00Z', status},
    sum: {requests, errors: 0, subrequests: 7}, quantiles: {cpuTimeP50: 3000, cpuTimeP75: 9300, cpuTimeP99: 98_100},
    max: {cpuTime: max}});
  let sent;
  const fetchFn = async (url, init) => {
    sent = {url, init};
    return new Response(JSON.stringify({data: {viewer: {accounts: [{workersInvocationsAdaptive: [
      row('success', 130_900), row('exceededResources', 2_050_000, 4)]}]}}}));
  };
  const result = await measure({token: 'tok-secret', account, hours: 2, fetchFn, now: Date.UTC(2026, 10, 25, 2)});
  assert.equal(JSON.parse(sent.init.body).variables.since, '2026-11-25T00:00:00.000Z');
  assert.equal(result.exceededResources, 4);
  assert.equal(result.maxCpuMs, 2050);
  const text = report(result, 2);
  assert.match(text, /11-25 01:15 \| success \| 3 \| 7 \| 3 \| 9\.3 \| 98\.1 \| 130\.9 {2}<-- over/);
  assert.doesNotMatch(text, new RegExp(`${account}|tok-secret`));
  assert.equal(safeError(`account ${account} not allowed`, account), 'account <account> not allowed');
  const denied = async () => new Response(JSON.stringify({errors: [{message: `not authorized for ${account}`}]}));
  await assert.rejects(measure({token: 't', account, fetchFn: denied}), error => !error.message.includes(account)
    && /not authorized/.test(error.message));
  const workflow = read('.github/workflows/measure-cpu.yml');
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /wrangler|whoami|echo .*CLOUDFLARE_ACCOUNT_ID/);
});
