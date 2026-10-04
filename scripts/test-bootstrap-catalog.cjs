'use strict';
// All seven remaining bootstrap contracts, using only installed packages. The
// native fixtures produce the independent protobuf/proto-loader oracle; workerd
// executes the profile's generated codecs and real GAX/SDK service stubs.
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { inspectSDKBundle } = require('./sdk-bundle-inspection.cjs');
const { validateBootstrapCatalogReport, sources, caseIds } = require('./bootstrap-catalog-evidence.cjs');
const root = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-bootstrap-catalog-'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild'), typescript = require('typescript');
const compatibilityDate = '2026-09-21';
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hashObject = value => digest(JSON.stringify(canonical(value)));
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild: false, runtime: process.version,
  liveGoogle: false, cloudflareTranslation: false, officialEmulator: false, independentNativeOracle: true,
  runtimeDisposed: false, compatibilityDate, workerd: workerRequire('workerd/package.json').version,
  miniflare: workerRequire('miniflare/package.json').version, esbuild: esbuild.version,
  evidence: Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])),
  profiles: [], cases: [], catalogCases: [], failures: [] };

function allTypes(P, current) {
  return [...(current instanceof P.Type ? [current] : []), ...(current.nestedArray || []).flatMap(child => allTypes(P, child))];
}
function sampleField(P, field, depth) {
  function scalar() {
    if (field.resolvedType instanceof P.Enum) return Object.keys(field.resolvedType.values).find(name => field.resolvedType.values[name] !== 0)
      || Object.keys(field.resolvedType.values)[0];
    if (field.resolvedType instanceof P.Type) return sample(P, field.resolvedType, depth + 1);
    if (/64$/.test(field.type)) return /^(u|fixed)/.test(field.type) ? '18446744073709551615' : '9223372036854775807';
    if (field.type === 'string') return 'bootstrap-한글';
    if (field.type === 'bytes') return 'AH//';
    if (field.type === 'bool') return true;
    return /^(float|double)$/.test(field.type) ? 1.25 : 7;
  }
  if (field.map) return { [field.keyType === 'string' ? 'sample' : field.keyType === 'bool' ? 'true' : '1']: scalar() };
  return field.repeated ? [scalar()] : scalar();
}
function sample(P, type, depth = 0) {
  const out = {}, oneofs = new Set();
  for (const field of type.fieldsArray) {
    if (depth > 0 && !field.required) continue;
    if (field.partOf) {
      if (oneofs.has(field.partOf)) continue;
      oneofs.add(field.partOf);
    }
    out[field.name] = sampleField(P, field, depth);
  }
  return out;
}
function buildOracle(profile, nativeRoot, installedRoot) {
  const req = createRequire(path.join(nativeRoot, 'package.json')), loader = req('@grpc/proto-loader');
  const loaderProtobuf = createRequire(req.resolve('@grpc/proto-loader'))('protobufjs');
  const loaderOptions = req('google-gax').GrpcClient.defaultOptions();
  assert.deepEqual(Object.keys(loaderOptions).sort(), ['keepCase', 'longs', 'enums', 'defaults', 'oneofs', 'includeDirs'].sort());
  const schemas = profile.schemas.map(schema => {
    const absolute = path.join(nativeRoot, schema.path), P = createRequire(absolute)('protobufjs');
    assert.equal(digest(fs.readFileSync(absolute)), schema.sha256, `Independent native schema pin: ${schema.path}`);
    const json = schema.common ? P.common[schema.common] : absolute.endsWith('.proto') ? P.loadSync(absolute).toJSON() : JSON.parse(fs.readFileSync(absolute));
    const reflection = P.Root.fromJSON(json).resolveAll(), definitions = loader.fromJSON(json, loaderOptions), namespaces = [];
    const loaderReflection = loaderProtobuf.Root.fromJSON(json).resolveAll();
    function inspectNamespace(value) {
      if (value instanceof P.Enum || value instanceof P.Service) namespaces.push({ name: value.fullName,
        kind: value instanceof P.Enum ? 'enum' : 'service', json: value.toJSON() });
      for (const child of value.nestedArray || []) inspectNamespace(child);
    }
    inspectNamespace(reflection);
    const types = allTypes(P, reflection).map(type => {
      const input = sample(P, type, 1), message = type.fromObject(input), wire = Buffer.from(type.encode(message).finish()).toString('base64');
      const inputs = [{ label: 'required-defaults', input }, { label: 'populated', input: sample(P, type) }];
      for (const oneof of type.oneofsArray) for (const field of oneof.fieldsArray) {
        inputs.push({ label: `oneof:${oneof.name}:${field.name}`, input: { ...input, [field.name]: sampleField(P, field, 0) } });
      }
      for (const field of type.fieldsArray) if (field.resolvedType instanceof P.Enum) {
        for (const name of Object.keys(field.resolvedType.values)) inputs.push({ label: `enum:${field.name}:${name}`,
          input: { ...input, [field.name]: field.repeated ? [name] : field.map ? { sample: name } : name } });
      }
      const def = definitions[type.fullName.slice(1)], loaderType = loaderReflection.lookupType(type.fullName);
      const variants = inputs.map(({ label, input }) => {
        // The pinned loader exports top-level messages only. Nested messages
        // use the independent native protobuf implementation with the exact
        // same options, and are explicitly labelled instead of inventing an
        // exported proto-loader serializer that the SDK never exposes.
        const wire = Buffer.from(def ? def.serialize(input) : loaderType.encode(loaderType.fromObject(input)).finish());
        return { label, input, oracle: def ? 'native-proto-loader' : 'native-protobuf-reflection', wire: wire.toString('base64'),
          object: canonical(def ? def.deserialize(wire) : loaderType.toObject(loaderType.decode(wire), loaderOptions)) };
      });
      return { name: type.fullName, input,
        message: type.toObject(message, { longs: String, bytes: Array }), wire,
        object: canonical(type.toObject(message, loaderOptions)), reflection: type.toJSON(), variants };
    });
    return { path: schema.path, json, types, namespaces, protobufPath: createRequire(path.join(installedRoot, schema.path)).resolve('protobufjs'),
      sourceSha256: schema.sha256, nativeProtobufPath: path.relative(root, createRequire(absolute).resolve('protobufjs')) };
  });
  return { schemas, loaderOptions, loader };
}

