'use strict';
/** Explicit opt-in deployment; creates and deletes one unique, protected Worker. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const wrangler = path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibilityDate = '2026-09-21';
const reportFile = path.join(root, 'verification/cloud-probe.json');
const report = { startedAt: new Date().toISOString(), status: 'running', authenticatedGoogleApiExecuted: false, deployedCloudflareExecuted: false, releaseEligible: false, checks: {} };
let token, key, directory, accountId, name, mayHaveCreated = false, interrupted = false;
const onSignal = () => { interrupted = true; };
function save() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(reportFile, 0o600);
}
async function api(suffix, method = 'GET') {
  const response = await fetch(`https://api.cloudflare.com/client/v4${suffix}`, {
    method, redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  return { status: response.status, success: data.success, result: data.result, codes: data.errors?.map(error => error.code) };
}
function command(args, authenticated = false) {
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const variable of Object.keys(environment)) {
    if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(variable)) delete environment[variable];
  }
  if (authenticated) Object.assign(environment, { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId });
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: directory, env: environment, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // CLI diagnostics are redacted before they can enter the caller's log.
    let diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    for (const secret of [token, key]) if (secret) diagnostic = diagnostic.split(secret).join('[REDACTED]');
    console.error(diagnostic.slice(-3000));
    throw new Error(`WRANGLER_${result.status ?? result.error?.code ?? 'FAILED'}`);
  }
  return result.stdout;
}
async function request(base, route, authorized = true) {
  const response = await fetch(base + route, { method: 'POST', redirect: 'error',
    headers: authorized ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(40000) });
  const text = await response.text();
  if (text.length > 16000) throw new Error('PROBE_RESPONSE_TOO_LARGE');
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { httpStatus: response.status, body };
}
async function preflight(script, bindings) {
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
  let outboundRequests = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script,
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], bindings, log: new Log(LogLevel.NONE),
    outboundService: () => { outboundRequests++; throw new Error('Unexpected local outbound request'); },
  }));
  try {
    const unauthorized = await runtime.dispatchFetch('https://probe.test/protocol/bootstrap', { method: 'POST' });
    if (unauthorized.status !== 404) throw new Error('LOCAL_AUTH_GUARD');
    const headers = { authorization: `Bearer ${key}` };
    const disabled = await runtime.dispatchFetch('https://probe.test/datastore-crud', { method: 'POST', headers });
    if (disabled.status !== 403) throw new Error('LOCAL_GOOGLE_GATE');
    const response = await runtime.dispatchFetch('https://probe.test/protocol/bootstrap', { method: 'POST', headers });
    const body = await response.json();
    if (response.status !== 200 || body.passed !== true || outboundRequests !== 0) throw new Error('LOCAL_BOOTSTRAP');
    return { passed: true, outboundRequests, bootstrap: body };
  } finally { await runtime.dispose(); }
}
async function main() {
  if (!process.argv.includes('--deploy-temporary')) throw new Error('EXPLICIT_DEPLOY_TEMPORARY_FLAG_REQUIRED');
  token = process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CF_TOKEN_REQUIRED');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const accounts = await api('/accounts?per_page=50');
  if (!accounts.success) throw new Error('ACCOUNT_DISCOVERY_FAILED');
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId && !accounts.result.some(account => account.id === accountId)) throw new Error('ACCOUNT_NOT_ACCESSIBLE');
  if (!accountId) {
    if (accounts.result.length !== 1) throw new Error('SET_EXPLICIT_CLOUDFLARE_ACCOUNT_ID');
    accountId = accounts.result[0].id;
  }
  const subdomain = await api(`/accounts/${accountId}/workers/subdomain`);
  if (!subdomain.success || !subdomain.result.subdomain) throw new Error('EXISTING_WORKERS_SUBDOMAIN_REQUIRED');
  name = `wga-probe-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(5).toString('hex')}`;
  key = randomBytes(32).toString('hex');
  directory = path.join(root, '.wga-build/cloud-probe', name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  Object.assign(report, { name, accountId, compatibilityDate, url: `https://${name}.${subdomain.result.subdomain}.workers.dev` });
  save();
  const wrapper = path.join(directory, 'entry.mjs');
  fs.writeFileSync(wrapper, `import live from ${JSON.stringify(pathToFileURL(path.join(root, 'fixtures/google/worker.mjs')).pathname)};\nimport probe from ${JSON.stringify(pathToFileURL(path.join(root, 'fixtures/google/cloud-probe.mjs')).pathname)};\nexport default { fetch(request, env, ctx) { return new URL(request.url).pathname.startsWith('/protocol/') ? probe.fetch(request, env, ctx) : live.fetch(request, env, ctx); } };\n`);
  const build = await require('./build-google-worker.cjs').buildGoogleWorker({ entry: wrapper, outdir: path.join(directory, 'preset-build') });
  const vars = { WGA_RUN_GOOGLE_TESTS: '0', WGA_ALLOW_TEST_WRITES: '0', WGA_TRANSPORT_MODE: 'cloudflare' };
  const config = { name, account_id: accountId, main: build.main, compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: false, send_metrics: false, vars };
  const configFile = path.join(directory, 'wrangler.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const bundleDir = path.join(directory, 'bundle');
  command(['deploy', '--dry-run', '--config', configFile, '--outdir', bundleDir, '--no-autoconfig']);
  const bundleFile = path.join(bundleDir, 'worker.js');
  const script = fs.readFileSync(bundleFile, 'utf8');
  report.bundle = { sha256: digest(script), bytes: Buffer.byteLength(script), gzipBytes: require('node:zlib').gzipSync(script).length,
    presetManifest: path.relative(root, build.manifestFile), path: path.relative(root, bundleFile),
    sourceHashes: Object.fromEntries(['fixtures/google/cloud-probe.mjs', 'scripts/cloud-probe.cjs', 'scripts/cloud-probe-controls.cjs'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))])) };
  report.localPreflight = await preflight(script, { ...vars, WGA_TEST_KEY: key });
  report.controls = await require('./cloud-probe-controls.cjs').runControls();
  save();
  if (interrupted) throw new Error('INTERRUPTED_BEFORE_DEPLOY');
  const absent = await api(`/accounts/${accountId}/workers/scripts/${name}`);
  if (absent.status !== 404) throw new Error('TEMPORARY_NAME_NOT_CONFIRMED_ABSENT');
  // Deploy the exact Wrangler output already run in workerd, with no second bundling pass.
  fs.writeFileSync(configFile, JSON.stringify({ ...config, main: bundleFile, no_bundle: true }, null, 2));
  const secretsFile = path.join(directory, 'secrets.json');
  fs.writeFileSync(secretsFile, JSON.stringify({ WGA_TEST_KEY: key }), { mode: 0o600 });
  if (interrupted) throw new Error('INTERRUPTED_BEFORE_DEPLOY');
  mayHaveCreated = true; report.creationAttempted = true; save();
  command(['deploy', '--config', configFile, '--no-bundle', '--secrets-file', secretsFile, '--no-autoconfig'], true);
  report.deployedCloudflareExecuted = true;
  // DNS and new workers.dev routes can take a few seconds to become reachable.
  let ready;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { ready = await request(report.url, '/protocol/bootstrap', false); if (ready.httpStatus === 404) break; } catch { /* bounded readiness retry */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  report.checks.unauthorized = { passed: ready?.httpStatus === 404, httpStatus: ready?.httpStatus };
  for (const route of ['bootstrap', 'fallback-unary', 'fallback-stream', 'cloudflare-unary', 'cloudflare-stream', 'cloudflare-error', 'raw', 'bootstrap']) {
    if (interrupted) throw new Error('INTERRUPTED_DURING_PROBES');
    const id = route === 'bootstrap' && report.checks.bootstrap ? 'bootstrap-second-request' : route;
    try { report.checks[id] = await request(report.url, '/protocol/' + route); }
    catch (error) { report.checks[id] = { passed: false, code: error.cause?.code ?? error.name }; }
    save();
  }
  const disabled = await request(report.url, '/datastore-crud');
  report.checks.googleDisabled = { passed: disabled.httpStatus === 403, httpStatus: disabled.httpStatus };
  report.fallbackPassed = ['fallback-unary', 'fallback-stream'].every(id => report.checks[id]?.body?.passed === true);
  report.cloudflareModePassed = ['cloudflare-unary', 'cloudflare-stream', 'cloudflare-error'].every(id => report.checks[id]?.body?.passed === true);
  const required = report.fallbackPassed && report.checks.bootstrap?.body?.passed === true && report.checks['bootstrap-second-request']?.body?.passed === true && report.checks.unauthorized.passed && report.checks.googleDisabled.passed;
  report.status = required ? report.cloudflareModePassed ? 'passed' : 'completed-with-cloudflare-mode-failure' : 'failed';
  if (!required) process.exitCode = 1;
}
async function cleanup() {
  if (mayHaveCreated) {
    let removed;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const deletion = await api(`/accounts/${accountId}/workers/scripts/${name}`, 'DELETE');
        const absent = await api(`/accounts/${accountId}/workers/scripts/${name}`);
        removed = { name, deleteStatus: deletion.status, verifiedAbsent: absent.status === 404 };
        if (removed.verifiedAbsent) break;
      } catch { removed = { name, verifiedAbsent: false, code: 'CLEANUP_API_FAILED' }; }
    }
    report.cleanup = removed;
    if (!removed.verifiedAbsent) { report.status = 'cleanup-failed'; process.exitCode = 1; }
  }
  if (directory) {
    fs.rmSync(path.join(directory, 'secrets.json'), { force: true });
    report.localSecretFileRemoved = true;
  }
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, name: report.name, fallbackPassed: report.fallbackPassed,
    cloudflareModePassed: report.cloudflareModePassed, cleanup: report.cleanup, report: path.relative(root, reportFile) }));
}
if (require.main === module) main().catch(error => {
  report.status = 'failed'; report.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.name;
  process.exitCode = 1;
}).finally(cleanup).catch(() => { console.error('CLOUD_PROBE_CLEANUP_FAILED'); process.exitCode = 1; });
module.exports = { main, cleanup };
