// Guards the v1 deploy config against drifting from the existing production target.
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import {handleV1Site, V1_PAGE_CSP, withV1PageHeaders} from '../../src/v1/entry.mjs';
import {buildAssets} from '../../scripts/v1-build-assets.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const value = (toml, key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const section = (toml, name) => toml.split(`[${name}]`)[1]?.split(/\n\[/)[0] ?? '';

test('v1 config targets the same Worker, D1, vars and observability as wrangler.toml', () => {
  const v07 = read('wrangler.toml');
  const v1 = read('wrangler.v1.toml');
  for (const key of ['name', 'compatibility_date', 'database_name', 'database_id', 'ENABLE_LIVE_FREE',
    'ALLOW_PAID_API', 'SITE_DEPLOYED']) {
    assert.equal(value(v1, key), value(v07, key), key);
  }
  for (const name of ['observability', 'observability.logs', 'observability.traces', 'previews.vars']) {
    assert.equal(section(v1, name).trim(), section(v07, name).trim(), name);
  }
  assert.equal(value(v1, 'ALLOW_PAID_API'), 'false');
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

test('asset build keeps every v0.7 file at / and adds the v1 app at /v1/', () => {
  const {out} = buildAssets();
  for (const file of readdirSync(new URL('../../web/site/', import.meta.url))) {
    assert.equal(readFileSync(`${out}/${file}`, 'utf8'), read(`web/site/${file}`), file);
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
