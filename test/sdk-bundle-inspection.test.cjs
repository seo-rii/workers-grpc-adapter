'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { inspectSDKBundle, executableImports } = require('../scripts/sdk-bundle-inspection.cjs');

function fixture(t, name = 'workers-grpc-adapter') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-bundle-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/transport-alias');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.writeFileSync(path.join(directory, 'index.js'), 'exports.Client = class {};');
  const input = 'node_modules/transport-alias/index.js';
  const metafile = { inputs: { [input]: { bytes: 25, imports: [] } }, outputs: {
    'worker.js': { bytes: 25, inputs: { [input]: { bytesInOutput: 25 } }, imports: [] },
  } };
  return { root, input, metafile, inspect(script = 'export default {};') {
    return inspectSDKBundle({ stages: [{ name: 'sdk-preset', metafile, workingDirectory: root }], script });
  } };
}

test('SDK bundle inspection accepts adapter alias provenance and separately inventories auth network builtins', t => {
  const f = fixture(t);
  const result = f.inspect('import http from "node:http"; import tls from "node:tls"; export default { http, tls };');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.nativeGrpcPackages, []);
  assert.deepEqual(result.nonGrpcNetworkBuiltins, ['node:http', 'node:tls']);
  assert.deepEqual(result.packages, [{ name: 'workers-grpc-adapter', version: '1.0.0', inputs: 1 }]);
  assert.equal(result.stages[0].bundledInputs, 1);
});

test('SDK bundle inspection rejects bundled native grpc-js even under an unrelated npm alias', t => {
  const f = fixture(t, '@grpc/grpc-js');
  assert.throws(() => f.inspect(), error => error.code === 'WGA_NATIVE_GRPC_BUNDLE' && error.inspection.nativeGrpcPackages[0] === '@grpc/grpc-js');
});

test('SDK bundle inspection rejects native transport edges from both esbuild metadata stages', t => {
  for (const stage of ['input', 'output']) for (const specifier of ['@grpc/grpc-js', '@grpc/grpc-js/build/src/client', 'grpc', 'http2', 'node:http2']) {
    const f = fixture(t);
    const imports = stage === 'input' ? f.metafile.inputs[f.input].imports : f.metafile.outputs['worker.js'].imports;
    imports.push({ path: specifier, kind: 'require-call', external: true });
    assert.throws(() => f.inspect(), { code: 'WGA_NATIVE_GRPC_BUNDLE' }, `${stage}:${specifier}`);
  }
});

test('SDK bundle inspection rejects native imports in final Wrangler JavaScript independently of earlier metadata', t => {
  const f = fixture(t);
  const sources = [
    'import http2 from "node:http2"; export default http2;',
    'export { Client } from "@grpc/grpc-js";',
    'export default () => import("http2");',
    'export default () => require("@grpc/grpc-js");',
    'var __require2 = (value) => require(value); export default __require2("http2");',
    'export default module.require("node:http2");',
  ];
  for (const script of sources) assert.throws(() => f.inspect(script), error => error.code === 'WGA_NATIVE_GRPC_BUNDLE' && error.inspection.violations.some(item => item.stage === 'final-javascript'));
});

test('SDK bundle inspection ignores comments strings and erased type-only imports', t => {
  const f = fixture(t);
  const source = 'import type { Client } from "@grpc/grpc-js";\nimport { type ClientHttp2Session } from "node:http2";\n// require("http2")\nexport const documentation = "import(\\"@grpc/grpc-js\\")";\nexport type NativeReference = Client | ClientHttp2Session;';
  const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.equal(f.inspect(script).status, 'passed');
  assert.deepEqual(executableImports(script), []);
  // Metafile.inputs can include a module eliminated from emitted output.
  f.metafile.inputs['types-only.d.ts'] = { bytes: 80, imports: [{ path: 'node:http2', kind: 'import-statement', external: true }] };
  assert.equal(f.inspect(script).status, 'passed');
});

test('SDK bundle inspection fails on missing provenance or malformed emitted JavaScript', t => {
  const f = fixture(t);
  const stage = { name: 'sdk-preset', metafile: f.metafile, workingDirectory: f.root };
  for (const stages of [undefined, [], [stage, stage]]) {
    assert.throws(() => inspectSDKBundle({ stages, script: 'export default {};' }), { code: 'WGA_BUNDLE_PROVENANCE' });
  }
  for (const script of ['', '  ', undefined]) assert.throws(() => f.inspect(script === undefined ? null : script), { code: 'WGA_BUNDLE_PROVENANCE' });
  assert.throws(() => f.inspect('export default {'), { code: 'WGA_BUNDLE_PARSE' });
  f.metafile.outputs = {};
  assert.throws(() => f.inspect(), { code: 'WGA_BUNDLE_PROVENANCE' });
});
