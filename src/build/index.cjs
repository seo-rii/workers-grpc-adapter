'use strict';
// Node-only, exact dependency profile. Runtime adapter imports never reach this file.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(code, detail) { const error = new Error(`${code}: ${detail}`); error.code = code; throw error; }
function readProfile(id) {
  if (id !== 'google-static-v1') fail('WGA_UNSUPPORTED_DEPENDENCY', 'Unknown build profile');
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles', `${id}.json`), 'utf8'));
}
function validateProfile(projectRoot, profile) {
  for (const pkg of profile.packages) {
    const packageFile = path.join(projectRoot, pkg.path, 'package.json');
    if (!fs.existsSync(packageFile)) fail('WGA_UNSUPPORTED_DEPENDENCY', pkg.path);
    const installed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (installed.name !== pkg.name || installed.version !== pkg.version) fail('WGA_UNSUPPORTED_DEPENDENCY', pkg.path);
  }
  for (const file of [...profile.files, ...profile.schemas, ...profile.codegenInputs]) {
    if (!fs.existsSync(path.join(projectRoot, file.path))) fail('WGA_SCHEMA_MISMATCH', file.path);
    if (hash(fs.readFileSync(path.join(projectRoot, file.path))) !== file.sha256) fail('WGA_SCHEMA_MISMATCH', file.path);
  }
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
  const ts = typescript;
  if (!ts || typeof ts.createSourceFile !== 'function') fail('WGA_UNSUPPORTED_DEPENDENCY', 'Pass the installed TypeScript compiler as typescript');
  fs.mkdirSync(outdir, { recursive: true });
  const registryFile = path.join(outdir, 'static-protobuf.cjs');
  const unique = new Map();
  let legacyKeySchema, datastoreStructSchema;
  for (const schema of profile.schemas) {
    const file = path.join(projectRoot, schema.path);
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
  const registryPrefix = `${profile.id}:${profile.revision}:${hash(JSON.stringify(profile.loaderOptions))}:`;
  const registrySource = `const {createHash}=require('node:crypto');\nconst registry={${[...unique].map(([key, item]) => `${JSON.stringify(registryPrefix + key)}:${item.source}`).join(',\n')}};\nexports.fromJSON=function(P,json,options){if(options && (options.keepCase!==false || options.longs!==String || options.enums!==String || options.defaults!==true || options.oneofs!==true || Object.keys(options).some(key=>!['keepCase','longs','enums','defaults','oneofs','includeDirs'].includes(key)))){const error=new Error('WGA_SCHEMA_MISMATCH: unsupported loader options');error.code='WGA_SCHEMA_MISMATCH';throw error;}const key=${JSON.stringify(registryPrefix)}+createHash('sha256').update(JSON.stringify(json)).digest('hex');const hydrate=registry[key];if(!hydrate){const error=new Error('WGA_SCHEMA_MISMATCH: unknown static protobuf schema');error.code='WGA_SCHEMA_MISMATCH';throw error;}const root=new P.Root();if(json.options)root.setOptions(json.options);root.addJSON(json.nested);return hydrate(P,root);};\n`;
  fs.writeFileSync(registryFile, registrySource);
  const transformed = new Map();
  const files = new Map(profile.files.map(file => [path.join(projectRoot, file.path), file]));
  const plugin = {
    name: 'wga-google-static-v1',
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, args => {
        const file = files.get(args.path);
        if (!file) return;
        const original = fs.readFileSync(args.path, 'utf8');
        if (hash(original) !== file.sha256) fail('WGA_SCHEMA_MISMATCH', file.path);
        const ast = ts.createSourceFile(args.path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const edits = [];
        let rootCalls = 0;
        let wellKnownLoads = 0;
        let nativeFetchDefaults = 0;
        const gaxiosTransport = /\/gaxios\/build\/(?:cjs|esm)\/src\/gaxios\.js$/.test(file.path);
        function visit(node) {
          if (gaxiosTransport && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fetchImpl') {
            const method = node.parent?.parent?.parent?.parent;
            const expected = 'config.fetchImplementation||this.defaults.fetchImplementation||(await_a.#getFetch())';
            if (!ts.isMethodDeclaration(method) || !ts.isIdentifier(method.name) || method.name.text !== '_defaultAdapter' || !node.initializer || node.initializer.getText(ast).replace(/\s/g, '') !== expected) fail('WGA_SCHEMA_MISMATCH', `${file.path}: unexpected Gaxios fetch selection`);
            // Only the default changes. Per-request and per-client fetch hooks
            // keep Gaxios's own precedence and credential ownership.
            edits.push({ start: node.initializer.getStart(ast), end: node.initializer.getEnd(), text: 'config.fetchImplementation || this.defaults.fetchImplementation || globalThis.fetch' });
            nativeFetchDefaults++;
            return;
          }
          if (file.path.endsWith('@google-cloud/datastore/build/src/request.js') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'loadSync') {
            if (node.expression.expression.getText(ast) !== 'gax.protobuf' || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== 'google/protobuf/struct.proto' || !datastoreStructSchema) fail('WGA_SCHEMA_MISMATCH', `${file.path}: unexpected well-known schema load`);
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: `require(${JSON.stringify(registryFile)}).fromJSON(gax.protobuf,${JSON.stringify(datastoreStructSchema)})` });
            wellKnownLoads++;
            return;
          }
          if (file.path.endsWith('@google-cloud/datastore/build/src/entity.js') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'loadSync') {
            edits.push({start:node.getStart(ast),end:node.getEnd(),text:`require(${JSON.stringify(registryFile)}).fromJSON(Protobuf,${JSON.stringify(legacyKeySchema)})`});
            return;
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'fromJSON' && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'Root') {
            const receiver = node.expression.expression.expression.getText(ast);
            if (node.arguments.length !== 1) fail('WGA_SCHEMA_MISMATCH', `${file.path}: unexpected Root.fromJSON signature`);
            edits.push({ start: node.getStart(ast), end: node.getEnd(), text: `require(${JSON.stringify(registryFile)}).fromJSON(${receiver},${node.arguments[0].getText(ast)}${file.path.endsWith('@grpc/proto-loader/build/src/index.js') ? ',options' : ''})` });
            rootCalls++;
            return;
          }
          if (ts.isIdentifier(node) && node.text === '__dirname') edits.push({ start: node.getStart(ast), end: node.getEnd(), text: JSON.stringify('/bundle/node_modules/' + file.path.split('node_modules/').pop().replace(/\/[^/]+$/, '')) });
          ts.forEachChild(node, visit);
        }
        visit(ast);
        if (gaxiosTransport && nativeFetchDefaults !== 1) fail('WGA_SCHEMA_MISMATCH', `${file.path}: expected one Gaxios fetch selection`);
        if (file.path.endsWith('@google-cloud/datastore/build/src/request.js') && wellKnownLoads !== 1) fail('WGA_SCHEMA_MISMATCH', `${file.path}: expected one well-known schema load`);
        if (!edits.length) fail('WGA_SCHEMA_MISMATCH', `${file.path}: no matching AST anchors`);
        let contents = original;
        for (const edit of edits.sort((a, b) => b.start - a.start)) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
        transformed.set(file.path, { path: file.path, upstreamSha256: file.sha256, replacementSha256: hash(contents), rootFromJSONCalls: rootCalls, wellKnownSchemaLoads: wellKnownLoads, nativeFetchDefaults, anchors: edits.map(({ start, end }) => ({ start, end })) });
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
  return {
    plugin,
    registryFile,
    manifest() { return { profile: profile.id, revision: profile.revision, profileSha256: hash(JSON.stringify(profile)), packages: profile.packages, loaderOptions: profile.loaderOptions, loaderOptionsSha256: hash(JSON.stringify(profile.loaderOptions)), schemas: [...unique].map(([jsonSha256, item]) => ({ path: item.schema, sourceSha256: item.sha256, jsonSha256, types: item.count, ...(item.common ? { common: item.common } : {}) })), registrySha256: hash(registrySource), transformed: [...transformed.values()].sort((a,b)=>a.path.localeCompare(b.path)), nodeModulesModified: false, globalPrototypePatched: false }; },
  };
}
module.exports = { createGoogleWorkerBuild };
