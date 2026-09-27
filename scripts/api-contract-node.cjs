'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const native = createRequire(path.join(root, 'fixtures/native/package.json'));
async function main() {
  const { createApiRunner } = await import('../fixtures/shared/catalog-api.mjs');
  const definition = native('@grpc/proto-loader').loadSync(path.join(root, 'fixtures/shared/catalog-api.proto'), { defaults: true });
  const run = createApiRunner(req('@grpc/grpc-js'), req('@grpc/grpc-js/adapter'), req('@grpc/grpc-js/config'), process.argv[2], definition);
  const results = [];
  for (const invocation of ['cold', 'warm']) results.push({ invocation, runtime: 'node', ...await run() });
  fs.writeFileSync(process.argv[3], JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
