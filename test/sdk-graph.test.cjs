'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { inspect } = require('../scripts/doctor.cjs');
function packageAt(base, relative, manifest, source = '') {
    const directory = path.join(base, relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0', main: 'index.js', ...manifest }));
    fs.writeFileSync(path.join(directory, 'index.js'), source);
}
function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    packageAt(base, '.', { name: 'consumer' });
    packageAt(base, 'node_modules/example-sdk', { name: 'example-sdk', dependencies: { 'google-gax': '*', helper: '*' } });
    packageAt(base, 'node_modules/google-gax', { name: 'google-gax', dependencies: { '@grpc/grpc-js': '*' } }, "require('@grpc/grpc-js');");
    packageAt(base, 'node_modules/helper', { name: 'helper', dependencies: { 'google-gax': '*' } });
    packageAt(base, 'node_modules/helper/node_modules/google-gax', { name: 'google-gax', version: '2.0.0', dependencies: { '@grpc/grpc-js': '*' } }, "require('@grpc/grpc-js');");
    packageAt(base, 'node_modules/@grpc/grpc-js', { name: 'workers-grpc-adapter' });
    return base;
}
test('SDK doctor visits every GAX in an SDK transitive closure', t => {
    const report = inspect(fixture(t), ['example-sdk']);
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].gax.map(item => item.version).sort(), ['1.0.0', '2.0.0']);
    assert.equal(report.results[0].grpcImportCount, 2);
});
test('SDK doctor rejects a native grpc shadowed under a second GAX', t => {
    const base = fixture(t);
    packageAt(base, 'node_modules/helper/node_modules/@grpc/grpc-js', { name: '@grpc/grpc-js', version: '1.14.0' });
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    const wrong = report.results[0].graph.flatMap(item => item.grpcImports).filter(item => item.status === 'wrong-implementation');
    assert.equal(wrong.length, 1);
    assert.match(wrong[0].resolved, /helper\/node_modules\/@grpc/);
});
test('SDK doctor verifies deep imports instead of checking only package name', t => {
    const base = fixture(t);
    fs.writeFileSync(path.join(base, 'node_modules/google-gax/index.js'), "require('@grpc/grpc-js/build/src/missing');");
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    assert.ok(report.results[0].graph.some(item => item.grpcImports.some(entry => entry.status === 'resolution-failed')));
});
test('SDK doctor rejects separate own-name and alias installations even at the same version', t => {
    const base = fixture(t);
    const before = inspect(base, ['example-sdk']);
    packageAt(base, 'node_modules/workers-grpc-adapter', { name: 'workers-grpc-adapter' });
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    assert.equal(report.results[0].status, 'resolved-to-replacement', 'correct package names alone do not establish shared constructor identity');
    assert.equal(report.identity.status, 'duplicate-installations');
    assert.deepEqual(report.identity.installations.map(item => item.version), ['1.0.0', '1.0.0']);
    assert.deepEqual(report.diagnostics.map(item => item.code), ['WGA_DUPLICATE_ADAPTER_INSTALLATIONS']);
    assert.deepEqual(report.diagnostics[0].paths, ['node_modules/@grpc/grpc-js', 'node_modules/workers-grpc-adapter']);
    assert.deepEqual(report.identity.installations[1].resolvedBy, [{ consumer: '.', specifier: 'workers-grpc-adapter' }]);
    assert.ok(report.identity.installations[0].resolvedBy.some(item => item.consumer === 'node_modules/google-gax/index.js' && item.specifier === '@grpc/grpc-js'));
    assert.notEqual(report.graphSha256, before.graphSha256, 'own-name installation participates in the graph fingerprint');
});
test('SDK doctor rejects different-version adapters under a nested GAX', t => {
    const base = fixture(t);
    packageAt(base, 'node_modules/helper/node_modules/@grpc/grpc-js', { name: 'workers-grpc-adapter', version: '2.0.0' });
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    assert.equal(report.identity.status, 'duplicate-installations');
    assert.deepEqual(report.identity.installations.map(item => item.version), ['1.0.0', '2.0.0']);
    assert.ok(report.identity.installations[1].resolvedBy.some(item => item.consumer === 'node_modules/helper/node_modules/google-gax/index.js'));
});
test('SDK doctor detects identity splits across individually valid SDK closures', t => {
    const base = fixture(t);
    packageAt(base, 'node_modules/other-sdk', { name: 'other-sdk', dependencies: { 'google-gax': '*' } });
    packageAt(base, 'node_modules/other-sdk/node_modules/google-gax', { name: 'google-gax', dependencies: { '@grpc/grpc-js': '*' } }, "require('@grpc/grpc-js');");
    packageAt(base, 'node_modules/other-sdk/node_modules/@grpc/grpc-js', { name: 'workers-grpc-adapter' });
    const report = inspect(base, ['example-sdk', 'other-sdk']);
    assert.equal(report.passed, false);
    assert.ok(report.results.every(item => item.status === 'resolved-to-replacement'));
    assert.equal(report.identity.installations.length, 2);
    assert.equal(report.diagnostics[0].code, 'WGA_DUPLICATE_ADAPTER_INSTALLATIONS');
});
test('SDK doctor treats aliases symlinked to one physical installation as one identity', t => {
    const base = fixture(t);
    fs.symlinkSync(path.join('@grpc', 'grpc-js'), path.join(base, 'node_modules/workers-grpc-adapter'), 'dir');
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, true);
    assert.equal(report.identity.status, 'single-installation');
    assert.equal(report.identity.installations.length, 1);
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(report.identity.installations[0].resolvedBy.filter(item => item.consumer === '.').map(item => item.specifier), ['@grpc/grpc-js', 'workers-grpc-adapter']);
});
test('SDK doctor inspects without credentials or network and executes zero dependency auth or Fetch calls', t => {
    const base = fixture(t);
    packageAt(base, 'node_modules/google-auth-library', { name: 'google-auth-library' }, "globalThis.authCalls++; throw new Error('AUTH_EXECUTED');");
    packageAt(base, 'node_modules/example-sdk', { name: 'example-sdk', dependencies: { 'google-gax': '*', helper: '*', 'google-auth-library': '*' } }, "require('google-auth-library'); fetch('https://credentials.invalid'); throw new Error('SDK_EXECUTED');");
    fs.writeFileSync(path.join(base, 'node_modules/@grpc/grpc-js/index.js'), "throw new Error('ADAPTER_EXECUTED');");
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const Module = require('node:module');
      const counters = { network: 0, fetch: 0, auth: 0, runtimeImports: 0, credentialReads: 0 };
      const denied = () => { counters.network++; throw new Error('NETWORK_DENIED'); };
      globalThis.fetch = () => { counters.fetch++; throw new Error('FETCH_DENIED'); };
      for (const name of ['node:http', 'node:https']) {
        const module = require(name); module.request = module.get = denied;
      }
      require('node:http2').connect = denied;
      const net = require('node:net'); net.connect = net.createConnection = net.Socket.prototype.connect = denied;
      require('node:tls').connect = denied;
      const dns = require('node:dns');
      for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[key] = dns.promises[key] = denied;
      const cp = require('node:child_process');
      for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[key] = denied;
      const load = Module._load;
      Module._load = function(specifier, parent, isMain) {
        if (specifier === 'google-auth-library' || specifier.startsWith('google-auth-library/')) {
          counters.auth++; throw new Error('AUTH_DENIED');
        }
        const resolved = Module._resolveFilename(specifier, parent, isMain);
        if (resolved.startsWith(process.argv[1] + path.sep)) {
          counters.runtimeImports++; throw new Error('INSPECTED_RUNTIME_IMPORT_DENIED');
        }
        return load.call(this, specifier, parent, isMain);
      };
      const read = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (/application_default_credentials\\.json|[/\\\\]gcloud[/\\\\]/.test(String(file))) {
          counters.credentialReads++; throw new Error('CREDENTIAL_READ_DENIED');
        }
        return read.call(this, file, ...args);
      };
      assert.deepEqual(Object.keys(process.env).filter(key => /^(GOOGLE_|GCLOUD_|GCE_|CLOUDSDK_)/.test(key)), []);
      const report = require(process.argv[2]).inspect(process.argv[1], ['example-sdk']);
      assert.equal(report.passed, true);
      assert.deepEqual(counters, { network: 0, fetch: 0, auth: 0, runtimeImports: 0, credentialReads: 0 });
      process.stdout.write(JSON.stringify({ passed: report.passed, counters, scope: report.scope }));
    `;
    const result = spawnSync(process.execPath, ['-e', script, base, path.resolve(__dirname, '../scripts/doctor.cjs')], { encoding: 'utf8', timeout: 10000, env: {} });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.deepEqual(report.counters, { network: 0, fetch: 0, auth: 0, runtimeImports: 0, credentialReads: 0 });
    assert.match(report.scope, /no runtime imports, authentication or network requests/);
});
