'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t, body) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-typescript-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, contents) => {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('build/profiles/google-static-v1.json', {
    id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [],
  });
  write('package.json', { name: 'prebundle-typescript-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  write('unbundled.cjs', 'module.exports = "outside";');
  const source = 'export {client} from "@grpc/grpc-js"; import * as nodeModule from "node:module";\n' + body;
  const entryPoint = write('wrapper.ts', source);
  write('wrapper.d.ts', 'export declare function client(): number; export declare function inspect(base: string): unknown;');
  const types = write('types.d.ts', `
    declare module "@grpc/grpc-js" { export function client(): number; }
    declare module "node:module" {
      export function createRequire(base: string): (name: string) => unknown;
      export function isBuiltin(name: string): boolean;
    }
  `);
  // Check real TypeScript expressions, rather than depending on esbuild's
  // willingness to erase assertions that the TypeScript checker rejects.
  const program = ts.createProgram([entryPoint, types], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  const native = write('native.mjs', ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return {
    projectRoot, entryPoint,
    native: async () => (await import(pathToFileURL(native).href)).inspect(entryPoint),
    build: () => api.buildGoogleWorkerPrebundle({
      projectRoot, outdir: 'out', entryPoint: 'wrapper.ts', declarationFile: 'wrapper.d.ts',
      exports: ['client', 'inspect'], typescript: ts, esbuild,
    }),
  };
}

for (const [name, wrap] of [
  ['satisfies', (expression, type) => `(${expression} satisfies ${type})`],
  ['type assertion', (expression, type) => `(<${type}>${expression})`],
]) {
  for (const [position, body] of [
    ['namespace receiver', `export function inspect(base: string) { return ${wrap('nodeModule', 'typeof nodeModule')}.createRequire(base)("./unbundled.cjs"); }`],
    ['namespace alias', `const alias = ${wrap('nodeModule', 'typeof nodeModule')}; export function inspect(base: string) { return alias.createRequire(base)("./unbundled.cjs"); }`],
    ['reflection receiver', `export function inspect(base: string) { return ${wrap('Reflect', 'typeof Reflect')}.get(nodeModule, "createRequire")(base)("./unbundled.cjs"); }`],
    ['import callback', `export function inspect(base: string) { return import("node:module").then(${wrap('((m: typeof nodeModule) => m.createRequire(base)("./unbundled.cjs"))', '(m: typeof nodeModule) => unknown')}); }`],
  ]) test(`PREBUNDLE rejects Node loaders through TypeScript ${name}: ${position}`, async t => {
    const f = fixture(t, body);
    assert.equal(await f.native(), 'outside');
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });

  for (const [position, body, expected] of [
    ['builtin property', `export function inspect(base: string) { return ${wrap('nodeModule', 'typeof nodeModule')}.isBuiltin("node:fs"); }`, true],
    ['computed builtin key', `export function inspect(base: string) { return nodeModule[${wrap('"isBuiltin"', '"isBuiltin"')}]("node:fs"); }`, true],
    ['ordinary object', `const ordinary = { createRequire: () => 23 }; export function inspect(base: string) { return ${wrap('ordinary', 'typeof ordinary')}.createRequire(); }`, 23],
  ]) test(`PREBUNDLE preserves safe TypeScript ${name}: ${position}`, async t => {
    const f = fixture(t, body);
    assert.equal(await f.native(), expected);
    const built = await f.build();
    assert.equal(require(built.bundlePath).inspect(built.bundlePath), expected);
  });
}
