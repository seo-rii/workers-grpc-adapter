'use strict';
// This child must fail with the original uncaught exception. A monitor only records it.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '../fixtures/worker/package.json'));
process.once('uncaughtExceptionMonitor', (error, origin) => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ error: error.message, origin, ...globalThis.__catalogApiThrowReceipt?.() }));
});
(async () => {
  const { createApiRunner } = await import('../fixtures/shared/catalog-api.mjs');
  const run = createApiRunner(req('@grpc/grpc-js'), req('@grpc/grpc-js/adapter'), req('@grpc/grpc-js/config'), process.argv[2], {});
  await run({ callbackThrow: true });
  throw new Error('EXPECTED_APPLICATION_THROW_DID_NOT_ESCAPE');
})();
