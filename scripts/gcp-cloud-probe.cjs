'use strict';
// Explicit temporary infrastructure runner. No existing service is updated.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const wrangler = path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reportFile = path.join(root, 'verification/gcp-cloud-probe.json');
const report = { startedAt: new Date().toISOString(), status: 'running', releaseEligible: false, resources: [], results: [], cleanup: [] };
const catalog = require('./gcp-catalog.cjs');
const { parseSoakSeconds, runDeployedSoak, validateDeployedSoak, workerRequestFailure } = require('./gcp-soak.cjs');
const { grantOwnedServiceAccountTokenCreator } = require('./gcp-owned-iam.cjs');
const { awaitOwnedRestrictedToken } = require('./gcp-restricted-token.cjs');
const { parseAuthRenewalArgs, validateCredentialRenewal } = require('./gcp-auth-renewal.cjs');
const secrets = new Set();
let project, region, accessToken, identityToken, cfToken, cfAccount, directory, workerKey, before;
let interrupted = false;
let soakController;
let credentialController;
const onSignal = () => { interrupted = true; soakController?.abort(); credentialController?.abort(); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value => {
  let result = String(value);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
};
function save() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const bytes = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(reportFile, bytes, { mode: 0o600 }); fs.chmodSync(reportFile, 0o600);
  if (directory) fs.writeFileSync(path.join(directory, 'receipt.json'), bytes, { mode: 0o600 });
}
function phase(value) { report.phase = value; save(); console.log(JSON.stringify({ phase: value, run: report.run })); }
function command(program, args, { env = process.env, timeout = 120000, cwd = root, sensitive = false } = {}) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    const error = new Error(sensitive ? 'CREDENTIAL_COMMAND_FAILED' : redact(result.stderr || result.error?.code || 'Command failed').slice(-1800));
    error.code = 'COMMAND_FAILED'; throw error;
  }
  return result.stdout.trim();
}
function gcloud(args, options) { return command('gcloud', [...args, '--project', project, '--quiet'], options); }
function secret(value) { if (!value) throw new Error('EMPTY_CREDENTIAL'); secrets.add(value); return value; }
async function api(url, method = 'GET', body, signal) {
  const timeoutSignal = AbortSignal.timeout(45000);
  const response = await fetch(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    headers: { authorization: `Bearer ${url.startsWith('https://api.cloudflare.com/') ? cfToken : accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  return { status: response.status, data };
}
function ok(response, label) {
  if (response.status < 200 || response.status >= 300 || response.data.error || response.data.success === false) {
    throw Object.assign(new Error(`${label}: HTTP ${response.status} ${redact(response.data.error?.message ?? response.data.errors?.map(item => item.code).join(',') ?? '').slice(0, 600)}`), { code: response.data.error?.status ?? 'API_FAILED' });
  }
  return response.data;
}
async function operation(data, base, timeout = 360000, creationRecord) {
  if (!data.name?.includes('/operations/')) return data;
  const end = Date.now() + timeout;
  let current = data;
  while (!current.done) {
    if (Date.now() > end) throw new Error('OPERATION_TIMEOUT');
    await pause(2500);
    const polled = await api(base + '/' + data.name);
    if (polled.status !== 200) ok(polled, 'operation');
    current = polled.data;
  }
  if (creationRecord) { creationRecord.creationSettled = true; save(); }
  if (current.error) throw new Error(`OPERATION_${current.error.code}: ${redact(current.error.message).slice(0, 600)}`);
  return current.response;
}
function ownedIdentity(record, value) {
  if (record.uid && (value.uid || value.uniqueId) !== record.uid) return false;
  if (record.kind === 'service-account') return value.description === report.run && value.email === record.name;
  if (record.kind === 'secret' || record.kind === 'cloud-run') return value.labels?.['wga-probe'] === report.run;
  if (record.kind === 'database') return value.type === record.databaseType && value.locationId === region &&
    Number.isFinite(Date.parse(value.createTime)) && Date.parse(value.createTime) >= Date.parse(report.startedAt) - 1000;
  return false;
}
function resourceLookupUrl(record) {
  if (record.kind === 'cloudflare-worker') return record.url + '/settings';
  return record.kind === 'service-account' && record.uid
    ? `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${record.uid}`
    : record.url;
}
function acknowledgeWorkerUpload(record, output) {
  // Wrangler's pinned structured output identifies the upload we acknowledged;
  // the current version from a later GET alone could belong to a replacement.
  const deployments = output.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
    .filter(entry => entry.type === 'deploy');
  const uploaded = deployments[0];
  if (deployments.length !== 1 || uploaded.version !== 1 || uploaded.worker_name !== record.name ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploaded.version_id)) {
    throw new Error('WORKER_UPLOAD_IDENTITY_UNPROVEN');
  }
  // Wrangler reports the pre-existing script tag, or null for a new Worker.
  // Never claim an observed late name collision as an owned temporary resource.
  if (typeof uploaded.worker_tag === 'string' && uploaded.worker_tag) {
    record.collision = true;
    throw new Error('CF_WORKER_NAME_COLLISION');
  }
  if (uploaded.worker_tag !== null) throw new Error('WORKER_UPLOAD_IDENTITY_UNPROVEN');
  record.versionId = uploaded.version_id;
  record.uploadAcknowledged = true;
  record.creationSettled = true;
  record.owned = true;
  delete record.ambiguousCreate;
}
async function verifyWorkerIdentity(record) {
  if (!record.uploadAcknowledged || !record.versionId || !record.ownershipTag) {
    throw new Error('WORKER_CREATION_IDENTITY_UNPROVEN');
  }
  // The first deployment is the one actively serving traffic. A repeated
  // deployment of even the same version is a change to the owned instance.
  const current = ok(await api(record.url + '/deployments'), 'CF Worker deployments').result?.deployments?.[0];
  if (!current?.id || (record.deploymentId && current.id !== record.deploymentId) ||
    current.versions?.length !== 1 || current.versions[0].version_id !== record.versionId ||
    current.versions[0].percentage !== 100) throw new Error('RESOURCE_IDENTITY_CHANGED_REFUSING_DELETE');
  const version = ok(await api(record.url + '/versions/' + record.versionId), 'CF Worker version').result;
  if (version?.id !== record.versionId || version.annotations?.['workers/tag'] !== record.ownershipTag) {
    throw new Error('RESOURCE_IDENTITY_CHANGED_REFUSING_DELETE');
  }
  return current.id;
}
async function createResource(resource, createUrl, body, operationBase) {
  if (interrupted) throw new Error('INTERRUPTED');
  const absent = await api(resource.url);
  if (absent.status !== 404) throw new Error(`NAME_NOT_ABSENT_${resource.kind}_${absent.status}`);
  const record = { ...resource, operationBase, absentBefore: true, attempted: false, owned: false };
  report.resources.push(record); save();
  if (interrupted) throw new Error('INTERRUPTED');
  record.attempted = true; save();
  let response;
  try { response = await api(createUrl, 'POST', body); }
  catch (error) { record.ambiguousCreate = true; save(); throw error; }
  // A collision is never ours to delete, even though it was absent at preflight.
  if (response.status === 409) { record.collision = true; save(); throw new Error('CREATE_COLLISION'); }
  ok(response, `create ${resource.kind}`);
  record.owned = true; record.operation = response.data.name;
  record.creationSettled = !response.data.name?.includes('/operations/');
  record.uid = response.data.uid || response.data.uniqueId;
  if (record.kind === 'service-account') record.creationIdentityVerified = ownedIdentity(record, response.data);
  save();
  await operation(response.data, operationBase, 360000, record);
  // IAM can acknowledge creation before lookup replicas have the account. Use
  // its immutable UID and allow bounded propagation before failing the probe.
  let created;
  for (let attempt = 0; attempt < 16; attempt++) {
    created = await api(resourceLookupUrl(record));
    if (created.status !== 404 || attempt === 15) break;
    await pause(2000);
  }
  const value = ok(created, `read created ${resource.kind}`);
  if (!ownedIdentity(record, value)) throw new Error('CREATED_RESOURCE_IDENTITY_MISMATCH');
  record.uid = value.uid || value.uniqueId;
  record.created = true; save();
  return value;
}
async function inventory() {
  // Projections exclude credentials, environment bindings and secret payloads.
  const run = JSON.parse(gcloud(['run', 'services', 'list', '--platform=managed', '--format=json(metadata.name,metadata.uid,metadata.generation)']));
  const databases = JSON.parse(gcloud(['firestore', 'databases', 'list', '--format=json(name,uid,type,locationId)']));
  const secretItems = JSON.parse(gcloud(['secrets', 'list', '--format=json(name,createTime,etag)']));
  const accounts = JSON.parse(gcloud(['iam', 'service-accounts', 'list', '--format=json(name,email,uniqueId,disabled)']));
  const repositories = JSON.parse(gcloud(['artifacts', 'repositories', 'list', '--location=all', '--format=json(name,format)']));
  const normalize = items => items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return Object.fromEntries(Object.entries({ run, databases, secretItems, accounts, repositories }).map(([name, items]) => [name, normalize(items)]));
}
async function deployService(name, image, port, serviceAccount, args) {
  const base = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`;
  return createResource({ kind: 'cloud-run', name, url: `${base}/${name}` }, `${base}?serviceId=${name}`, {
    labels: { 'wga-probe': report.run }, description: 'Temporary workers-grpc-adapter test; delete after probe',
    ingress: 'INGRESS_TRAFFIC_ALL', invokerIamDisabled: false,
    template: { serviceAccount, timeout: '30s', maxInstanceRequestConcurrency: 4,
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      containers: [{ image, ports: [{ name: 'h2c', containerPort: port }], resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true }, ...(args ? { command: ['/usr/local/bin/envoy'], args } : {}) }],
    },
  }, 'https://run.googleapis.com/v2');
}
function wranglerCommand(args, authenticated = false, outputFile) {
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  for (const name of Object.keys(env)) if (/^(?:WGA_|CF_|CLOUDFLARE_|GOOGLE_APPLICATION_CREDENTIALS|WRANGLER_OUTPUT_FILE_|WRANGLER_CI_(?:OVERRIDE_NAME|MATCH_TAG))/.test(name)) delete env[name];
  if (authenticated) Object.assign(env, { CLOUDFLARE_API_TOKEN: cfToken, CLOUDFLARE_ACCOUNT_ID: cfAccount });
  if (outputFile) env.WRANGLER_OUTPUT_FILE_PATH = outputFile;
  return command(process.execPath, [wrangler, ...args], { cwd: directory, env, timeout: 180000 });
}
async function buildWorker() {
  const entry = path.join(directory, 'entry.mjs');
  fs.writeFileSync(entry, `import gcp from ${JSON.stringify(path.join(root, 'fixtures/google/gcp-probe.mjs'))};\nimport echo from ${JSON.stringify(path.join(root, 'fixtures/google/gcp-echo-probe.mjs'))};\nexport default {fetch(r,e,c){return new URL(r.url).pathname.startsWith('/gcp/')?gcp.fetch(r,e,c):echo.fetch(r,e,c)}};\n`);
  const built = await require('./build-google-worker.cjs').buildGoogleWorker({ entry, outdir: path.join(directory, 'prepared') });
  const configFile = path.join(directory, 'wrangler.json');
  fs.writeFileSync(configFile, JSON.stringify({ name: report.run, main: built.main, compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: false, send_metrics: false }));
  wranglerCommand(['deploy', '--dry-run', '--config', configFile, '--outdir', path.join(directory, 'bundle'), '--no-autoconfig']);
  const main = path.join(directory, 'bundle/worker.js');
  const script = fs.readFileSync(main, 'utf8');
  report.bundle = { path: path.relative(root, main), sha256: sha(script), bytes: Buffer.byteLength(script), gzipBytes: require('node:zlib').gzipSync(script).length, presetManifest: path.relative(root, built.manifestFile) };
  // Exercise the exact final script with outbound denied before provisioning.
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), bindings: { WGA_TEST_KEY: workerKey, WGA_PROBE_MODE: 'cloudflare' }, outboundService: () => { throw new Error('Local network denied'); } }));
  try {
    const denied = await runtime.dispatchFetch('https://probe.test/gcp/cloudflare/secret-manager-read', { method: 'POST' });
    const disabled = await runtime.dispatchFetch('https://probe.test/gcp/cloudflare/secret-manager-read', { method: 'POST', headers: { authorization: `Bearer ${workerKey}` } });
    if (denied.status !== 404 || disabled.status !== 403) throw new Error('LOCAL_GUARDS_FAILED');
    report.localPreflight = { passed: true, unauthorized: denied.status, disabled: disabled.status };
  } finally { await runtime.dispose(); }
  return { main, configFile };
}
async function deployWorker(build, env, mode, { targetKey = mode, compatibilityFlags = ['nodejs_compat'] } = {}) {
  if (interrupted) throw new Error('INTERRUPTED');
  const accounts = ok(await api('https://api.cloudflare.com/client/v4/accounts?per_page=50'), 'CF accounts').result;
  cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : undefined);
  if (!cfAccount || !accounts.some(account => account.id === cfAccount)) throw new Error('CF_ACCOUNT_REQUIRED');
  const subdomain = ok(await api(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/subdomain`), 'CF subdomain').result.subdomain;
  if (!subdomain) throw new Error('CF_SUBDOMAIN_REQUIRED');
  const name = `${report.run}-${targetKey === 'cloudflare-flag' ? 'auto-flag' : mode === 'grpc-web' ? 'web' : 'auto'}`;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/scripts/${name}`;
  if ((await api(url)).status !== 404) throw new Error('CF_WORKER_NAME_COLLISION');
  const bundleSha256 = sha(fs.readFileSync(build.main));
  if (bundleSha256 !== report.bundle.sha256) throw new Error('WORKER_BUNDLE_CHANGED');
  const record = { kind: 'cloudflare-worker', name, url, targetKey, compatibilityFlags, bundleSha256,
    ownershipTag: report.run, absentBefore: true, attempted: false, owned: false };
  report.resources.push(record); save();
  const secretBindings = { WGA_TEST_KEY: workerKey, WGA_GOOGLE_ACCESS_TOKEN: accessToken, WGA_GATEWAY_ID_TOKEN: identityToken };
  for (const key of ['WGA_SECRET_PAYLOAD', 'WGA_RESTRICTED_ACCESS_TOKEN']) if (env[key]) secretBindings[key] = env[key];
  const vars = { ...env, WGA_PROBE_MODE: mode }; for (const name of Object.keys(secretBindings)) delete vars[name];
  fs.writeFileSync(build.configFile, JSON.stringify({ name, account_id: cfAccount, main: build.main, no_bundle: true,
    compatibility_date: '2026-09-21', compatibility_flags: compatibilityFlags, workers_dev: true, preview_urls: false, send_metrics: false, vars }));
  const secretsFile = path.join(directory, 'secrets.json');
  const outputFile = path.join(directory, `wrangler-${targetKey}.ndjson`);
  let deployError;
  try {
    fs.writeFileSync(secretsFile, JSON.stringify(secretBindings), { mode: 0o600 });
    fs.writeFileSync(outputFile, '', { mode: 0o600, flag: 'wx' });
    if (interrupted) throw new Error('INTERRUPTED');
    record.attempted = true; record.ambiguousCreate = true; save();
    wranglerCommand(['deploy', '--config', build.configFile, '--no-bundle', '--secrets-file', secretsFile,
      '--no-autoconfig', '--tag', record.ownershipTag], true, outputFile);
  } catch (error) { deployError = error; }
  finally { fs.rmSync(secretsFile, { force: true }); }
  if (!record.attempted) throw deployError;
  try { acknowledgeWorkerUpload(record, fs.readFileSync(outputFile, 'utf8')); }
  catch (error) { record.uploadReceiptError = redact(error.message).slice(0, 800); save(); throw deployError || error; }
  save();
  if (deployError) throw deployError;
  record.deploymentId = await verifyWorkerIdentity(record);
  record.creationIdentityVerified = true;
  record.created = true;
  report.workerUrls ??= {}; report.workerUrls[targetKey] = `https://${name}.${subdomain}.workers.dev`; save();
  const settings = ok(await api(`${url}/settings`), 'CF Worker settings').result;
  record.settingsCompatibilityFlags = settings?.compatibility_flags;
  record.settingsVerified = Array.isArray(record.settingsCompatibilityFlags) &&
    JSON.stringify([...record.settingsCompatibilityFlags].sort()) === JSON.stringify([...compatibilityFlags].sort());
  save();
  if (!record.settingsVerified) throw new Error('WORKER_COMPATIBILITY_FLAGS_MISMATCH');
}
async function workerRequest(route, authorized = true, targetKey = route.split('/')[2], timeoutMs = 95000, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(report.workerUrls[targetKey] + route, { method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      headers: authorized ? { authorization: `Bearer ${workerKey}` } : {} });
  } catch (error) { throw workerRequestFailure('fetch', error); }
  let value;
  try { value = await response.text(); }
  catch (error) { throw workerRequestFailure('response-body', error, response.status); }
  let body; try { body = JSON.parse(value); } catch { body = { code: 'NON_JSON_RESPONSE' }; }
  return { route, httpStatus: response.status, body };
}
async function waitWorkerReady(mode, targetKey = mode) {
  report.workerReadiness ??= {};
  const receipt = report.workerReadiness[targetKey] = { passed: false, attempts: 0 };
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('INTERRUPTED');
    receipt.attempts++;
    try {
      const result = await workerRequest(`/gcp/${mode}/ready`, true, targetKey, 5000);
      receipt.httpStatus = result.httpStatus;
      receipt.passed = result.httpStatus === 200 && result.body?.status === 'ready' && result.body?.mode === mode;
      delete receipt.error;
    } catch (error) { receipt.error = error.name; }
    save();
    if (receipt.passed) return;
    await pause(2000);
  }
  throw new Error(`WORKER_READINESS_TIMEOUT_${targetKey}`);
}
async function main() {
  if (!process.argv.includes('--deploy-temporary')) throw new Error('EXPLICIT_DEPLOY_TEMPORARY_REQUIRED');
  const soakSeconds = parseSoakSeconds(process.argv.slice(2));
  report.authRenewalRequested = parseAuthRenewalArgs(process.argv.slice(2));
  if (report.authRenewalRequested) report.authRenewalSourceHashes = catalog.sourceHashes(root);
  report.soakRequested = soakSeconds !== undefined;
  if (report.soakRequested) report.soakSourceHashes = catalog.sourceHashes(root);
  report.catalogRequested = process.argv.includes('--catalog');
  const iamOptions = process.argv.filter(value => value.startsWith('--grant-owned-token-creator'));
  if (iamOptions.length > 1 || iamOptions.some(value => value !== '--grant-owned-token-creator')) throw new Error('INVALID_OWNED_IAM_GRANT_OPTION');
  const grantOwnedTokenCreator = iamOptions.length === 1;
  if (grantOwnedTokenCreator && !report.catalogRequested) throw new Error('CATALOG_REQUIRED_FOR_OWNED_IAM_GRANT');
  report.dedicatedProject = process.argv.includes('--dedicated-project');
  if (process.argv.includes('--inject-catalog-failure') && !report.catalogRequested) throw new Error('CATALOG_REQUIRED_FOR_FAILURE_INJECTION');
  if (report.catalogRequested) report.catalogSourceHashes = catalog.sourceHashes(root);
  const compareAutoGrpcConvert = process.argv.includes('--compare-auto-grpc-convert');
  if (compareAutoGrpcConvert) { report.compareAutoGrpcConvert = true; report.flaggedResults = []; }
  project = process.argv.find(arg => arg.startsWith('--project='))?.slice(10);
  region = process.argv.find(arg => arg.startsWith('--region='))?.slice(9) || 'asia-northeast3';
  if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('EXPLICIT_PROJECT_AND_VALID_REGION_REQUIRED');
  cfToken = secret(process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN);
  accessToken = secret(gcloud(['auth', 'print-access-token'], { sensitive: true }));
  identityToken = secret(gcloud(['auth', 'print-identity-token'], { sensitive: true }));
  const projectInfo = JSON.parse(gcloud(['projects', 'describe', project, '--format=json(projectNumber,projectId)']));
  const number = String(projectInfo.projectNumber);
  report.gitCommit = command('git', ['rev-parse', 'HEAD']);
  report.run = `wga-probe-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
  Object.assign(report, { project, projectNumber: number, region });
  directory = path.join(root, '.wga-build/gcp-cloud-probe', report.run);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  workerKey = secret(randomBytes(32).toString('hex'));
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  phase('build-and-local-preflight');
  const build = await buildWorker();
  phase('resource-inventory');
  before = await inventory();
  fs.writeFileSync(path.join(directory, 'inventory-before.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
  report.inventoryBefore = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, { count: value.length, sha256: sha(JSON.stringify(value)) }]));
  const ids = { datastore: `${report.run}-ds`, firestore: `${report.run}-fs`, secret: `${report.run}-secret`, sa: `wga-probe-${randomBytes(6).toString('hex')}` };
  phase('create-isolated-resources');
  const serviceAccount = `${ids.sa}@${project}.iam.gserviceaccount.com`;
  await createResource({ kind: 'service-account', name: serviceAccount, url: `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${serviceAccount}` }, `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, { accountId: ids.sa, serviceAccount: { displayName: 'Temporary WGA probe, no roles', description: report.run } });
  if (grantOwnedTokenCreator) {
    if (interrupted) throw new Error('INTERRUPTED');
    const accounts = JSON.parse(gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=json(account)']));
    if (accounts.length !== 1 || typeof accounts[0].account !== 'string') throw new Error('ACTIVE_IAM_PRINCIPAL_REQUIRED');
    const account = accounts[0].account;
    const principal = `${account.endsWith('.gserviceaccount.com') ? 'serviceAccount' : 'user'}:${account}`;
    const record = report.resources.find(item => item.kind === 'service-account' && item.name === serviceAccount);
    phase('explicit-owned-service-account-iam-grant');
    try {
      report.ownedIamGrant = await grantOwnedServiceAccountTokenCreator({ enabled: true, project, run: report.run, record, principal,
        api: (...args) => { if (interrupted) throw new Error('INTERRUPTED'); return api(...args); } });
    } catch (error) {
      const stages = ['identity-before', 'policy-before', 'identity-before-write', 'policy-write', 'policy-after', 'identity-after'];
      report.ownedIamGrantFailure = {
        stage: stages.includes(error?.stage) ? error.stage : 'validation',
        httpStatus: Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null,
        mutationAttempted: error?.mutationAttempted === true,
      };
      save();
      throw error;
    }
    save();
  }
  const ownedAccount = report.resources.find(item => item.kind === 'service-account' && item.name === serviceAccount);
  let restrictedToken;
  if (report.catalogRequested) {
    if (interrupted) throw new Error('INTERRUPTED');
    if (!ownedAccount?.created || !/^[1-9][0-9]{9,29}$/.test(ownedAccount.uid)) throw new Error('OWNED_SERVICE_ACCOUNT_UID_REQUIRED');
    phase('owned-service-account-token');
    credentialController = new AbortController();
    try {
      // Retry only token reads after an explicitly requested, verified grant.
      // Both the helper's wait and the underlying HTTP request are bounded.
      const signal = AbortSignal.any([credentialController.signal, AbortSignal.timeout(300000)]);
      const restricted = await awaitOwnedRestrictedToken({
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${ownedAccount.uid}:generateAccessToken`,
        api: (url, method, body) => api(url, method, body, signal),
        signal: credentialController.signal, allowPropagationWait: Boolean(report.ownedIamGrant),
      });
      report.restrictedPrincipal = { ...restricted.receipt, newlyCreated: true, rolesGranted: 0, keysCreated: 0,
        callerMintPermissionGranted: Boolean(report.ownedIamGrant) };
      if (restricted.credentials) restrictedToken = secret(restricted.credentials.accessToken);
      save();
      if (interrupted) throw new Error('INTERRUPTED');
      if (report.authRenewalRequested && !restrictedToken) throw new Error('AUTH_RENEWAL_REQUIRES_OWNED_TOKEN_PERMISSION');
    } finally { credentialController = undefined; }
  }
  for (const [kind, type] of [['datastore', 'DATASTORE_MODE'], ['firestore', 'FIRESTORE_NATIVE']]) {
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${ids[kind]}`;
    await createResource({ kind: 'database', name: ids[kind], url, databaseType: type }, `https://firestore.googleapis.com/v1/projects/${project}/databases?databaseId=${ids[kind]}`, { locationId: region, type, deleteProtectionState: 'DELETE_PROTECTION_DISABLED', pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' }, 'https://firestore.googleapis.com/v1');
  }
  const secretName = `projects/${number}/secrets/${ids.secret}`;
  await createResource({ kind: 'secret', name: ids.secret, url: `https://secretmanager.googleapis.com/v1/${secretName}` }, `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?secretId=${ids.secret}`, { replication: { automatic: {} }, labels: { 'wga-probe': report.run } });
  let catalogBindings = {};
  if (report.catalogRequested) {
    const secondId = `${report.run}-secret-page`, secondName = `projects/${number}/secrets/${secondId}`;
    await createResource({ kind: 'secret', name: secondId, url: `https://secretmanager.googleapis.com/v1/${secondName}` },
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?secretId=${secondId}`,
      { replication: { automatic: {} }, labels: { 'wga-probe': report.run } });
    const payload = secret(randomBytes(48).toString('base64'));
    const version = ok(await api(`https://secretmanager.googleapis.com/v1/${secretName}:addVersion`, 'POST', { payload: { data: payload } }), 'create owned secret version');
    if (!version.name?.startsWith(secretName + '/versions/')) throw new Error('SECRET_VERSION_IDENTITY_MISMATCH');
    catalogBindings = { WGA_SECRET_VERSION: version.name, WGA_SECRET_PAYLOAD: payload,
      WGA_SECRET_NAMES: JSON.stringify([secretName, secondName]), WGA_RESOURCE_LABEL: report.run };
    if (restrictedToken) catalogBindings.WGA_RESTRICTED_ACCESS_TOKEN = restrictedToken;
  }
  const images = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/cloud-run-probe/images.json')));
  phase('deploy-native-origin');
  const native = await deployService(`${report.run}-native`, `docker.io/${images.native.repository}@${images.native.digest}`, 9000, serviceAccount);
  report.nativeOrigin = native.uri;
  phase('deploy-private-gateway');
  const config = require('../fixtures/cloud-run-probe/envoy-config.cjs').createEnvoyConfig({ nativeOrigin: native.uri });
  const gateway = await deployService(`${report.run}-gateway`, `docker.io/${images.envoy.repository}@${images.envoy.digest}`, 8080, serviceAccount, ['--config-yaml', JSON.stringify(config), '--concurrency', '1', '--log-level', 'warning']);
  report.gatewayOrigin = gateway.uri;
  // Refresh short-lived user tokens immediately before they enter the test Worker.
  accessToken = secret(gcloud(['auth', 'print-access-token'], { sensitive: true }));
  identityToken = secret(gcloud(['auth', 'print-identity-token'], { sensitive: true }));
  const env = { ...catalogBindings, WGA_GCP_PROJECT: project, WGA_GCP_PROJECT_NUMBER: number, WGA_DATASTORE_DATABASE: ids.datastore, WGA_FIRESTORE_DATABASE: ids.firestore,
    ...(report.authRenewalRequested ? { WGA_AUTH_RENEWAL_ENABLED: '1', WGA_OWNED_SERVICE_ACCOUNT_UID: ownedAccount.uid } : {}),
    WGA_SECRET_NAME: secretName, WGA_GOOGLE_ACCESS_TOKEN: accessToken, WGA_GATEWAY_ID_TOKEN: identityToken,
    WGA_RUN_GOOGLE_TESTS: '1', WGA_ALLOW_TEST_WRITES: '1', WGA_NATIVE_ORIGIN: native.uri, WGA_GATEWAY_ORIGIN: gateway.uri,
    WGA_ENDPOINTS_JSON: JSON.stringify(Object.fromEntries(['datastore', 'firestore', 'secretmanager'].map(service => [`${service}.googleapis.com:443`, gateway.uri]))) };
  phase('native-controls');
  const controls = require('./gcp-native-probe.cjs');
  report.echoControls = await controls.runEchoControls({ origin: native.uri, idToken: identityToken }); save();
  report.nativeGoogle = await controls.runNativeSuites(env); save();
  if (report.catalogRequested) { report.nativeCatalog = await controls.runNativeSuites(env, { catalog: true }); save(); }
  if (!report.echoControls.nativeGrpcPassed || report.nativeGoogle.status !== 'passed') throw new Error('NATIVE_BASELINE_FAILED');
  phase('deploy-cloudflare-worker');
  for (const mode of ['grpc-web', 'cloudflare']) await deployWorker(build, env, mode);
  if (compareAutoGrpcConvert) await deployWorker(build, env, 'cloudflare', {
    targetKey: 'cloudflare-flag', compatibilityFlags: ['nodejs_compat', 'auto_grpc_convert'],
  });
  phase('wait-for-worker-readiness');
  for (const mode of ['grpc-web', 'cloudflare']) await waitWorkerReady(mode);
  if (compareAutoGrpcConvert) await waitWorkerReady('cloudflare', 'cloudflare-flag');
  let guard;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { guard = await workerRequest('/gcp/grpc-web/secret-manager-read', false); if (guard.httpStatus === 404) break; } catch {}
    await pause(2000);
  }
  report.unauthorizedGuard = { passed: guard?.httpStatus === 404, httpStatus: guard?.httpStatus }; save();
  phase('deployed-echo-probes');
  const echoTests = ['unary', 'stream', 'error', 'raw', ...(report.catalogRequested ? ['cancel'] : []), ...(compareAutoGrpcConvert ? ['raw-convert', 'raw-passthrough'] : [])];
  for (const mode of ['grpc-web', 'cloudflare']) for (const test of echoTests) {
    if (interrupted) throw new Error('INTERRUPTED');
    try { report.results.push(await workerRequest(`/echo/${mode}/${test}`)); }
    catch (error) { report.results.push({ route: `/echo/${mode}/${test}`, code: error.name }); }
    save();
  }
  phase('deployed-google-suites');
  for (const mode of ['grpc-web', 'cloudflare']) for (const suite of ['secret-manager-read', 'datastore-crud', 'datastore-transaction', 'firestore-crud', 'firestore-transaction']) {
    if (interrupted) throw new Error('INTERRUPTED');
    try { report.results.push(await workerRequest(`/gcp/${mode}/${suite}`)); }
    catch (error) { report.results.push({ route: `/gcp/${mode}/${suite}`, code: error.name }); }
    save();
  }
  report.fallbackGooglePassed = report.results.filter(item => item.route.startsWith('/gcp/grpc-web/')).every(item => item.body?.status === 'passed');
  report.cloudflareGooglePassed = report.results.filter(item => item.route.startsWith('/gcp/cloudflare/')).every(item => item.body?.status === 'passed');
  report.status = report.fallbackGooglePassed ? report.cloudflareGooglePassed ? 'passed' : 'completed-with-cloudflare-mode-failure' : 'completed-with-failures';
  if (report.catalogRequested) {
    phase('deployed-catalog-suites');
    for (const mode of ['grpc-web', 'cloudflare']) for (const suite of catalog.extraSuites) {
      if (interrupted) throw new Error('INTERRUPTED');
      const route = `/gcp/${mode}/${suite}`;
      if (suite === 'permission-denied' && !env.WGA_RESTRICTED_ACCESS_TOKEN) {
        report.results.push({ route, body: { status: 'blocked', reason: 'restricted-principal-token-unavailable' } });
      } else {
        try { report.results.push(await workerRequest(route)); }
        catch (error) { report.results.push({ route, code: error.name }); }
      }
      save();
    }
  }
  if (compareAutoGrpcConvert) {
    phase('deployed-flagged-echo-probes');
    for (const test of echoTests) {
      if (interrupted) throw new Error('INTERRUPTED');
      const route = `/echo/cloudflare/${test}`;
      try { report.flaggedResults.push(await workerRequest(route, true, 'cloudflare-flag')); }
      catch (error) { report.flaggedResults.push({ route, code: error.name }); }
      save();
    }
    phase('deployed-flagged-google-suites');
    for (const suite of ['secret-manager-read', 'datastore-crud', 'datastore-transaction', 'firestore-crud', 'firestore-transaction']) {
      if (interrupted) throw new Error('INTERRUPTED');
      const route = `/gcp/cloudflare/${suite}`;
      try { report.flaggedResults.push(await workerRequest(route, true, 'cloudflare-flag')); }
      catch (error) { report.flaggedResults.push({ route, code: error.name }); }
      save();
    }
    const googleResults = report.flaggedResults.filter(item => item.route.startsWith('/gcp/cloudflare/'));
    const echoResults = report.flaggedResults.filter(item => /^\/echo\/cloudflare\/(?:unary|stream|error)$/.test(item.route));
    report.flagonGooglePassed = googleResults.length === 5 && googleResults.every(item => item.body?.status === 'passed');
    report.flagonEchoPassed = echoResults.length === 3 && echoResults.every(item => item.body?.passed === true);
    report.status = 'completed-auto-conversion-comparison';
  }
  if (report.authRenewalRequested) {
    if (interrupted) throw new Error('INTERRUPTED');
    phase('real-credential-renewal');
    credentialController = new AbortController();
    try {
      const signal = AbortSignal.any([credentialController.signal, AbortSignal.timeout(150000)]);
      const modes = ['native', 'grpc-web', 'cloudflare'];
      const settled = await Promise.allSettled(modes.map(async mode => {
        let value, httpStatus = null;
        if (mode === 'native') value = await controls.runNativeCredentialRenewal(env, { signal });
        else {
          const response = await workerRequest(`/gcp/${mode}/auth-renewal`, true, mode, 150000, signal);
          httpStatus = response.httpStatus;
          if (httpStatus !== 200) return { mode, status: 'failed', httpStatus, code: 'AUTH_RENEWAL_HTTP_FAILED' };
          value = response.body;
        }
        const checked = validateCredentialRenewal(value, { mode });
        // An invalid remote body is never copied into the public receipt.
        return checked.valid ? { mode, status: 'passed', httpStatus, receipt: value }
          : { mode, status: 'failed', httpStatus, code: 'AUTH_RENEWAL_INVALID_RECEIPT', errors: checked.errors };
      }));
      const results = settled.map((item, index) => item.status === 'fulfilled' ? item.value
        : { mode: modes[index], status: 'failed', code: 'AUTH_RENEWAL_REQUEST_FAILED' });
      report.authRenewal = { status: results.every(item => item.status === 'passed') ? 'passed' : 'failed', results };
      save();
      if (interrupted) throw new Error('INTERRUPTED');
      if (report.authRenewal.status !== 'passed') throw new Error('AUTH_RENEWAL_FAILED');
    } finally { credentialController = undefined; }
  }
  if (report.soakRequested) {
    if (interrupted) throw new Error('INTERRUPTED');
    phase('deployed-bounded-soak');
    soakController = new AbortController();
    try {
      report.soak = await runDeployedSoak({ seconds: soakSeconds, signal: soakController.signal,
        request: ({ route, mode, timeoutMs, signal }) => workerRequest(route, true, mode, timeoutMs, signal) });
      save();
      const checked = validateDeployedSoak(report.soak);
      if (!checked.ok || report.soak.status !== 'passed') throw new Error('DEPLOYED_SOAK_FAILED');
    } finally { soakController = undefined; }
  }
  if (process.argv.includes('--inject-catalog-failure')) throw new Error('INTENTIONAL_CATALOG_E2E_FAILURE');
}
async function cleanup() {
  if (directory) phase('cleanup');
  if (report.resources.length) try { accessToken = secret(gcloud(['auth', 'print-access-token'], { sensitive: true })); }
  catch (error) { report.cleanupTokenRefreshError = error.code || 'CREDENTIAL_REFRESH_FAILED'; }
  const pendingDatabaseDeletes = [];
  for (const resource of [...report.resources].reverse()) {
    if ((!resource.owned && !resource.ambiguousCreate) || resource.collision) continue;
    const receipt = { kind: resource.kind, name: resource.name, verifiedAbsent: false };
    report.cleanup.push(receipt); save();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (resource.kind === 'cloudflare-worker' && (!resource.uploadAcknowledged || !resource.versionId)) {
          throw new Error('WORKER_CREATION_IDENTITY_UNPROVEN');
        }
        if (resource.operation?.includes('/operations/') && !resource.creationSettled) {
          try { await operation({ name: resource.operation }, resource.operationBase, 360000, resource); }
          catch (error) { if (!resource.creationSettled) throw error; }
        }
        const existing = await api(resourceLookupUrl(resource));
        if (existing.status === 404) {
          if (resource.ambiguousCreate && !resource.creationSettled) throw new Error('AMBIGUOUS_CREATE_CANNOT_PROVE_FINAL_ABSENCE');
          if (resource.kind === 'service-account' && resource.owned && !receipt.deleteAcknowledged) {
            // A fresh IAM account can be missing from both email and UID reads.
            // Only the acknowledged, identity-checked create permits deletion
            // in that case; a lookup 404 alone never proves cleanup succeeded.
            if (!resource.uid || !resource.creationIdentityVerified) throw new Error('ACKNOWLEDGED_SERVICE_ACCOUNT_ABSENCE_UNPROVEN');
          } else { receipt.verifiedAbsent = true; delete receipt.error; break; }
        } else {
          ok(existing, 'cleanup lookup');
          if (resource.kind === 'cloudflare-worker') {
            const deploymentId = await verifyWorkerIdentity(resource);
            resource.deploymentId ??= deploymentId;
            receipt.identityVerified = true;
            receipt.versionId = resource.versionId;
            receipt.deploymentId = deploymentId;
            save();
          } else if (!ownedIdentity(resource, existing.data)) throw new Error('RESOURCE_IDENTITY_CHANGED_REFUSING_DELETE');
          resource.owned = true;
          resource.uid ??= existing.data.uid || existing.data.uniqueId;
        }
        let deleteUrl = resource.kind === 'service-account' ? `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${resource.uid}` : resource.url;
        if (existing.data.etag && ['cloud-run', 'database', 'secret'].includes(resource.kind)) deleteUrl += `?etag=${encodeURIComponent(existing.data.etag)}`;
        const deleted = await api(deleteUrl, 'DELETE');
        receipt.deleteStatus = deleted.status; ok(deleted, 'delete owned resource');
        receipt.deleteAcknowledged = true; save();
        if (resource.kind === 'database' && deleted.data.name?.includes('/operations/')) {
          // Submit independent database deletes one at a time, then let their
          // server-side operations overlap while other owned resources close.
          receipt.deleteOperation = deleted.data.name;
          receipt.deleteOperationSettled = false;
          pendingDatabaseDeletes.push({ resource, receipt, operationData: deleted.data });
          save();
          break;
        }
        if (resource.operationBase) await operation(deleted.data, resource.operationBase);
        const absent = await api(resourceLookupUrl(resource));
        receipt.lookupStatus = absent.status;
        receipt.verifiedAbsent = absent.status === 404;
        if (receipt.verifiedAbsent) { delete receipt.error; break; }
        await pause(2000);
      } catch (error) {
        receipt.error = redact(error.message).slice(0, 800);
        if (resource.kind === 'service-account' && attempt < 2) await pause(2000);
      }
    }
    save();
  }
  for (const { resource, receipt, operationData } of pendingDatabaseDeletes) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!receipt.deleteOperationSettled) {
          await operation(operationData, resource.operationBase);
          receipt.deleteOperationSettled = true; save();
        }
        // A 404 while the delete is still running is not completion evidence.
        const absent = await api(resource.url);
        receipt.lookupStatus = absent.status;
        receipt.verifiedAbsent = absent.status === 404;
        if (receipt.verifiedAbsent) { delete receipt.error; break; }
        ok(absent, 'verify database deletion');
        await pause(2000);
      } catch (error) { receipt.error = redact(error.message).slice(0, 800); }
    }
    save();
  }
  if (directory) fs.rmSync(path.join(directory, 'secrets.json'), { force: true });
  if (before) try {
    const after = await inventory();
    fs.writeFileSync(path.join(directory, 'inventory-after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
    report.existingResources = Object.fromEntries(Object.keys(before).map(key => [key, { beforeCount: before[key].length, afterCount: after[key].length, unchanged: JSON.stringify(before[key]) === JSON.stringify(after[key]) }]));
  } catch (error) { report.inventoryAfterError = redact(error.message).slice(0, 800); }
  report.existingResourcesUnchanged = Boolean(report.existingResources) && Object.values(report.existingResources).every(item => item.unchanged);
  report.allCreatedResourcesDeleted = report.resources.filter(item => item.owned || item.ambiguousCreate).length === report.cleanup.length && report.cleanup.every(item => item.verifiedAbsent);
  if (!report.allCreatedResourcesDeleted) { report.status = 'cleanup-failed'; process.exitCode = 1; }
  if (before && !report.existingResourcesUnchanged) { report.status = 'inventory-verification-failed'; process.exitCode = 1; }
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, allCreatedResourcesDeleted: report.allCreatedResourcesDeleted, report: path.relative(root, reportFile) }));
}
if (require.main === module) main().catch(error => {
  report.status = 'failed'; report.error = redact(error.message).slice(0, 1800); process.exitCode = 1; save();
}).finally(async () => {
  await cleanup();
  if (report.catalogRequested) {
    const result = catalog.summarize(report);
    fs.writeFileSync(path.join(root, 'verification/gcp-cloud-catalog.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    if (!result.certificationPassed) process.exitCode = 1;
  }
}).catch(error => { console.error(redact(error.message).slice(0, 1000)); process.exitCode = 1; });
