'use strict';
// Compare SDK profile build outputs produced by the two supported TypeScript
// majors. A profile cache key intentionally includes the compiler version, and
// generated registry modules are named after a hash that includes that key.
// After replacing exactly those compiler-bound identities, every unminified
// byte and every remaining manifest field must be equal. Minified output is
// excluded from the byte comparison: esbuild chooses minified identifier names
// from character frequency, which the compiler-bound strings change.
const { isDeepStrictEqual } = require('node:util');

function parityError(message) {
  return Object.assign(new Error(`WGA_TYPESCRIPT_PARITY: ${message}`), { code: 'WGA_TYPESCRIPT_PARITY' });
}

function parityCompilers() {
  const current = require('typescript');
  const next = require('typescript-6');
  if (!/^5\.(?:[89]|[1-9]\d)\./.test(current.version) || !/^6\.\d+\./.test(next.version)) {
    throw parityError(`expected TypeScript 5.8+ and 6.x, found ${current.version} and ${next.version}`);
  }
  return { current, next };
}

// Compiler-bound strings: the profile cache key and the generated registry hash.
// The recorded compiler version is checked separately. Longest first, so that
// no value is split by a shorter replacement.
function compilerIdentities(manifest) {
  const values = new Set();
  (function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'cacheKey' || key === 'registrySha256') && typeof child === 'string' && /^[a-f0-9]{64}$/.test(child)) values.add(child);
      else visit(child);
    }
  })(manifest);
  if (values.size === 0) throw parityError('manifest has no compiler-bound identity');
  return [...values].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function normalizeText(text, identities) {
  let normalized = text;
  for (const value of identities) normalized = normalized.split(value).join('<compiler-identity>');
  return normalized;
}

// Remove fields that are hashes of compiler-bound text. The text itself is
// compared separately after normalization, so these hashes add no information.
function normalizeManifest(manifest, identities, comparedArtifacts = [], minifiedArtifacts = []) {
  const copy = JSON.parse(normalizeText(JSON.stringify(manifest), identities));
  if (!copy.transformer || typeof copy.transformer.typescriptVersion !== 'string') {
    throw parityError('manifest does not record the compiler version');
  }
  copy.transformer.typescriptVersion = '<compiler-version>';
  for (const item of copy.transformed ?? []) delete item.replacementSha256;
  if (copy.artifacts) {
    delete copy.artifactSha256;
    for (const name of comparedArtifacts) delete copy.artifacts[name]?.sha256;
    for (const name of minifiedArtifacts) {
      if (!copy.artifacts[name]) throw parityError(`manifest has no minified artifact ${name}`);
      delete copy.artifacts[name].sha256;
      delete copy.artifacts[name].bytes;
    }
  }
  return copy;
}

// Each build is { version, manifest, texts: { name: string } }. Text entries are
// compared after normalization, except `minified` names, which must exist in
// both builds but are compared only through the remaining manifest fields.
function compareBuilds(current, next, { minified = [] } = {}) {
  const left = compilerIdentities(current.manifest), right = compilerIdentities(next.manifest);
  const names = Object.keys(current.texts).sort();
  if (!isDeepStrictEqual(names, Object.keys(next.texts).sort())) throw parityError('different output files');
  if (minified.some(name => !names.includes(name))) throw parityError('a minified artifact is missing');
  const compared = names.filter(name => !minified.includes(name));
  const differences = [];
  for (const name of compared) {
    if (normalizeText(current.texts[name], left) !== normalizeText(next.texts[name], right)) differences.push(name);
  }
  if (current.version === next.version || current.manifest.transformer?.typescriptVersion !== current.version
    || next.manifest.transformer?.typescriptVersion !== next.version) differences.push('manifest compiler version');
  if (left.length !== right.length || left.some(value => right.includes(value))) differences.push('manifest compiler-bound identities');
  if (!isDeepStrictEqual(normalizeManifest(current.manifest, left, compared, minified),
    normalizeManifest(next.manifest, right, compared, minified))) differences.push('manifest');
  if (differences.length) throw parityError(`${current.version} and ${next.version} outputs differ: ${differences.join(', ')}`);
  return { compilers: [current.version, next.version], comparedFiles: compared, minifiedFiles: [...minified].sort(),
    compilerBoundIdentities: left.length };
}

module.exports = { parityCompilers, compilerIdentities, normalizeText, normalizeManifest, compareBuilds };
