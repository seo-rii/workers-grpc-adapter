'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-directive-prologue-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('build/profiles/google-static-v1.json', { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1,
    revision: 1, packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] });
  write('package.json', { name: 'directive-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'const state = {}; exports.client = () => state;');
  write('wrapper.d.ts', 'export declare function client(): object; export declare function inspect(load?: boolean): Promise<unknown>;');
  return { projectRoot, write, build: () => require(path.join(projectRoot, 'build/prebundle.cjs')).buildGoogleWorkerPrebundle({
    projectRoot, outdir: 'out', entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports: ['client', 'inspect'], typescript: ts, esbuild,
  }) };
}

for (const [name, prologue, strict, bridge = 'cjs', target = 'mjs'] of [
  ['strict directive', '"use strict";\n', true],
  ['leading and trailing comments', '// before\n/* before directive */ "use strict" /* after directive */; // trailing\n', true],
  ['multiple directives with ASI', '"custom directive"\n/* middle */ "use strict"\n"last directive" // trailing\n', true],
  ['hashbang and ASI', '#!/usr/bin/env node\n// after hashbang\n"use strict"\n', true],
  ['CRLF hashbang and comments', '#!/usr/bin/env node\r\n/* before */ "use strict";\r\n', true],
  ['escaped directive before strict', '"use\\x20strict"; "use strict"\n', true],
  ['sloppy module', '// no directives\n', false],
  ['custom directive only', '"custom directive"\n', false],
  ['escaped strict text', '"use\\x20strict";\n', false],
  ['parenthesized strict text', '("use strict");\n', false],
  ['strict text after another statement', 'void 0; "use strict";\n', false],
  ['strict CommonJS target control', '"use strict";\n', true, 'cjs', 'cjs'],
  ['implicit ESM with dynamic CommonJS', '// implicit strictness\n', true, 'mjs', 'cjs'],
]) test(`PREBUNDLE dynamic import preserves ${name}`, async t => {
  const f = fixture(t);
  f.write('state.cjs', 'module.exports = {loads: 0};');
  f.write('leaf.mjs', 'import state from "./state.cjs"; state.loads++; export const flag = 7;');
  f.write('leaf.cjs', 'const state = require("./state.cjs"); state.loads++; exports.flag = 7;');
  f.write(`bridge.${bridge}`, prologue + (bridge === 'mjs' ? 'import state from "./state.cjs";' : 'const state = require("./state.cjs");') + `
    let initial = 'none';
    try { Object.freeze({x: 1}).x = 2; } catch (error) { initial = error.name; }
    ${bridge === 'mjs' ? 'export async function inspect(load = true)' : 'exports.inspect = async function(load = true)'} {
      const value = load ? await import('./leaf.${target}') : {flag: 0};
      function unbound() { return this; }
      function argument(value) { arguments[0] = 2; return value; }
      let frozen = 'none';
      try { Object.freeze({x: 1}).x = 2; } catch (error) { frozen = error.name; }
      return {initial, frozen, unbound: unbound() === undefined, argument: argument(1), loads: state.loads, flag: value.flag};
    };
  `);
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export {inspect} from './bridge.${bridge}';`);
  const expected = load => ({initial: strict ? 'TypeError' : 'none', frozen: strict ? 'TypeError' : 'none',
    unbound: strict, argument: strict ? 1 : 2, loads: load ? 1 : 0, flag: load ? 7 : 0});
  const native = await import(pathToFileURL(entry).href);
  assert.deepEqual(await native.inspect(false), expected(false));
  assert.deepEqual(await native.inspect(), expected(true));
  const built = await f.build();
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  assert.strictEqual(cjs.client(), esm.client());
  assert.deepEqual(await cjs.inspect(false), expected(false));
  assert.deepEqual(await esm.inspect(false), expected(false));
  assert.deepEqual(await cjs.inspect(), expected(true));
  assert.deepEqual(await esm.inspect(), expected(true), 'the captured dynamic module is still lazy and initializes once');
});