function rejectionMatrix(profile, installedRoot, createBuild, outdir) {
  const shadow = path.join(outdir, 'mutated-profile');
  const paths = [...new Set([...profile.packages.map(item => `${item.path}/package.json`), ...profile.files.map(item => item.path),
    ...profile.schemas.map(item => item.path), ...profile.codegenInputs.map(item => item.path)])];
  for (const relative of paths) {
    const destination = path.join(shadow, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(installedRoot, relative), destination);
  }
  const rows = [];
  for (const [kind, inputs] of [['source-hash', profile.files], ['schema-hash', profile.schemas]]) for (const input of inputs) {
    const file = path.join(shadow, input.path), original = fs.readFileSync(file), output = path.join(outdir, 'must-not-build');
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n ')]));
    let failure;
    try { createBuild({ projectRoot: shadow, outdir: output, profile: profile.id, typescript }); }
    catch (error) { failure = error; }
    finally { fs.writeFileSync(file, original); }
    assert.equal(failure?.code, 'WGA_SCHEMA_MISMATCH');
    assert.equal(failure.diagnostic.kind, kind);
    assert.equal(failure.diagnostic.path, input.path);
    assert.equal(failure.diagnostic.expected, input.sha256);
    assert.notEqual(failure.diagnostic.actual, input.sha256);
    assert.equal(fs.existsSync(output), false, 'Rejected before registry or runtime fallback exists');
    assert.equal(digest(fs.readFileSync(path.join(installedRoot, input.path))), input.sha256);
    rows.push({ kind, path: input.path, originalSha256: input.sha256, mutatedSha256: failure.diagnostic.actual,
      code: failure.code, outputCreated: false, installedUnchanged: true });
  }
  return rows;
}
function hashTree(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push([path.relative(directory, file), digest(fs.readFileSync(file))]);
    }
  }
  visit(directory);
  return hashObject(files);
}
async function bundle(entry, outdir, plugins = []) {
  fs.mkdirSync(outdir, { recursive: true });
  const first = await esbuild.build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
    target: 'es2022', outfile: path.join(outdir, 'sdk.cjs'), plugins, metafile: true, logLevel: 'silent' });
  const main = path.join(outdir, 'worker.mjs');
  fs.writeFileSync(main, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(outdir, 'wrangler.json'), metadata = path.join(outdir, 'metafile.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-bootstrap-catalog-local', main, compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--config', config, '--outdir', path.join(outdir, 'bundle'), '--no-autoconfig', '--metafile', metadata],
  { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(outdir, 'bundle/worker.js'), 'utf8');
  return { script, inputs: Object.keys(first.metafile.inputs), inspection: inspectSDKBundle({ script, stages: [
    { name: 'profile-preset', metafile: first.metafile, workingDirectory: root },
    { name: 'wrangler', metafile: JSON.parse(fs.readFileSync(metadata)), workingDirectory: root },
  ] }) };
}
function runtime(script, outboundService) {
  return new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script,
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService }));
}
function frame(bytes, trailer = false) {
  const prefix = Buffer.alloc(5); prefix[0] = trailer ? 128 : 0; prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
function bounded(promise, label, milliseconds = 60000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`BOOTSTRAP_TIMEOUT_${label}`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
async function responseJson(worker, route) {
  const response = await bounded(worker.dispatchFetch(`https://bootstrap-fixture.invalid${route}`), route, 180000);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Worker response ${response.status}: ${text.slice(0, 1500)}`); }
  assert.equal(response.status, 200, JSON.stringify(parsed));
  assert.equal(parsed.status, 'passed');
  return parsed.result;
}

async function runProfile(id, fixture, nativeFixture) {
  const project = path.join(root, 'fixtures', fixture), nativeRoot = path.join(root, 'fixtures', nativeFixture);
  const req = createRequire(path.join(project, 'package.json')), nativeReq = createRequire(path.join(nativeRoot, 'package.json'));
  const buildFile = req.resolve('@grpc/grpc-js/build'), buildRoot = path.dirname(buildFile);
  const profile = JSON.parse(fs.readFileSync(path.join(buildRoot, 'profiles', `${id}.json`)));
  const { createGoogleWorkerBuild } = req('@grpc/grpc-js/build');
  const outdir = path.join(temporary, id); fs.mkdirSync(outdir);
  const row = { id, fixture, nativeFixture, revision: profile.revision, status: 'running', nativeGrpcVersion: nativeReq('@grpc/grpc-js/package.json').version,
    installedInputs: {}, nativeInputs: {}, schemaPaths: profile.schemas.map(item => item.path), sourcePaths: profile.files.map(item => item.path) };
  report.profiles.push(row);
  row.loaderResolution = Object.fromEntries([['installed', req], ['native', nativeReq]].map(([name, resolve]) => {
    const loaderEntry = resolve.resolve('@grpc/proto-loader'), fromLoader = createRequire(loaderEntry), protobufEntry = fromLoader.resolve('protobufjs');
    return [name, { loaderEntry: path.relative(root, loaderEntry), protobufEntry: path.relative(root, protobufEntry),
      loaderSha256: digest(fs.readFileSync(loaderEntry)), protobufSha256: digest(fs.readFileSync(protobufEntry)),
      protobufVersion: fromLoader('protobufjs/package.json').version }];
  }));
  for (const relative of [...new Set([...profile.packages.map(item => `${item.path}/package.json`), ...profile.files.map(item => item.path),
    ...profile.schemas.map(item => item.path), ...profile.codegenInputs.map(item => item.path)])]) {
    row.installedInputs[relative] = digest(fs.readFileSync(path.join(project, relative)));
    row.nativeInputs[relative] = digest(fs.readFileSync(path.join(nativeRoot, relative)));
    assert.equal(row.installedInputs[relative], row.nativeInputs[relative], `Independent oracle exact profile input: ${relative}`);
  }
  for (const file of ['package.json', 'dist/index.js', 'dist/build/index.cjs']) row.installedInputs[`node_modules/@grpc/grpc-js/${file}`] = digest(fs.readFileSync(path.join(project, 'node_modules/@grpc/grpc-js', file)));
  for (const file of ['package.json', 'build/src/index.js']) row.nativeInputs[`node_modules/@grpc/grpc-js/${file}`] = digest(fs.readFileSync(path.join(nativeRoot, 'node_modules/@grpc/grpc-js', file)));
  row.rejections = rejectionMatrix(profile, project, createGoogleWorkerBuild, outdir);
  const oracle = buildOracle(profile, nativeRoot, project);
  const preset = createGoogleWorkerBuild({ projectRoot: project, outdir: path.join(outdir, 'preset'), profile: id, typescript });
  const appSource = path.dirname(nativeReq.resolve('protobufjs/package.json')), appCopy = path.join(outdir, 'application-protobuf');
  fs.cpSync(appSource, appCopy, { recursive: true });
  // A distinct physical package uses the independently installed dependencies;
  // none of its source files is among the profile transform allowlist.
  fs.symlinkSync(path.join(nativeRoot, 'node_modules'), path.join(outdir, 'node_modules'), 'dir');
  const applicationHash = hashTree(appCopy);
  const appProbe = path.join(root, 'fixtures/worker/bootstrap-app-probe.mjs');
  const nativeApp = (await import(pathToFileURL(appProbe).href)).probeApplicationProtobuf(nativeReq('protobufjs'));
  const appEntry = path.join(outdir, 'application-baseline.mjs');
  fs.writeFileSync(appEntry, `import P from ${JSON.stringify(path.join(appCopy, 'index.js'))};import {probeApplicationProtobuf} from ${JSON.stringify(appProbe)};export default {fetch(){return Response.json({status:'passed',result:probeApplicationProtobuf(P)})}};\n`);
  const baselineBundle = await bundle(appEntry, path.join(outdir, 'baseline'));
  const baseline = runtime(baselineBundle.script, () => { throw new Error('Application baseline has no network'); });
  let baselineResult;
  try { baselineResult = await responseJson(baseline, '/application'); } finally { await baseline.dispose(); }
  const dataFile = path.join(outdir, 'oracle-inputs.json');
  fs.writeFileSync(dataFile, JSON.stringify(oracle.schemas.map(({ path, json, types, namespaces }) => ({ path, json, types, namespaces }))));
  const imports = [`import registry from ${JSON.stringify(preset.registryFile)};`, `import data from ${JSON.stringify(dataFile)};`,
    `import applicationProtobuf from ${JSON.stringify(path.join(appCopy, 'index.js'))};`,
    `import * as loader from ${JSON.stringify(req.resolve('@grpc/proto-loader'))};`,
    `import loaderProtobuf from ${JSON.stringify(createRequire(req.resolve('@grpc/proto-loader')).resolve('protobufjs'))};`];
  for (const [name, pkg] of [['datastore', '@google-cloud/datastore'], ['firestore', '@google-cloud/firestore'], ['secret', '@google-cloud/secret-manager'], ['auth', 'google-auth-library']]) {
    imports.push(`import * as ${name} from ${JSON.stringify(req.resolve(pkg))};`);
  }
  oracle.schemas.forEach((schema, index) => imports.push(`import P${index} from ${JSON.stringify(schema.protobufPath)};`));
  const gaxPackages = profile.packages.filter(item => item.name === 'google-gax');
  const nativeMethods = new Map();
  const gaxRows = gaxPackages.map((pkg, index) => {
    const name = `gax-${index}`, nativeGax = createRequire(path.join(nativeRoot, pkg.path, 'package.json'));
    imports.push(`import * as G${index} from ${JSON.stringify(path.join(project, pkg.path, 'build/src/index.js'))};`,
      `import {IamClient as I${index}} from ${JSON.stringify(path.join(project, pkg.path, 'build/src/iamService.js'))};`,
      `import {GoogleErrorDecoder as E${index}} from ${JSON.stringify(path.join(project, pkg.path, 'build/src/googleError.js'))};`);
    const P = nativeGax('protobufjs'), statusJson = nativeGax('./build/protos/status.json');
    const statusType = P.Root.fromJSON(statusJson).lookupType('google.rpc.Status');
    const statusWire = Buffer.from(statusType.encode(statusType.fromObject({ code: 7, message: 'bootstrap-status' })).finish()).toString('base64');
    for (const file of ['operations.json', 'locations.json', 'iam_service.json']) {
      const defs = oracle.loader.fromJSON(nativeGax(`./build/protos/${file}`), oracle.loaderOptions);
      for (const def of Object.values(defs)) for (const method of Object.values(def)) if (method && typeof method.path === 'string') nativeMethods.set(method.path, method);
    }
    return `{name:${JSON.stringify(name)},gax:G${index},IamClient:I${index},GoogleErrorDecoder:E${index},statusWire:${JSON.stringify(statusWire)}}`;
  });
  for (const schema of oracle.schemas.filter(item => /@(google-cloud)\/(datastore(-api)?|secret-manager)\/build\/protos\/protos.json$/.test(item.path)
    || item.path.endsWith('@google-cloud/firestore/build/protos/v1.json'))) {
    const defs = oracle.loader.fromJSON(schema.json, oracle.loaderOptions);
    for (const def of Object.values(defs)) for (const method of Object.values(def)) if (method && typeof method.path === 'string') nativeMethods.set(method.path, method);
  }
  imports.push(`export {registry,applicationProtobuf,loader,loaderProtobuf};export const profileId=${JSON.stringify(id)};export const sdk={datastore,firestore,secret,auth};`,
    `export const schemas=data.map((schema,index)=>({...schema,P:[${oracle.schemas.map((_, index) => `P${index}`).join(',')}][index]}));`,
    `export const gaxCopies=[${gaxRows.join(',')}];`);
  const inputModule = imports.join('\n');
  const bootstrapEntry = path.join(root, 'fixtures/worker/bootstrap-catalog.mjs');
  const virtual = { name: 'bootstrap-fixture-imports', setup(build) {
    build.onResolve({ filter: /^wga:bootstrap-inputs$/ }, () => ({ path: 'bootstrap-inputs', namespace: 'bootstrap-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'bootstrap-fixture' }, () => ({ contents: inputModule, loader: 'js', resolveDir: project }));
    build.onResolve({ filter: /^@grpc\/grpc-js(?:\/.*)?$/ }, args => args.importer === bootstrapEntry ? { path: req.resolve(args.path) } : undefined);
  } };
  const built = await bundle(bootstrapEntry, path.join(outdir, 'worker'), [virtual, preset.plugin]);
  row.build = preset.manifest(); row.bundleSha256 = digest(built.script); row.bundleInspection = built.inspection;
  row.loaderResolution.bundleIncluded = ['loaderEntry', 'protobufEntry'].every(key => built.inputs.includes(row.loaderResolution.installed[key]));
  row.oracleInputsSha256 = digest(fs.readFileSync(dataFile));
  row.nativeSchemaSummary = oracle.schemas.map(schema => ({ path: schema.path, sourceSha256: schema.sourceSha256,
    typeNames: schema.types.map(type => type.name), protobufPath: schema.nativeProtobufPath,
    namespaces: schema.namespaces.map(value => ({ name: value.name, kind: value.kind, jsonSha256: hashObject(value.json) })),
    matrix: schema.types.flatMap(type => type.variants.map(variant => ({ type: type.name, label: variant.label,
      oracle: variant.oracle, wireSha256: hashObject(Buffer.from(variant.wire, 'base64')), objectSha256: hashObject(variant.object) }))) }));
  const receipts = [], barriers = new Map();
  const worker = runtime(built.script, async request => {
    try {
      const method = new URL(request.url).pathname, definition = nativeMethods.get(method);
      assert.ok(definition, `Real native method ${method}`);
      assert.equal(request.method, 'POST'); assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      assert.ok(['closure', 'seq-a', 'seq-b', 'parallel-a', 'parallel-b'].includes(token));
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
      const decoded = definition.requestDeserialize(bytes.subarray(5));
      let response;
      if (method.endsWith('/Lookup')) {
        assert.equal(decoded.keys[0].path[0].name, token);
        response = { found: [{ entity: { key: decoded.keys[0], properties: { marker: { stringValue: token } } } }] };
      } else if (method.endsWith('/GetSecret')) {
        assert.equal(decoded.name, `projects/bootstrap-project/secrets/${token}`); response = { name: decoded.name };
      } else if (method.endsWith('/BatchGetDocuments')) {
        assert.equal(token, 'closure');
        response = { missing: decoded.documents[0], readTime: { seconds: '1', nanos: 0 } };
      } else if (method.endsWith('/GetOperation')) response = { name: decoded.name, done: true, response: { typeUrl: 'bootstrap/complete', value: Buffer.from([1]) } };
      else if (method.endsWith('/GetLocation')) response = { name: decoded.name, locationId: decoded.name.split('/').at(-1) };
      else if (method.endsWith('/GetIamPolicy')) response = { version: 3, bindings: [{ role: `roles/${decoded.resource.split('/').at(-1)}`, members: ['user:bootstrap@example.invalid'] }] };
      else throw new Error(`Unexpected bootstrap RPC ${method}`);
      const logicalCallId = request.headers.get('x-wga-bootstrap-call-id');
      assert.ok(logicalCallId?.startsWith('wga-'));
      const receipt = { token, logicalCallId, method, requestSha256: digest(bytes), tokenSha256: digest(token), contentType: request.headers.get('content-type'), overlap: false };
      receipts.push(receipt);
      if (token.startsWith('parallel-')) {
        let barrier = barriers.get(method);
        if (!barrier) { barrier = { receipts: [], resolve: undefined }; barrier.promise = new Promise(resolve => { barrier.resolve = resolve; }); barriers.set(method, barrier); }
        barrier.receipts.push(receipt);
        if (barrier.receipts.length === 2) { barrier.receipts.forEach(value => { value.overlap = true; }); barrier.resolve(); }
        await bounded(barrier.promise, `overlapping-${method}`, 10000);
      }
      return new Response(Buffer.concat([frame(definition.responseSerialize(response)), frame(Buffer.from('grpc-status: 0\r\n'), true)]),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
    } catch (error) { report.failures.push(error.message); throw error; }
  });
  try {
    row.codecAudit = await responseJson(worker, '/codecs');
    row.closure = await responseJson(worker, '/closure');
    row.requests = [];
    for (const token of ['seq-a', 'seq-b']) row.requests.push(await responseJson(worker, `/request/${token}`));
    row.requests.push(...await Promise.all(['parallel-a', 'parallel-b'].map(token => responseJson(worker, `/request/${token}`))));
    const app = await responseJson(worker, '/application');
    assert.deepEqual(app.probe, baselineResult); assert.equal(app.independentCopies, true); assert.equal(app.prototypesUnchanged, true);
    assert.equal(hashTree(appCopy), applicationHash);
    row.application = { ...app, baseline: baselineResult, sourceTreeSha256: applicationHash, sourceTreeUnchanged: true,
      baselineBundleSha256: digest(baselineBundle.script), copiedPackageVersion: JSON.parse(fs.readFileSync(path.join(appCopy, 'package.json'))).version,
      precisionBoundary: { input: '9007199254740993', native: nativeApp.largeIntegerRoundtrip, workerd: app.probe.largeIntegerRoundtrip,
        matchesNative: nativeApp.largeIntegerRoundtrip === app.probe.largeIntegerRoundtrip, presetChangesBaseline: false },
      includedIndependentInput: built.inputs.some(file => path.resolve(root, file) === path.join(appCopy, 'src/type.js')),
      transformedIndependentInputs: row.build.transformed.filter(input => input.path.includes('application-protobuf')).length };
    row.receipts = receipts;
    for (const schema of row.nativeSchemaSummary) {
      const observed = row.codecAudit.schemas.find(value => value.path === schema.path);
      assert.deepEqual(observed.matrix, schema.matrix, `Native loader options match ${schema.path}`);
    }
    assert.equal(new Set(row.requests.map(value => value.isolateId)).size, 1);
    assert.deepEqual(row.requests.map(value => value.ordinal), [1, 2, 3, 4]);
    assert.equal(row.requests.at(-1).peakRequests, 2);
    assert.equal(receipts.filter(value => value.overlap).length, 4);
    assert.equal(new Set(row.requests.flatMap(value => value.accounting.calls.map(call => call.logicalCallId))).size, 8);
    row.status = 'passed';
  } finally { await worker.dispose(); row.runtimeDisposed = true; }
}

async function main() {
  await runProfile('google-static-v1', 'google', 'native');
  await runProfile('google-modern-v1', 'modern', 'modern-native');
  report.runtimeDisposed = true;
  report.cases = caseIds.map(id => ({ id, status: 'passed', profiles: ['google-static-v1', 'google-modern-v1'] }));
  report.catalogCases = report.cases.map(row => ({ ...row, catalogMatch: true }));
  report.status = 'passed';
  validateBootstrapCatalogReport(report);
}
main().catch(error => { report.status = 'failed'; report.error = { message: error.message, code: error.code, stack: error.stack }; console.error(error); process.exitCode = 1; })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/bootstrap-catalog.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ status: report.status, profiles: report.profiles.map(row => ({ id: row.id, status: row.status })),
      report: 'verification/bootstrap-catalog.json' }));
  });
