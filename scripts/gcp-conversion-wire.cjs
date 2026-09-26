'use strict';
// Explicit read-only Google probe; provisions one disposable Cloudflare Worker.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http2 = require('node:http2');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const report = { startedAt: new Date().toISOString(), status: 'running', native: [], worker: [], cleanup: {} };
let cfToken, googleToken, key, account, scriptUrl, attempted = false, created = false, directory, interrupted = false;
const signal = () => { interrupted = true; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const redact = value => [cfToken, googleToken, key].filter(Boolean).reduce((s, v) => s.split(v).join('[REDACTED]'), String(value));
function save() {
  const bytes = JSON.stringify(report, null, 2) + '\n';
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/gcp-conversion-wire.json'), bytes, { mode: 0o600 });
  if (directory) fs.writeFileSync(path.join(directory, 'receipt.json'), bytes, { mode: 0o600 });
}
async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
    authorization: `Bearer ${cfToken}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
  } });
  const data = await response.json();
  return { status: response.status, data };
}
function ok(value) {
  if (value.status < 200 || value.status >= 300 || value.data.success === false) throw new Error(`CF_API_${value.status}_${value.data.errors?.map(x => x.code).join('_') ?? ''}`);
  return value.data.result;
}
function frame(name) {
  const text = Buffer.from(name), size = [];
  let n = text.length;
  do { size.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7; } while (n);
  const payload = Buffer.concat([Buffer.from([10, ...size]), text]);
  const head = Buffer.alloc(5); head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function nativeRequest(contentType, body) {
  return new Promise(resolve => {
    const session = http2.connect('https://secretmanager.googleapis.com');
    const result = { contentType, protocol: 'h2' }, chunks = [];
    let bytes = 0, done = false, stream;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) result.error = error;
      const raw = Buffer.concat(chunks);
      result.bodyBytes = bytes; result.bodySha256 = hash(raw);
      if (!/^application\/grpc(?:;|\+|$)/i.test(result.responseContentType ?? '')) result.errorBodyPrefix = redact(raw.toString('utf8')).slice(0, 1500);
      stream?.close(); session.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish('TIMEOUT'), 20000);
    session.on('error', () => finish('HTTP2_SESSION_ERROR'));
    stream = session.request({ ':method': 'POST', ':path': '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret',
      'content-type': contentType, 'te': 'trailers', authorization: `Bearer ${googleToken}` });
    const status = headers => {
      if (headers['grpc-status'] !== undefined) result.grpcStatus = String(headers['grpc-status']);
      if (headers['grpc-message'] !== undefined) result.grpcMessage = redact(headers['grpc-message']).slice(0, 1500);
    };
    stream.on('response', headers => { result.httpStatus = headers[':status']; result.responseContentType = headers['content-type']; status(headers); });
    stream.on('trailers', status);
    stream.on('data', data => { bytes += data.length; if (bytes > 65536) finish('BODY_LIMIT'); else chunks.push(data); });
    stream.on('error', () => finish('HTTP2_STREAM_ERROR'));
    stream.on('end', () => finish());
    stream.end(body);
  });
}
async function main() {
  if (!process.argv.includes('--deploy-temporary')) throw new Error('EXPLICIT_DEPLOY_REQUIRED');
  const project = process.argv.find(x => x.startsWith('--project='))?.slice(10);
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project ?? '')) throw new Error('EXPLICIT_PROJECT_REQUIRED');
  cfToken = process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) throw new Error('CF_TOKEN_REQUIRED');
  const gcloud = args => cp.execFileSync('gcloud', [...args, '--project', project, '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
  const projectInfo = JSON.parse(gcloud(['projects', 'describe', project, '--format=json(projectNumber)']));
  googleToken = gcloud(['auth', 'print-access-token']);
  report.run = `wga-wire-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(8).toString('hex')}`;
  directory = path.join(root, '.wga-build/conversion-wire', report.run);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secretName = `projects/${projectInfo.projectNumber}/secrets/wga-probe-${randomBytes(10).toString('hex')}-missing`;
  report.secretName = secretName;
  key = randomBytes(32).toString('hex');
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  // All calls name one deliberately nonexistent resource, never an existing secret.
  for (const type of ['application/grpc', 'application/grpc+proto', 'application/grpc-web+proto', 'application/grpc-web']) {
    if (interrupted) throw new Error('INTERRUPTED');
    report.native.push(await nativeRequest(type, frame(secretName))); save();
  }
  if (report.native[0].grpcStatus !== '5') throw new Error('NATIVE_MISSING_SECRET_BASELINE_FAILED');
  const accounts = ok(await api('https://api.cloudflare.com/client/v4/accounts?per_page=50'));
  account = process.env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : undefined);
  if (!account || !accounts.some(x => x.id === account)) throw new Error('EXPLICIT_ACCOUNT_REQUIRED');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
  const subdomain = ok(await api(`${base}/subdomain`)).subdomain;
  if (!subdomain) throw new Error('EXISTING_SUBDOMAIN_REQUIRED');
  scriptUrl = `${base}/scripts/${report.run}`;
  if ((await api(scriptUrl)).status !== 404) throw new Error('NAME_COLLISION');
  report.absentBefore = true;
  const source = fs.readFileSync(path.join(root, 'fixtures/google/conversion-wire.mjs'), 'utf8');
  report.sourceSha256 = hash(source);
  const metadata = { main_module: 'worker.mjs', compatibility_date: '2026-09-21', compatibility_flags: ['auto_grpc_convert'], tags: [report.run], bindings: [
    { type: 'secret_text', name: 'WGA_TEST_KEY', text: key },
    { type: 'secret_text', name: 'WGA_GOOGLE_ACCESS_TOKEN', text: googleToken },
    { type: 'plain_text', name: 'WGA_SECRET_NAME', text: secretName },
  ] };
  const upload = new FormData();
  upload.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  upload.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
  if (interrupted) throw new Error('INTERRUPTED');
  attempted = true; save();
  const uploaded = ok(await api(scriptUrl, 'PUT', upload));
  created = true; report.versionId = uploaded.version_id; save();
  const settings = ok(await api(`${scriptUrl}/settings`));
  report.settingsVerified = settings.tags?.includes(report.run) && settings.compatibility_flags?.includes('auto_grpc_convert');
  if (!report.settingsVerified) throw new Error('DEPLOYED_SETTINGS_MISMATCH');
  ok(await api(`${scriptUrl}/subdomain`, 'POST', JSON.stringify({ enabled: true, previews_enabled: false })));
  const origin = `https://${report.run}.${subdomain}.workers.dev`;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (interrupted) throw new Error('INTERRUPTED');
    const ready = await fetch(origin + '/probe/default/web-proto', { method: 'POST', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${key}` } });
    let result; try { result = await ready.json(); } catch {}
    report.readinessAttempts = attempt + 1;
    if (ready.status === 200 && result?.mode === 'default' && typeof result.httpStatus === 'number') {
      report.ready = true; save(); break;
    }
    await pause(2000);
  }
  if (!report.ready) throw new Error('WORKER_NOT_READY');
  for (const mode of ['default', 'convert', 'passthrough']) for (const wire of ['web-proto', 'web', 'native-proto', 'native']) {
    if (interrupted) throw new Error('INTERRUPTED');
    const response = await fetch(`${origin}/probe/${mode}/${wire}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${key}` } });
    let body; try { body = await response.json(); } catch { body = { error: 'NON_JSON_RESPONSE' }; }
    report.worker.push({ mode, wire, httpStatus: response.status, body }); save();
    if (response.status !== 200 || body.mode !== mode || body.wire !== wire || typeof body.httpStatus !== 'number') throw new Error('INVALID_WORKER_DIAGNOSTIC_RESPONSE');
  }
  report.status = 'completed';
}
async function cleanup() {
  if (attempted) {
    const settings = await api(`${scriptUrl}/settings`);
    if (settings.status === 404 && !created) report.cleanup.absent = true;
    else {
      const value = ok(settings);
      if (!value.tags?.includes(report.run)) throw new Error('OWNERSHIP_TAG_CHANGED_REFUSING_DELETE');
      const deleted = await api(scriptUrl, 'DELETE'); report.cleanup.deleteStatus = deleted.status; ok(deleted);
      report.cleanup.lookupStatus = (await api(scriptUrl)).status;
      report.cleanup.absent = report.cleanup.lookupStatus === 404;
    }
    if (!report.cleanup.absent) throw new Error('CLEANUP_NOT_VERIFIED');
  }
  report.finishedAt = new Date().toISOString(); save();
  process.off('SIGTERM', signal); process.off('SIGINT', signal);
  console.log(JSON.stringify({ run: report.run, status: report.status, cleanup: report.cleanup }));
}
if (require.main === module) main().catch(error => {
  report.status = 'failed'; report.error = redact(error.code || error.message).slice(0, 300); process.exitCode = 1; save();
}).finally(cleanup).catch(error => { report.cleanup.error = redact(error.message).slice(0, 300); save(); console.error(report.cleanup.error); process.exitCode = 1; });
