'use strict';
// Node-only, exact dependency profile. Runtime adapter imports never reach this file.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(code, detail) { const error = new Error(`${code}: ${detail}`); error.code = code; throw error; }
function readProfile(id) {
  if (!['google-static-v1', 'google-modern-v1'].includes(id)) fail('WGA_UNSUPPORTED_DEPENDENCY', 'Unknown build profile');
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles', `${id}.json`), 'utf8'));
}
// Increment when transformation semantics or generated codec conventions change.
const transformerVersion = 1;
const transformationRules = new Set(['static-root-from-json', 'datastore-struct', 'native-fetch-default',
  'firestore-watch-end', 'preserve-static-setup', 'legacy-buffer-base64', 'datastore-legacy-key', 'bundle-dirname', 'gax-package-metadata']);
// Profile paths name dependency roles, not a package manager's disk layout.
// Resolve from each declared importer without importing any inspected module.
function resolveProfileInputs(projectRoot, profile) {
  const packages = new Map(), visiting = new Set(), diagnostics = [];
  const byPath = new Map(profile.packages.map(pkg => [pkg.path, pkg]));
  const physical = file => fs.existsSync(file) ? fs.realpathSync(file) : file;
  function resolvePackage(pkg) {
    if (packages.has(pkg.path)) return packages.get(pkg.path);
    if (visiting.has(pkg.path)) fail('WGA_UNSUPPORTED_DEPENDENCY', `Cyclic profile importer: ${pkg.path}`);
    visiting.add(pkg.path);
    const parent = pkg.resolveFrom && byPath.get(pkg.resolveFrom);
    if (pkg.resolveFrom && !parent) fail('WGA_UNSUPPORTED_DEPENDENCY', `Unknown profile importer: ${pkg.resolveFrom}`);
    const importer = parent ? path.join(resolvePackage(parent), 'package.json') : path.join(projectRoot, 'package.json');
    const req = createRequire(importer);
    let manifest;
    // package.json may be hidden by exports. These are Node's importer-specific
    // lookup directories, including pnpm's physical dependency links.
    for (const directory of req.resolve.paths(pkg.name) || []) {
      const candidate = path.join(directory, pkg.name, 'package.json');
      if (fs.existsSync(candidate)) { manifest = candidate; break; }
    }
    const logicalPath = path.join(projectRoot, pkg.path);
    if (!manifest) {
      diagnostics.push({ kind: 'package-resolution', path: `${pkg.path}/package.json`, expected: `${pkg.name}@${pkg.version}`, actual: null,
        logicalPath, physicalPath: null, importer, reason: 'missing' });
    }
    const directory = manifest ? path.dirname(physical(manifest)) : logicalPath;
    packages.set(pkg.path, directory); visiting.delete(pkg.path);
    return directory;
  }
  for (const pkg of profile.packages) resolvePackage(pkg);
  const owners = [...profile.packages].sort((a, b) => b.path.length - a.path.length);
  const resolve = relative => {
    const owner = owners.find(pkg => relative === pkg.path || relative.startsWith(pkg.path + '/'));
    return physical(owner ? path.join(packages.get(owner.path), relative.slice(owner.path.length)) : path.join(projectRoot, relative));
  };
  const context = relative => ({ logicalPath: path.join(projectRoot, relative), physicalPath: resolve(relative) });
  return { packages, resolve, context, diagnostics,
    paths: [...new Set([...profile.packages.map(pkg => `${pkg.path}/package.json`), ...profile.files.map(file => file.path),
      ...profile.schemas.map(file => file.path), ...profile.codegenInputs.map(file => file.path)])].map(relative => ({ path: relative, ...context(relative) })) };
}
function profileDiagnostics(projectRoot, profile) {
  const diagnostics = [];
  const add = (kind, file, expected, actual, extra = {}) => diagnostics.push({ kind, path: file, expected, actual, ...extra });
  if (profile.schemaVersion !== 1) add('manifest', 'schemaVersion', 1, profile.schemaVersion ?? null);
  if (profile.transformerVersion !== transformerVersion) add('transformer', 'transformerVersion', transformerVersion, profile.transformerVersion ?? null);
  for (const key of ['capabilities', 'requiredChecks']) {
    if (!Array.isArray(profile[key]) || profile[key].some(value => typeof value !== 'string' || !value)) add('manifest', key, 'array of nonempty strings', profile[key] ?? null);
  }
  for (const key of ['packages', 'files', 'schemas', 'codegenInputs']) {
    if (!Array.isArray(profile[key])) { add('manifest', key, 'array', profile[key] ?? null); continue; }
    for (const entry of profile[key]) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path
        || path.isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
        add('manifest', key, 'entries with relative input paths', entry);
      } else if (!/^[a-f0-9]{64}$/.test(key === 'packages' ? entry.packageJsonSha256 : entry.sha256)) {
        add('manifest', entry.path, 'SHA256 input hash', (key === 'packages' ? entry.packageJsonSha256 : entry.sha256) ?? null);
      }
    }
  }
  if (diagnostics.some(item => item.kind === 'manifest')) return diagnostics;
  let resolution;
  try { resolution = resolveProfileInputs(projectRoot, profile); }
  catch (error) { add('manifest', 'packages.resolveFrom', 'acyclic declared importer paths', error.message); return diagnostics; }
  diagnostics.push(...resolution.diagnostics);
  for (const pkg of profile.packages) {
    const relative = `${pkg.path}/package.json`, file = resolution.resolve(relative);
    if (!fs.existsSync(file)) { add('package', relative, `${pkg.name}@${pkg.version}`, null, { reason: 'missing' }); continue; }
    let installed;
    try { installed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { add('package', relative, 'valid package.json', null, { reason: 'invalid-json' }); continue; }
    if (installed.name !== pkg.name) add('package-name', relative, pkg.name, installed.name ?? null, resolution.context(relative));
    if (installed.version !== pkg.version) add('package-version', relative, pkg.version, installed.version ?? null, resolution.context(relative));
    const actual = hash(fs.readFileSync(file));
    if (actual !== pkg.packageJsonSha256) add('package-hash', relative, pkg.packageJsonSha256 ?? null, actual, resolution.context(relative));
  }
  for (const [kind, files] of [['source-hash', profile.files], ['schema-hash', profile.schemas], ['codegen-hash', profile.codegenInputs]]) {
    for (const file of files) {
      const absolute = resolution.resolve(file.path);
      const actual = fs.existsSync(absolute) ? hash(fs.readFileSync(absolute)) : null;
      if (actual !== file.sha256) add(kind, file.path, file.sha256, actual, { ...resolution.context(file.path), ...(actual === null ? { reason: 'missing' } : {}) });
    }
  }
  for (const file of profile.files) {
    if (!Array.isArray(file.transforms) || !file.transforms.length) { add('transformation', file.path, 'nonempty transform declarations', null); continue; }
    const seen = new Set();
    for (const transform of file.transforms) {
      if (!transform || typeof transform !== 'object') { add('transformation', file.path, 'rule declaration', transform); continue; }
      if (!transformationRules.has(transform.rule)) add('transformation', file.path, [...transformationRules], transform.rule, { rule: transform.rule, reason: 'unknown-rule' });
      if (!Number.isSafeInteger(transform.expectedMatches) || transform.expectedMatches < 1) add('transformation', file.path, 'positive integer', transform.expectedMatches, { rule: transform.rule, reason: 'invalid-count' });
      if (seen.has(transform.rule)) add('transformation', file.path, 'unique rule', transform.rule, { rule: transform.rule, reason: 'duplicate-rule' });
      seen.add(transform.rule);
      if (transform.rule === 'gax-package-metadata') {
        const owner = profile.packages.find(pkg => pkg.name === 'google-gax' && file.path === `${pkg.path}/build/src/observability/metadataResolver.js`);
        const candidate = path.resolve(path.dirname(resolution.resolve(file.path)), '../../package.json');
        const fallback = path.resolve(path.dirname(resolution.resolve(file.path)), '../../../package.json');
        const verifiedRoot = owner && fs.existsSync(fallback) && fs.realpathSync(fallback) === resolution.resolve(`${owner.path}/package.json`);
        // The reviewed source first tries build/package.json, then its package
        // root. Redirecting that first lookup is valid only while it is absent.
        // Check again at onStart/onEnd so a changed layout cannot reuse receipts.
        if (!verifiedRoot || fs.existsSync(candidate)) add('transformation', file.path, 'verified GAX package root with no build/package.json',
          verifiedRoot ? 'build/package.json exists' : 'unexpected package root', { rule: transform.rule, reason: 'package-layout', ...resolution.context(file.path) });
      }
    }
  }
  return diagnostics;
}
function throwDiagnostic(diagnostic) {
  const code = diagnostic.kind === 'source-identity' ? 'WGA_SOURCE_IDENTITY'
    : diagnostic.kind.startsWith('package') || diagnostic.kind === 'transformer' ? 'WGA_UNSUPPORTED_DEPENDENCY' : 'WGA_SCHEMA_MISMATCH';
  const error = new Error(`${code}: ${diagnostic.path}${diagnostic.rule ? ` (${diagnostic.rule})` : ''}: expected ${JSON.stringify(diagnostic.expected)}, actual ${JSON.stringify(diagnostic.actual)}`);
  error.code = code;
  error.diagnostic = diagnostic;
  throw error;
}
function validateProfile(projectRoot, profile) {
  const diagnostics = profileDiagnostics(projectRoot, profile);
  if (diagnostics.length) throwDiagnostic(diagnostics[0]);
}
function allTypes(P, namespace) {
  const result = namespace instanceof P.Type ? [namespace] : [];
  for (const value of namespace.nestedArray || []) result.push(...allTypes(P, value));
  return result;
}
function generateHydrator(P, json) {
  const root = P.Root.fromJSON(json).resolveAll();
  const types = allTypes(P, root);
  const source = ['function(P,root){const util=P.util,Reader=P.Reader,Writer={create:()=>new P.Writer()};'];
  // A scoped Uint8Array writer avoids workerd's stricter Buffer.utf8Write defaults.
  // Constructors must be assigned before codecs. Field.resolve() uses parent.ctor.
  for (const type of types) source.push(`root.lookupType(${JSON.stringify(type.fullName)}).ctor=${P.Type.generateConstructor(type).toString()};`);
  source.push('root.resolveAll();');
  for (const type of types) {
    source.push(`{const type=root.lookupType(${JSON.stringify(type.fullName)});const types=type.fieldsArray.map(field=>field.resolvedType);`);
    for (const [method, generator] of [['encode', P.encoder], ['decode', P.decoder], ['verify', P.verifier], ['fromObject', P.converter.fromObject], ['toObject', P.converter.toObject]]) source.push(`type.${method}=${generator(type).toString()};`);
    source.push(`const wrapper=P.wrappers[type.fullName];if(wrapper){const original=Object.create(type);original.fromObject=type.fromObject;type.fromObject=wrapper.fromObject.bind(original);original.toObject=type.toObject;type.toObject=wrapper.toObject.bind(original);} }`);
  }
  source.push('return root;}');
  return { source: source.join('\n'), count: types.length };
}
/** Prepare an esbuild plugin and an auditable static registry without mutating dependencies. */
function createGoogleWorkerBuild({ projectRoot, outdir, profile: profileId = 'google-static-v1', typescript }) {
  projectRoot = path.resolve(projectRoot);
  outdir = path.resolve(outdir);
  const profile = readProfile(profileId);
  validateProfile(projectRoot, profile);
  const resolution = resolveProfileInputs(projectRoot, profile);
  const ts = typescript;
  if (!ts || typeof ts.createSourceFile !== 'function') fail('WGA_UNSUPPORTED_DEPENDENCY', 'Pass the installed TypeScript compiler as typescript');
  const compiler = /^(\d+)\.(\d+)\./.exec(ts.version || '');
  if (!compiler || Number(compiler[1]) !== 5 || Number(compiler[2]) < 8) fail('WGA_UNSUPPORTED_DEPENDENCY', 'Build profiles require TypeScript >=5.8 <6; use an isolated build workspace for other app compilers');
  fs.mkdirSync(outdir, { recursive: true });
  const registryFile = path.join(outdir, 'static-protobuf.cjs');
  const unique = new Map();
  let legacyKeySchema, datastoreStructSchema;
  for (const schema of profile.schemas) {
    const file = resolution.resolve(schema.path);
    const req = createRequire(file);
    const P = req('protobufjs');
    const json = schema.common ? P.common[schema.common] : file.endsWith('.proto') ? P.loadSync(file).toJSON() : JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json || typeof json !== 'object') fail('WGA_SCHEMA_MISMATCH', `${schema.path}: unknown common schema`);
    if (file.endsWith('app_engine_key.proto')) legacyKeySchema = json;
    if (schema.common === 'google/protobuf/struct.proto') datastoreStructSchema = json;
    const key = hash(JSON.stringify(json));
    if (!unique.has(key)) {
      unique.set(key, { ...generateHydrator(P, json), schema: schema.path, sha256: schema.sha256, common: schema.common });
    }
  }
  // Includes actual transformer bytes as well as an explicit semantic version: even
  // an unversioned local transformer edit cannot reuse a previous registry key.
  const transformer = { version: transformerVersion, sha256: hash(fs.readFileSync(__filename)), typescriptVersion: ts.version };
  const inputSha256 = hash(JSON.stringify({ packages: profile.packages.map(pkg => [pkg.path, pkg.packageJsonSha256]),
    sources: [...profile.files, ...profile.schemas, ...profile.codegenInputs].map(file => [file.path, file.sha256]) }));
  const cacheKey = hash(JSON.stringify({ profileSha256: hash(JSON.stringify(profile)), transformer, inputSha256 }));
  const registryPrefix = `${profile.id}:${profile.revision}:${cacheKey}:`;
  const registrySource = `const {createHash}=require('node:crypto');\nconst registry={${[...unique].map(([key, item]) => `${JSON.stringify(registryPrefix + key)}:${item.source}`).join(',\n')}};\nexports.fromJSON=function(P,json,options){if(options && (options.keepCase!==false || options.longs!==String || options.enums!==String || options.defaults!==true || options.oneofs!==true || Object.keys(options).some(key=>!['keepCase','longs','enums','defaults','oneofs','includeDirs'].includes(key)))){const error=new Error('WGA_SCHEMA_MISMATCH: unsupported loader options');error.code='WGA_SCHEMA_MISMATCH';throw error;}const key=${JSON.stringify(registryPrefix)}+createHash('sha256').update(JSON.stringify(json)).digest('hex');const hydrate=registry[key];if(!hydrate){const error=new Error('WGA_SCHEMA_MISMATCH: unknown static protobuf schema');error.code='WGA_SCHEMA_MISMATCH';throw error;}const root=new P.Root();if(json.options)root.setOptions(json.options);root.addJSON(json.nested);return hydrate(P,root);};\n`;
  fs.writeFileSync(registryFile, registrySource);
  const transformed = new Map();
  const moduleReceipts = new Map();
  const moduleIdentity = (namespace, input, suffix = '') => JSON.stringify([namespace || 'file', path.resolve(projectRoot, input), suffix]);
  const files = new Map(profile.files.map(file => [resolution.resolve(file.path), file]));
  const logicalFiles = new Map(profile.files.map(file => [path.join(projectRoot, file.path), file]));
  const targets = profile.files.map(file => {
    const owner = [...profile.packages].sort((a, b) => b.path.length - a.path.length).find(pkg => file.path.startsWith(pkg.path + '/'));
    return { file, owner, suffix: owner ? file.path.slice(owner.path.length + 1) : undefined };
  });
  let coverage = { required: 0, applied: 0, unused: profile.files.length, passed: false };
  function targetFor(input) {
    const absolute = path.resolve(projectRoot, input);
    // Doctor and callers can also name an importer-resolved profile role that
    // is not a literal nested path in an isolated installation.
    if (logicalFiles.has(absolute)) return logicalFiles.get(absolute);
    const canonical = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    if (files.has(canonical)) return files.get(canonical);
    // Catch another installation of a transform target. Matching names or even
    // bytes cannot substitute for the inspected physical source identity.
    const candidates = targets.filter(target => target.suffix && canonical.endsWith(path.sep + target.suffix.split('/').join(path.sep)));
    for (const target of candidates) {
      const directory = canonical.slice(0, -(target.suffix.length + 1));
      const manifest = path.join(directory, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === target.owner.name) throwDiagnostic({ kind: 'source-identity', path: target.file.path,
        expected: resolution.resolve(target.file.path), actual: canonical, logicalPath: path.join(projectRoot, target.file.path), physicalPath: canonical, reason: 'unverified-installation' });
    }
  }
  function moduleFor(input, workingDirectory) {
    function match(namespace, name) {
      const absolute = path.resolve(workingDirectory, name), file = targetFor(absolute);
      if (file) return { file, identity: moduleIdentity(namespace, absolute) };
      // A real path can contain literal ?, # or :, including directory names.
      // Only interpret a suffix or namespace after trying that complete path.
      if (fs.existsSync(absolute)) return { existing: true };
      for (let index = name.length - 1; index >= 0; index--) {
        if (name[index] !== '?' && name[index] !== '#') continue;
        const source = path.resolve(workingDirectory, name.slice(0, index));
        const target = targetFor(source);
        if (target) return { file: target, identity: moduleIdentity(namespace, source, name.slice(index)) };
      }
    }
    const direct = match('file', input);
    if (direct) return direct.file ? direct : undefined;
    // Non-file namespace inputs retain their absolute logical path in the
    // metafile. Keep it distinct from aliases of the same canonical source.
    for (let separator = input.indexOf(':'); separator >= 0; separator = input.indexOf(':', separator + 1)) {
      if (!separator) continue;
      // A namespace may itself contain ':'. Select a boundary only when its
      // remaining path identifies a known source, rather than guessing a name.
      const custom = match(input.slice(0, separator), input.slice(separator + 1));
      if (custom?.file) return custom;
    }
  }
  function verifyBuild(metafile, workingDirectory = projectRoot) {
    coverage = { required: 0, applied: 0, unused: profile.files.length, passed: false };
    if (!metafile || !metafile.inputs) fail('WGA_TRANSFORM_COVERAGE', 'Build requires an esbuild metafile');
    validateProfile(projectRoot, profile);
    // Re-resolution catches dependency-link changes after preparation.
    const current = resolveProfileInputs(projectRoot, profile);
    for (const item of resolution.paths) {
      if (current.resolve(item.path) !== item.physicalPath) fail('WGA_SOURCE_IDENTITY', `${item.path}: inspected installation changed`);
    }
    const required = new Set(), missing = new Set(), missingInputs = [];
    for (const input of Object.keys(metafile.inputs)) {
      const module = moduleFor(input, workingDirectory);
      if (!module) continue;
      required.add(module.file.path);
      if (moduleReceipts.get(module.identity) !== module.file.path) {
        missing.add(module.file.path); missingInputs.push(input);
      }
    }
    coverage = { required: required.size, applied: required.size - missing.size, unused: profile.files.length - required.size, passed: missing.size === 0 };
    if (missing.size) fail('WGA_TRANSFORM_COVERAGE', `Required module transformations were bypassed: ${missingInputs.join(', ')}`);
    return { ...coverage };
  }
  const plugin = {
    name: 'wga-google-static-v1',
    setup(build) {
      if (build.initialOptions) build.initialOptions.metafile = true;
      build.onStart?.(() => { transformed.clear(); moduleReceipts.clear(); coverage = { required: 0, applied: 0, unused: profile.files.length, passed: false }; validateProfile(projectRoot, profile); });
      build.onEnd?.(result => {
        if (result.errors.length) return;
        verifyBuild(result.metafile, path.resolve(build.initialOptions?.absWorkingDir || process.cwd()));
      });
      build.onLoad({ filter: /\.js$/ }, args => {
        const file = targetFor(args.path);
        if (!file) return;
        const sourcePath = resolution.resolve(file.path);
        const original = fs.readFileSync(sourcePath, 'utf8');
        const actualHash = hash(original);
        if (actualHash !== file.sha256) throwDiagnostic({ kind: 'source-hash', path: file.path, expected: file.sha256, actual: actualHash });
        const ast = ts.createSourceFile(args.path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const edits = [];
        let rootCalls = 0;
        let wellKnownLoads = 0;
        let nativeFetchDefaults = 0;
        let precompiledSetups = 0;
        let legacyBufferConversions = 0;
        let firestoreWatchEndDeferrals = 0;
        let legacyKeyLoads = 0;
        let dirnameReplacements = 0;
        let gaxPackageMetadataLoads = 0;
        const declared = new Set(file.transforms.map(item => item.rule));
        const ruleFailure = (rule, actual) => throwDiagnostic({ kind: 'transformation', path: file.path, rule,
          expected: 'supported AST shape', actual, reason: 'anchor-shape' });
        const firestoreInitializer = declared.has('firestore-watch-end');
        const modernDatastoreEntity = declared.has('preserve-static-setup') || declared.has('legacy-buffer-base64');
        const gaxiosTransport = declared.has('native-fetch-default');
        function visit(node) {
          if (declared.has('gax-package-metadata') && ts.isTryStatement(node)) {
            const first = node.tryBlock.statements[0];
            if (first && ts.isExpressionStatement(first) && ts.isBinaryExpression(first.expression)
              && first.expression.left.getText(ast) === 'fallbackVersion') {
              function versionImport(block) {
                if (block.statements.length !== 1 || !ts.isExpressionStatement(block.statements[0])) return;
                const assignment = block.statements[0].expression;
                if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
                  || !ts.isIdentifier(assignment.left) || assignment.left.text !== 'fallbackVersion'
                  || !ts.isPropertyAccessExpression(assignment.right) || assignment.right.name.text !== 'version') return;
                const call = assignment.right.expression;
                if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require'
                  || call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])) return;
                return call.arguments[0];
              }
              const primary = versionImport(node.tryBlock), fallback = node.catchClause?.block.statements[0];
              const secondary = fallback && ts.isTryStatement(fallback) ? versionImport(fallback.tryBlock) : undefined;
              const previous = ts.isSourceFile(node.parent) ? node.parent.statements[node.parent.statements.indexOf(node) - 1] : undefined;
              const declaration = previous && ts.isVariableStatement(previous) ? previous.declarationList : undefined;
              if (!declaration || (declaration.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Let || declaration.declarations.length !== 1
                || declaration.declarations[0].name.getText(ast) !== 'fallbackVersion' || declaration.declarations[0].initializer
                || primary?.text !== '../../package.json' || secondary?.text !== '../../../package.json'
                || node.finallyBlock || node.catchClause.variableDeclaration || node.catchClause.block.statements.length !== 1
                || fallback.finallyBlock || !fallback.catchClause || fallback.catchClause.variableDeclaration
                || fallback.catchClause.block.statements.length !== 0) ruleFailure('gax-package-metadata', 'unexpected GAX package version fallback');
              // Both candidates now statically name the verified package root.
              // Keep the SDK's assignment, catch behavior and header precedence.
              edits.push({ start: primary.getStart(ast), end: primary.getEnd(), text: JSON.stringify('../../../package.json') });
              gaxPackageMetadataLoads++;
              return;
            }
          }
          if (firestoreInitializer && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'pipe' && node.expression.expression.getText(ast) === 'backendStream') {
            let method = node.parent;
            while (method && !ts.isMethodDeclaration(method)) method = method.parent;
            if (!method || method.name.getText(ast) !== '_initializeStream'
              || method.parameters.map(parameter => parameter.getText(ast)).join(',') !== 'backendStream,lifetime,requestTag,request'
              || node.arguments.length !== 1 || node.arguments[0].getText(ast) !== 'resultStream'
              || !ts.isExpressionStatement(node.parent)) ruleFailure('firestore-watch-end', 'unexpected Firestore stream pipe');
            // Only Listen passes a request. Its deferred error must reach Watch
            // before EOF can cause an UNKNOWN reconnect and hide the status.
            edits.push({ start: node.parent.getStart(ast), end: node.parent.getEnd(), text: "backendStream.pipe(resultStream, { end: !request });\nif (request) { backendStream.on('end', () => { setImmediate(() => resultStream.end()); }); }" });
            firestoreWatchEndDeferrals++;
            return;
          }
          if (declared.has('legacy-buffer-base64') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'toString' && node.expression.expression.getText(ast) === 'buffer') {
            let method = node.parent;
            while (method && !ts.isMethodDeclaration(method)) method = method.parent;
            if (!method || method.name.getText(ast) !== 'convertToBase64_' || node.arguments.length !== 1
              || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== 'base64') ruleFailure('legacy-buffer-base64', 'unexpected legacy base64 conversion');
            // Static encoders use Uint8Array writers in workerd. This SDK helper
            // specifically needs Buffer's base64 conversion, not Array#toString.
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: "Buffer.from(buffer).toString('base64')" });
            legacyBufferConversions++;
            return;
          }
          if (declared.has('preserve-static-setup') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setup') {
            const receiver = node.expression.expression;
            const loop = node.parent?.parent?.parent;
            const names = loop && ts.isForOfStatement(loop) && ts.isArrayLiteralExpression(loop.expression)
              ? loop.expression.elements.map(item => ts.isStringLiteral(item) ? item.text : null) : [];
            if (node.arguments.length !== 0 || !ts.isCallExpression(receiver) || receiver.expression.getText(ast) !== 'loadedRoot.lookupType'
              || receiver.arguments.length !== 1 || receiver.arguments[0].getText(ast) !== 'typeName'
              || JSON.stringify(names) !== JSON.stringify(['Reference', 'Path', 'Element'])
              || !ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1
              || loop.initializer.declarations[0].name.getText(ast) !== 'typeName') ruleFailure('preserve-static-setup', 'unexpected legacy codec setup');
            // The registry has already assigned this type's static codecs. The
            // pinned SDK's new setup() would regenerate them with runtime eval.
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: receiver.getText(ast) });
            precompiledSetups++;
            return;
          }
          if (gaxiosTransport && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fetchImpl') {
            const method = node.parent?.parent?.parent?.parent;
            const expected = 'config.fetchImplementation||this.defaults.fetchImplementation||(await_a.#getFetch())';
            if (!ts.isMethodDeclaration(method) || !ts.isIdentifier(method.name) || method.name.text !== '_defaultAdapter' || !node.initializer || node.initializer.getText(ast).replace(/\s/g, '') !== expected) ruleFailure('native-fetch-default', 'unexpected Gaxios fetch selection');
            // Only the default changes. Per-request and per-client fetch hooks
            // keep Gaxios's own precedence and credential ownership.
            edits.push({ start: node.initializer.getStart(ast), end: node.initializer.getEnd(), text: 'config.fetchImplementation || this.defaults.fetchImplementation || globalThis.fetch' });
            nativeFetchDefaults++;
            return;
          }
          if (declared.has('datastore-struct') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'loadSync') {
            if (node.expression.expression.getText(ast) !== 'gax.protobuf' || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== 'google/protobuf/struct.proto' || !datastoreStructSchema) ruleFailure('datastore-struct', 'unexpected well-known schema load');
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: `require(${JSON.stringify(registryFile)}).fromJSON(gax.protobuf,${JSON.stringify(datastoreStructSchema)})` });
            wellKnownLoads++;
            return;
          }
          if (declared.has('datastore-legacy-key') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'loadSync') {
            if (node.expression.expression.getText(ast) !== 'root' || node.arguments.length !== 1 || node.arguments[0].getText(ast).replace(/\s/g, '') !== "path.join(__dirname,'..','protos','app_engine_key.proto')" || !legacyKeySchema) ruleFailure('datastore-legacy-key', 'unexpected legacy key schema load');
            legacyKeyLoads++;
            edits.push({start:node.getStart(ast),end:node.getEnd(),text:`require(${JSON.stringify(registryFile)}).fromJSON(Protobuf,${JSON.stringify(legacyKeySchema)})`});
            return;
          }
          if (declared.has('static-root-from-json') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'fromJSON' && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'Root') {
            const receiver = node.expression.expression.expression.getText(ast);
            if (node.arguments.length !== 1) ruleFailure('static-root-from-json', 'unexpected Root.fromJSON signature');
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: `require(${JSON.stringify(registryFile)}).fromJSON(${receiver},${node.arguments[0].getText(ast)}${file.path.endsWith('@grpc/proto-loader/build/src/index.js') ? ',options' : ''})` });
            rootCalls++;
            return;
          }
          if (declared.has('bundle-dirname') && ts.isIdentifier(node) && node.text === '__dirname') { dirnameReplacements++; edits.push({ start: node.getStart(ast), end: node.getEnd(), text: JSON.stringify('/bundle/node_modules/' + file.path.split('node_modules/').pop().replace(/\/[^/]+$/, '')) }); }
          ts.forEachChild(node, visit);
        }
        visit(ast);
        const matches = { 'static-root-from-json': rootCalls, 'datastore-struct': wellKnownLoads,
          'native-fetch-default': nativeFetchDefaults, 'firestore-watch-end': firestoreWatchEndDeferrals,
          'preserve-static-setup': precompiledSetups, 'legacy-buffer-base64': legacyBufferConversions,
          'datastore-legacy-key': legacyKeyLoads, 'bundle-dirname': dirnameReplacements, 'gax-package-metadata': gaxPackageMetadataLoads };
        for (const transform of file.transforms) {
          if (matches[transform.rule] !== transform.expectedMatches) throwDiagnostic({ kind: 'transformation', path: file.path,
            rule: transform.rule, expected: transform.expectedMatches, actual: matches[transform.rule], reason: 'anchor-count' });
        }
        if (!edits.length) fail('WGA_SCHEMA_MISMATCH', `${file.path}: no matching AST anchors`);
        let contents = original;
        for (const edit of edits.sort((a, b) => b.start - a.start)) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
        transformed.set(file.path, { path: file.path, upstreamSha256: file.sha256, replacementSha256: hash(contents), rules: file.transforms.map(item => ({ rule: item.rule, matches: matches[item.rule] })), rootFromJSONCalls: rootCalls, wellKnownSchemaLoads: wellKnownLoads, nativeFetchDefaults,
          ...(firestoreInitializer ? { firestoreWatchEndDeferrals } : {}),
          ...(modernDatastoreEntity ? { precompiledSetups, legacyBufferConversions } : {}), anchors: edits.map(({ start, end }) => ({ start, end })) });
        moduleReceipts.set(moduleIdentity(args.namespace, args.path, args.suffix || ''), file.path);
        return { contents, loader: 'js', resolveDir: path.dirname(sourcePath) };
      });
    },
  };
  return {
    plugin,
    registryFile,
    verifyBuild,
    manifest() { return { profile: profile.id, revision: profile.revision, profileSha256: hash(JSON.stringify(profile)), cacheKey, inputSha256, transformer, capabilities: profile.capabilities, requiredChecks: profile.requiredChecks, resolvedPaths: resolution.paths, transformCoverage: { ...coverage }, packages: profile.packages, loaderOptions: profile.loaderOptions, loaderOptionsSha256: hash(JSON.stringify(profile.loaderOptions)), schemas: [...unique].map(([jsonSha256, item]) => ({ path: item.schema, sourceSha256: item.sha256, jsonSha256, types: item.count, ...(item.common ? { common: item.common } : {}) })), registrySha256: hash(registrySource), transformed: [...transformed.values()].sort((a,b)=>a.path.localeCompare(b.path)), nodeModulesModified: false, globalPrototypePatched: false }; },
  };
}
/** Read-only checks; optional AST validation uses a disposable generated registry. */
function inspectGoogleWorkerProfile({ projectRoot, profile: profileId = 'google-static-v1', typescript }) {
  projectRoot = path.resolve(projectRoot);
  const profile = readProfile(profileId);
  const diagnostics = profileDiagnostics(projectRoot, profile);
  let transformationsChecked = false, buildIdentity;
  if (!diagnostics.length && typescript) {
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wga-profile-doctor-'));
    try {
      const preset = createGoogleWorkerBuild({ projectRoot, outdir: directory, profile: profileId, typescript });
      const inspectionResolution = resolveProfileInputs(projectRoot, profile);
      let load;
      preset.plugin.setup({ onLoad(_options, callback) { load = callback; } });
      for (const file of profile.files) {
        try {
          const loaded = load({ path: inspectionResolution.resolve(file.path) });
          if (!loaded) fail('WGA_TRANSFORM_COVERAGE', `${file.path}: transformation was not inspected`);
        }
        catch (error) { diagnostics.push(error.diagnostic ?? { kind: 'transformation', path: file.path, expected: 'matching AST anchors', actual: error.message, reason: 'anchor-shape' }); }
      }
      transformationsChecked = true;
      const { cacheKey, inputSha256, transformer } = preset.manifest();
      buildIdentity = { cacheKey, inputSha256, transformer };
    } catch (error) { diagnostics.push(error.diagnostic ?? { kind: 'generation', path: profileId, expected: 'valid static schemas', actual: error.message }); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  return { profile: profile.id, revision: profile.revision, passed: diagnostics.length === 0,
    resolvedPaths: diagnostics.some(item => item.kind === 'manifest') ? [] : resolveProfileInputs(projectRoot, profile).paths,
    scope: typescript ? 'package, source, schema, codegen and transformation checks' : 'package, source, schema and codegen checks; AST checks not requested',
    transformationsChecked, diagnostics, capabilities: profile.capabilities, requiredChecks: profile.requiredChecks,
    ...(buildIdentity ? { buildIdentity } : {}) };
}
module.exports = { createGoogleWorkerBuild, inspectGoogleWorkerProfile,
  buildGoogleWorkerPrebundle: options => require('./prebundle.cjs').buildGoogleWorkerPrebundle(options) };

// Lazy forwarding keeps standalone profile inspection independent of graph tools.
module.exports.inspectGoogleWorkerGraph = options => require('./doctor.cjs').inspectGoogleWorkerGraph(options);
