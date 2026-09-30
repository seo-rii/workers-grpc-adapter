'use strict';
// Verification only: inspect emitted dependency edges and installed package
// identity, not occurrences of "grpc" in comments, schemas, or declarations.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const digest = value => createHash('sha256').update(value).digest('hex');
const nativePackage = value => ['@grpc/grpc-js', 'grpc'].some(name => value === name || value.startsWith(`${name}/`));
const forbidden = value => nativePackage(value) || value === 'http2' || value === 'node:http2';

function executableImports(script) {
  const source = ts.createSourceFile('worker.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw Object.assign(new Error('Worker JavaScript did not parse'), { code: 'WGA_BUNDLE_PARSE' });
  const imports = [];
  const add = (node, kind) => {
    if (node && ts.isStringLiteralLike(node)) imports.push({ path: node.text, kind });
  };
  function visit(node) {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, 'import-statement');
    if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, 'export-statement');
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic-import');
      // The pinned esbuild/Wrangler pipeline emits this require shim, with an
      // optional collision suffix. Match AST identifiers, never raw text.
      if (ts.isIdentifier(callee) && (callee.text === 'require' || /^__require\d*$/.test(callee.text))) add(node.arguments[0], 'require-call');
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'module' && callee.name.text === 'require') add(node.arguments[0], 'require-call');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Map(imports.map(item => [`${item.kind}:${item.path}`, item])).values()].sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`));
}

function inspectSDKBundle({ stages, script }) {
  if (!Array.isArray(stages) || stages.length === 0 || stages.some(stage => !stage || typeof stage.name !== 'string' || !stage.name || typeof stage.workingDirectory !== 'string')
      || new Set(stages.map(stage => stage.name)).size !== stages.length || typeof script !== 'string' || !script.trim()) {
    throw Object.assign(new Error('Bundle stages or final JavaScript are missing'), { code: 'WGA_BUNDLE_PROVENANCE' });
  }
  const violations = [], packages = new Map(), stageReports = [];
  const packageCache = new Map();
  function owner(file) {
    let directory = path.dirname(file);
    const visited = [];
    let result;
    while (true) {
      if (packageCache.has(directory)) { result = packageCache.get(directory); break; }
      visited.push(directory);
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name) { result = { name: pkg.name, version: pkg.version || null, root: directory }; break; }
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const item of visited) packageCache.set(item, result);
    return result;
  }
  for (const { name, metafile, workingDirectory } of stages) {
    if (!metafile || !Object.keys(metafile.inputs || {}).length || !Object.keys(metafile.outputs || {}).length) {
      throw Object.assign(new Error('Bundle metafile is missing inputs or outputs'), { code: 'WGA_BUNDLE_PROVENANCE' });
    }
    let bundledInputs = 0;
    const included = new Set(Object.values(metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([file]) => file)));
    const externalImports = [];
    for (const [file, input] of Object.entries(metafile.inputs)) {
      // Declaration-only files and entirely eliminated inputs are not runtime
      // dependencies. Native transport in an included input is rejected even
      // when that package's top-level directory is an npm alias.
      if (!included.has(file)) continue;
      bundledInputs++;
      const identity = owner(path.resolve(workingDirectory, file));
      if (identity) {
        const key = `${identity.name}@${identity.version}`;
        const entry = packages.get(key) || { name: identity.name, version: identity.version, inputs: 0 };
        entry.inputs++; packages.set(key, entry);
        if (nativePackage(identity.name)) violations.push({ stage: name, kind: 'native-package', path: identity.name });
      }
      for (const dependency of input.imports || []) {
        if (dependency.external && forbidden(dependency.path)) violations.push({ stage: name, kind: 'input-import', path: dependency.path });
      }
    }
    for (const output of Object.values(metafile.outputs)) for (const dependency of output.imports || []) {
      if (!dependency.external) continue;
      externalImports.push({ path: dependency.path, kind: dependency.kind });
      if (forbidden(dependency.path)) violations.push({ stage: name, kind: 'output-import', path: dependency.path });
    }
    stageReports.push({ name, metafileSha256: digest(JSON.stringify(metafile)), bundledInputs,
      externalImports: [...new Map(externalImports.map(item => [`${item.kind}:${item.path}`, item])).values()].sort((a, b) => a.path.localeCompare(b.path)) });
  }
  const imports = executableImports(script);
  for (const dependency of imports) if (forbidden(dependency.path)) violations.push({ stage: 'final-javascript', kind: dependency.kind, path: dependency.path });
  const result = { status: violations.length ? 'failed' : 'passed', scope: 'included-package-provenance-and-static-executable-imports', bundleSha256: digest(script), stages: stageReports,
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), executableImports: imports,
    // Auth/proxy libraries may legitimately retain these Node builtins. They
    // are reported separately and do not imply native gRPC connection pooling.
    nonGrpcNetworkBuiltins: [...new Set(imports.map(item => item.path).filter(value => ['http', 'https', 'net', 'tls'].includes(value.replace(/^node:/, ''))))].sort(),
    nativeGrpcPackages: [...new Set(violations.filter(item => item.kind === 'native-package').map(item => item.path))],
    violations: [...new Map(violations.map(item => [JSON.stringify(item), item])).values()] };
  if (violations.length) throw Object.assign(new Error('Native gRPC transport survived SDK Worker bundling'), { code: 'WGA_NATIVE_GRPC_BUNDLE', inspection: result });
  return result;
}

module.exports = { inspectSDKBundle, executableImports };
