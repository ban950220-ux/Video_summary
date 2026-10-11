// Offline release-readiness gate. Does NOT contact Cloudflare, reveal credentials, or deploy.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..');
const read=p=>readFileSync(resolve(base,p),'utf8');
const config=read('wrangler.toml');
const schema=read('schema.sql');
const checks=[
  ['secure-worker-entry',/^main\s*=\s*"src\/site-worker\.mjs"/m.test(config)],
  ['static-assets-through-auth',/run_worker_first\s*=\s*true/m.test(config)],
  ['free-api-explicitly-enabled',/^ENABLE_LIVE_FREE\s*=\s*"true"/m.test(config)],
  ['paid-api-default-off',/^ALLOW_PAID_API\s*=\s*"false"/m.test(config)],
  ['D1-schema-jobs',/CREATE TABLE IF NOT EXISTS jobs\s*\(/m.test(schema)],
  ['D1-schema-encrypted-credentials',/CREATE TABLE IF NOT EXISTS provider_credentials\s*\(/m.test(schema)],
  ['D1-binding-provisioned',/^\[\[d1_databases\]\]/m.test(config)&&/^database_id\s*=\s*"[0-9a-f-]{36}"/m.test(config)],
  ['protected-site-route-declared',/^workers_dev\s*=\s*true/m.test(config)||/^\[\[routes\]\]/m.test(config)||/^routes\s*=/m.test(config)],
  ['access-app-aud-configured',/^ACCESS_AUD\s*=\s*"[^"\s]{12,}"/m.test(config)],
  ['access-team-domain-configured',/^ACCESS_TEAM_DOMAIN\s*=\s*"https:\/\/[a-z0-9-]+\.cloudflareaccess\.com"/m.test(config)],
  ['owner-email-in-secret-store-verified-online',false],
  ['protected-by-cloudflare-access-verified-online',false],
  ['master-key-worker-secret-verified-online',false],
  ['actual-D1-read-write-verified-online',false]
];
console.log('YouTube AI Analyzer release gate — OFFLINE advisory only');
for(const [name,ok] of checks) console.log(`${ok?'PASS ':'BLOCK'} ${name}`);
if(checks.some(([,ok])=>!ok)){
  console.log('BLOCKED_DEPLOY: offline checks cannot prove Access, D1, secret configuration or privacy. Switch to Work Cloud Browser to finish account steps. No deploy attempted.');
  process.exitCode=2;
}
