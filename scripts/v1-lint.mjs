// Style and syntax checks for v1 code (see docs/v1/DESIGN.md 4.4).
// - every file passes `node --check`
// - at most 400 lines per file and 120 characters per line
// Usage: node scripts/v1-lint.mjs [extra files or directories...]
import {spawnSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MAX_LINES = 400;
const MAX_COLUMNS = 120;
const DEFAULT_TARGETS = ['src/v1', 'tests/v1', 'web/app', 'scripts/v1-lint.mjs'];
const EXTENSIONS = /\.(?:mjs|js)$/;

function collect(target, out) {
  let info;
  try {
    info = statSync(target);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    for (const name of readdirSync(target).sort()) collect(join(target, name), out);
  } else if (EXTENSIONS.test(target)) {
    out.push(target);
  }
}

export function lintText(text) {
  const problems = [];
  const lines = text.split('\n');
  const count = text.endsWith('\n') ? lines.length - 1 : lines.length;
  if (count > MAX_LINES) problems.push(`${count} lines (max ${MAX_LINES})`);
  lines.forEach((line, index) => {
    if (line.length > MAX_COLUMNS) problems.push(`line ${index + 1}: ${line.length} chars (max ${MAX_COLUMNS})`);
  });
  return problems;
}

function main(args) {
  const targets = (args.length ? args : DEFAULT_TARGETS).map(target => join(root, target));
  const files = [];
  for (const target of targets) collect(target, files);
  let failures = 0;
  for (const file of files) {
    const name = relative(root, file);
    const problems = lintText(readFileSync(file, 'utf8'));
    const syntax = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
    if (syntax.status !== 0) problems.push(`syntax error: ${syntax.stderr.trim().split('\n')[0]}`);
    for (const problem of problems) console.error(`${name}: ${problem}`);
    if (problems.length) failures += 1;
  }
  console.log(`v1 lint: ${files.length} files checked, ${failures} with problems`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
