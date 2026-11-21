// Builds the static asset folder for the v1 deploy: the unchanged v0.7 site at / and the v1 app at /v1/.
// Output: dist/v1-assets/ (referenced by wrangler.v1.toml). Usage: node scripts/v1-build-assets.mjs
import {cpSync, existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}dist/v1-assets`;

export function buildAssets() {
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  cpSync(`${root}web/site`, out, {recursive: true});
  if (existsSync(`${out}/v1`)) throw new Error('web/site already has a v1/ folder; refusing to overwrite');
  cpSync(`${root}web/app`, `${out}/v1`, {recursive: true});
  return {out, site: readdirSync(`${root}web/site`).length, app: readdirSync(`${root}web/app`).length};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = buildAssets();
  console.log(`v1 assets: ${result.site} v0.7 entries at /, ${result.app} v1 entries at /v1/ -> ${result.out}`);
}
