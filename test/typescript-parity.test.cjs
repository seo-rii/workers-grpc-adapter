'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareBuilds, parityCompilers } = require('../scripts/typescript-parity.cjs');

const key = character => character.repeat(64);
function build(version, cacheKey, registry, { text = 'shared', artifact = 'minified-a' } = {}) {
  return {
    version,
    manifest: { cacheKey, transformer: { version: 1, typescriptVersion: version }, registrySha256: registry,
      transformed: [{ path: 'sdk/index.js', replacementSha256: key('9') }],
      artifactSha256: key('8'), artifacts: { 'index.cjs': { sha256: key('7'), bytes: artifact.length }, 'index.d.ts': { sha256: key('6'), bytes: 1 } } },
    texts: { 'index.d.ts': `${text} ${cacheKey} ${registry}`, 'index.cjs': artifact },
  };
}

test('PARITY accepts outputs that differ only in compiler-bound identities', () => {
  const result = compareBuilds(build('5.8.3', key('a'), key('b')), build('6.0.3', key('c'), key('d'), { artifact: 'minified-bb' }),
    { minified: ['index.cjs'] });
  assert.deepEqual(result, { compilers: ['5.8.3', '6.0.3'], comparedFiles: ['index.d.ts'], minifiedFiles: ['index.cjs'], compilerBoundIdentities: 2 });
});

test('PARITY rejects any other byte or manifest difference', () => {
  const left = build('5.8.3', key('a'), key('b'));
  assert.throws(() => compareBuilds(left, build('6.0.3', key('c'), key('d'), { text: 'changed' }), { minified: ['index.cjs'] }),
    { code: 'WGA_TYPESCRIPT_PARITY', message: /index\.d\.ts/ });
  assert.throws(() => compareBuilds(left, build('6.0.3', key('c'), key('d'), { artifact: 'minified-bb' })),
    { code: 'WGA_TYPESCRIPT_PARITY', message: /index\.cjs/ }, 'minified output is compared unless explicitly excluded');
  const changedManifest = build('6.0.3', key('c'), key('d'));
  changedManifest.manifest.transformed[0].path = 'sdk/other.js';
  assert.throws(() => compareBuilds(left, changedManifest, { minified: ['index.cjs'] }), { code: 'WGA_TYPESCRIPT_PARITY', message: /manifest/ });
  assert.throws(() => compareBuilds(left, build('6.0.3', key('a'), key('b')), { minified: ['index.cjs'] }),
    { message: /compiler-bound identities/ }, 'a compiler change must change the cache identity');
  const mislabeled = build('6.0.3', key('c'), key('d'));
  mislabeled.manifest.transformer.typescriptVersion = '5.8.3';
  assert.throws(() => compareBuilds(left, mislabeled, { minified: ['index.cjs'] }), { message: /manifest compiler version/ });
  assert.throws(() => compareBuilds(left, build('5.8.3', key('c'), key('d')), { minified: ['index.cjs'] }),
    { message: /manifest compiler version/ }, 'both builds must use different compilers');
});

test('PARITY resolves the installed TypeScript 5 and 6 compilers', () => {
  const { current, next } = parityCompilers();
  assert.match(current.version, /^5\./);
  assert.match(next.version, /^6\./);
});
