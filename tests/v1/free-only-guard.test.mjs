// Static guard: v1 source must not contain paid paths (docs/v1/DESIGN.md 3-1).
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const srcDir = fileURLToPath(new URL('../../src/v1/', import.meta.url));

function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.mjs') ? [path] : [];
  });
}

test('no Supadata auto/generate mode anywhere in v1 source', () => {
  for (const file of sources(srcDir)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /set\(\s*'mode'\s*,\s*'(?!native')/, file);
    assert.doesNotMatch(text, /mode=(auto|generate)/, file);
  }
});

test('only Flash-family Gemini model IDs appear in v1 source', () => {
  for (const file of sources(srcDir)) {
    const ids = readFileSync(file, 'utf8').match(/gemini-\d[\w.-]*/g) ?? [];
    for (const id of ids) assert.match(id, /^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-\d{3})?$/, `${file}: ${id}`);
  }
});

test('paid API cannot be enabled by configuration', () => {
  assert.match(readFileSync(join(srcDir, 'config.mjs'), 'utf8'), /paidApiAllowed:\s*false,/);
  for (const file of sources(srcDir)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /paidApiAllowed\s*[:=]\s*(true|env\.|!)/, file);
  }
});
