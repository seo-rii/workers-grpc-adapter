'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');

// Isolate the original-source analyzer from esbuild/codegen so the regression
// bounds graph expansion deterministically instead of timing an entire build.
const source = fs.readFileSync(path.join(__dirname, '../src/build/prebundle.cjs'), 'utf8');
const start = source.indexOf('function bindSources('), end = source.indexOf('function checkExportStability(');
assert.ok(start >= 0 && end > start);
const checkModuleLoaders = new Function('require', 'path', 'fail', source.slice(start, end) + '; return checkModuleLoaders;')(
  require, path, (code, message) => { throw Object.assign(new Error(message), { code }); });

function diamond(mode, unknown) {
  const files = new Map(), layers = 32;
  if (mode === 'ordinary') files.set('seed.mjs', 'export const ordinary = 1;');
  else files.set('seed.mjs', 'export * as native from "node:module";');
  if (mode === 'ambiguous') {
    files.set('other.mjs', 'export const native = {};');
    files.set('base.mjs', 'export * from "./seed.mjs"; export * from "./other.mjs"; export const ordinary = 1;');
  }
  for (let layer = 0; layer < layers; layer++) {
    for (const side of ['a', 'b']) files.set(`${layer}${side}.mjs`, layer === 0
      ? `export * from "./${mode === 'ambiguous' ? 'base' : 'seed'}.mjs";`
      : `export * from "./${layer - 1}a.mjs"; export * from "./${layer - 1}b.mjs";`);
  }
  // A cycle should stop expansion without hiding another reachable binding.
  files.set('cycle.mjs', `export * from "./${layers - 1}a.mjs";`);
  files.set(`${layers - 1}b.mjs`, files.get(`${layers - 1}b.mjs`) + ' export * from "./cycle.mjs";');
  const property = unknown ? '[globalThis.pick]' : mode === 'loader' ? '.native' : '.ordinary';
  files.set('wrapper.mjs', `import * as bridge from "./${layers - 1}b.mjs"; export function inspect() { return bridge${property}${mode !== 'ordinary' ? '.createRequire' : ''}; }`);
  let expansions = 0;
  // This generous polynomial bound allows per-query traversal of every edge.
  // Re-enumerating all paths of the layered diamond exceeds it quickly.
  const limit = 4 * files.size ** 2;
  const captured = [...files].map(([input, contents]) => {
    const imports = [...contents.matchAll(/from "([^\"]+)"/g)].map(([, specifier]) => ({
      kind: 'import-statement', original: specifier,
      path: specifier.startsWith('./') ? specifier.slice(2) : specifier,
      external: specifier === 'node:module',
    }));
    return { input, source: { physical: path.join(__dirname, '__loader_graph__', input), contents: Buffer.from(contents) },
      info: { format: 'esm', get imports() {
        assert.ok(++expansions <= limit, 'Static export resolution repeatedly expanded a shared subgraph');
        return imports;
      } } };
  });
  return { check: () => checkModuleLoaders(ts, captured), reads: () => expansions, limit };
}

for (const unknown of [false, true]) {
  for (const mode of ['ordinary', 'loader', 'ambiguous']) {
    test(`PREBUNDLE bounds layered ${mode} re-exports with ${unknown ? 'unknown' : 'named'} namespace access`, () => {
      const graph = diamond(mode, unknown);
      if (mode === 'loader') assert.throws(graph.check, { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
      else assert.doesNotThrow(graph.check);
      assert.ok(graph.reads() <= graph.limit);
    });
  }
}
