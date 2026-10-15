'use strict';
// Node-only build helper. Runtime consumers load only the generated package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { isBuiltin } = require('node:module');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message, diagnostic) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (diagnostic) error.diagnostic = diagnostic;
  throw error;
}
function resolveFile(projectRoot, value, option) {
  if (typeof value !== 'string' || !value) fail('WGA_PREBUNDLE_OPTIONS', `${option} must name a file`);
  const file = path.resolve(projectRoot, value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('WGA_PREBUNDLE_OPTIONS', `${option} must name an existing file`);
  return fs.realpathSync(file);
}
function packageOf(file, cache) {
  let directory = path.dirname(file);
  const visited = [];
  while (true) {
    if (cache.has(directory)) {
      const result = cache.get(directory);
      for (const entry of visited) cache.set(entry, result);
      return result;
    }
    visited.push(directory);
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      // A nameless package.json can set a nested CJS/ESM scope; it does not
      // replace the enclosing package's source identity.
      if (typeof json.name === 'string' && json.name) {
        const result = { root: fs.realpathSync(directory), name: json.name, version: json.version, packageJsonSha256: hash(fs.readFileSync(manifest)) };
        for (const entry of visited) cache.set(entry, result);
        return result;
      }
    }
    const parent = path.dirname(directory);
    if (directory === parent) {
      for (const entry of visited) cache.set(entry, undefined);
      return;
    }
    directory = parent;
  }
}
function publicPath(projectRoot, file, pkg) {
  if (pkg && typeof pkg.name === 'string') return `${pkg.name}@${pkg.version || 'unknown'}/${path.relative(pkg.root, file).split(path.sep).join('/')}`;
  const relative = path.relative(projectRoot, file);
  // Never write an absolute machine path into a portable artifact manifest.
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' ? relative.split(path.sep).join('/') : `external/${path.basename(file)}`;
}
function checkRuntimeGraph(projectRoot, metafile, profile) {
  const cache = new Map(), adapters = new Map(), inputs = [];
  const allowed = new Map();
  for (const pkg of profile.packages) {
    const resolved = profile.resolvedPaths.find(item => item.path === `${pkg.path}/package.json`);
    if (!resolved?.physicalPath) fail('WGA_PREBUNDLE_AUDIT', 'A profiled package has no inspected physical identity');
    if (!allowed.has(pkg.name)) allowed.set(pkg.name, new Set());
    allowed.get(pkg.name).add(path.dirname(resolved.physicalPath));
  }
  for (const [input, info] of Object.entries(metafile.inputs)) {
    const logical = path.resolve(projectRoot, input);
    if (!fs.existsSync(logical)) fail('WGA_PREBUNDLE_INPUT', 'A bundled input disappeared before it could be recorded');
    const physical = fs.realpathSync(logical), pkg = packageOf(physical, cache);
    if (pkg?.name === '@grpc/grpc-js') fail('WGA_PREBUNDLE_NATIVE_GRPC', 'Install workers-grpc-adapter under the @grpc/grpc-js alias', { logicalPath: logical, physicalPath: physical });
    if (pkg?.name === 'workers-grpc-adapter') adapters.set(pkg.root, pkg);
    if (allowed.has(pkg?.name) && !allowed.get(pkg.name).has(pkg.root)) fail('WGA_SOURCE_IDENTITY', `Bundled ${pkg.name} comes from an unverified physical installation`, { logicalPath: logical, physicalPath: physical, expected: [...allowed.get(pkg.name)] });
    if (pkg?.name.startsWith('@google-cloud/') && !allowed.has(pkg.name) && pkg.name !== '@google-cloud/promisify') fail('WGA_UNSUPPORTED_DEPENDENCY', `The selected profile does not verify ${pkg.name}`, { package: pkg.name, physicalPath: pkg.root });
    for (const dependency of info.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) fail('WGA_PREBUNDLE_EXTERNAL', `Unresolved runtime dependency ${JSON.stringify(dependency.path)}; install it in the build graph before generating a prebundle`, { path: input, import: dependency.path });
    }
    inputs.push({ path: publicPath(projectRoot, physical, pkg), sha256: hash(fs.readFileSync(physical)), bytes: info.bytes });
  }
  if (adapters.size !== 1) fail('WGA_PREBUNDLE_RUNTIME_IDENTITY', 'The wrapper and SDK must bundle exactly one physical workers-grpc-adapter installation', { installations: [...adapters.keys()] });
  for (const output of Object.values(metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!dependency.external || !isBuiltin(dependency.path)) fail('WGA_PREBUNDLE_EXTERNAL', `Unresolved runtime dependency ${JSON.stringify(dependency.path)}; install it in the build graph before generating a prebundle`, { import: dependency.path });
    }
  }
  const [adapter] = adapters.values();
  return { inputs: inputs.sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256)), adapter: { name: adapter.name, version: adapter.version, packageJsonSha256: adapter.packageJsonSha256, physicalInstallations: 1, ownership: 'prebundle' } };
}
function checkArtifact(ts, source, expected) {
  const ast = ts.createSourceFile('index.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let actual;
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  function visit(node) {
    // The annotation is intentionally unreachable and can contain names that
    // are otherwise runtime identifiers, such as an exported "require".
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && ts.isNumericLiteral(node.left) && node.left.text === '0') {
      const assignment = unwrap(node.right);
      if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && assignment.left.getText(ast) === 'module.exports' && ts.isObjectLiteralExpression(assignment.right)) {
        actual = assignment.right.properties.map(property => property.name?.text).sort();
        return;
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && !isBuiltin(node.arguments[0].text)) {
        fail('WGA_PREBUNDLE_EXTERNAL', `Unresolved runtime dependency ${JSON.stringify(node.arguments[0].text)}; install it in the build graph before generating a prebundle`, { import: node.arguments[0].text });
      }
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || !isBuiltin(node.arguments[0].text)) {
        fail('WGA_PREBUNDLE_DYNAMIC_IMPORT', 'The artifact contains an unresolved import or require; use a static wrapper entrypoint', {
          kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require', arguments: node.arguments.length,
          argumentKind: node.arguments[0] ? ts.SyntaxKind[node.arguments[0].kind] : 'missing',
          ...(node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? { path: node.arguments[0].text } : {}),
        });
      }
    }
    if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      const direct = ts.isCallExpression(parent) && parent.expression === node;
      const guard = ts.isTypeOfExpression(parent);
      const property = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      if (!direct && !guard && !property) fail('WGA_PREBUNDLE_DYNAMIC_IMPORT', 'The artifact uses require as a value; use explicit static imports');
    }
    // esbuild emits this Node export annotation from the actual entry namespace.
    // Read it without executing the wrapper, client constructors, or credentials.
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!actual || JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail('WGA_PREBUNDLE_EXPORTS', 'The wrapper must expose exactly the declared named exports', { expected: [...expected].sort(), actual: actual || [] });
  }
}
function checkDeclarations(ts, source, expected) {
  const ast = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), names = new Set();
  const reject = message => fail('WGA_PREBUNDLE_DECLARATIONS', message);
  if (ast.parseDiagnostics.length) reject('declarationFile contains invalid TypeScript syntax');
  const specifier = name => {
    if (name.startsWith('.') || name.startsWith('/') || name.startsWith('\\') || /^[a-z]:[/\\]|^file:/i.test(name)) reject('Declarations must use external package imports; relative declaration resources are not copied');
  };
  if (ast.referencedFiles.length) reject('Declaration reference paths are not copied into the generated package');
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier(node.argument.literal.text);
    if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) specifier(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  function binding(node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    else for (const element of node.elements) if (ts.isBindingElement(element)) binding(element.name);
  }
  for (const node of ast.statements) {
    if (ts.isExportAssignment(node) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) reject('Declarations must expose explicit named value exports');
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) reject('Declarations must list named exports instead of export *');
      if (!node.isTypeOnly) for (const item of node.exportClause.elements) if (!item.isTypeOnly) names.add(item.name.text);
    } else if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) binding(declaration.name);
      else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isModuleDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
      }
    }
  }
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...expected].sort())) fail('WGA_PREBUNDLE_DECLARATIONS', 'Declaration value exports must match the wrapper; use export type for additional type-only exports', { expected, actual: [...names].sort() });
}
/** Bundle an explicit server wrapper and its SDK/configuration into one runtime. */
async function buildGoogleWorkerPrebundle(options) {
  if (!options || typeof options !== 'object') fail('WGA_PREBUNDLE_OPTIONS', 'Pass prebundle options');
  const supported = new Set(['projectRoot', 'outdir', 'typescript', 'esbuild', 'entryPoint', 'exports', 'declarationFile', 'packageName', 'profile']);
  if (Object.keys(options).some(key => !supported.has(key))) fail('WGA_PREBUNDLE_OPTIONS', 'Unknown prebundle option');
  const { typescript: ts, esbuild } = options;
  if (!ts || typeof ts.createSourceFile !== 'function') fail('WGA_PREBUNDLE_OPTIONS', 'Pass the installed TypeScript compiler as typescript');
  if (!esbuild || typeof esbuild.build !== 'function' || typeof esbuild.version !== 'string') fail('WGA_PREBUNDLE_OPTIONS', 'Pass the installed esbuild module as esbuild');
  if (typeof options.projectRoot !== 'string' || !options.projectRoot || typeof options.outdir !== 'string' || !options.outdir) fail('WGA_PREBUNDLE_OPTIONS', 'projectRoot and outdir are required');
  const projectRoot = fs.realpathSync(path.resolve(options.projectRoot)), outdir = path.resolve(projectRoot, options.outdir);
  const entryPoint = resolveFile(projectRoot, options.entryPoint, 'entryPoint');
  const declarationFile = resolveFile(projectRoot, options.declarationFile, 'declarationFile');
  if (!/\.d\.[cm]?ts$/.test(declarationFile)) fail('WGA_PREBUNDLE_OPTIONS', 'declarationFile must be a TypeScript declaration file');
  if (!Array.isArray(options.exports) || !options.exports.length || options.exports.some(name => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name) || ['default', '__esModule'].includes(name))
    || new Set(options.exports).size !== options.exports.length) fail('WGA_PREBUNDLE_OPTIONS', 'exports must be unique named JavaScript exports');
  const names = [...options.exports].sort(), packageName = options.packageName || 'google-workers-prebundle';
  if (typeof packageName !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) fail('WGA_PREBUNDLE_OPTIONS', 'packageName must be a valid lowercase package name');
  // Never replace an existing package after a failed build or copy over inputs.
  if (fs.existsSync(outdir) && (!fs.statSync(outdir).isDirectory() || fs.readdirSync(outdir).length)) fail('WGA_PREBUNDLE_OUTPUT', 'outdir must be absent or empty; generate into a fresh directory before replacing an existing artifact');
  if (path.dirname(entryPoint) === outdir || path.dirname(declarationFile) === outdir) fail('WGA_PREBUNDLE_OUTPUT', 'Build inputs must be outside outdir');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-'));
  try {
    const { createGoogleWorkerBuild } = require('./index.cjs');
    const preset = createGoogleWorkerBuild({ projectRoot, outdir: path.join(temporary, 'registry'), profile: options.profile, typescript: ts });
    if (typeof preset.verifyBuild !== 'function') fail('WGA_PREBUNDLE_AUDIT', 'This prebundle helper requires the matching fail-closed build preset');
    let built;
    try {
      built = await esbuild.build({ absWorkingDir: projectRoot, entryPoints: [entryPoint], bundle: true, format: 'cjs', platform: 'node',
        target: 'es2022', outfile: path.join(temporary, 'index.cjs'), write: false, metafile: true, minify: true,
        legalComments: 'eof', sourcemap: false, logLevel: 'silent', plugins: [preset.plugin] });
    } catch (error) {
      // esbuild wraps plugin errors. Preserve the profile diagnostic contract.
      const cause = error.errors?.map(item => item.detail).find(detail => typeof detail?.code === 'string' && detail.code.startsWith('WGA_'));
      throw cause || error;
    }
    const coverage = preset.verifyBuild(built.metafile);
    const entry = Object.entries(built.metafile.inputs).find(([input]) => fs.realpathSync(path.resolve(projectRoot, input)) === entryPoint);
    if (entry?.[1].format !== 'esm') fail('WGA_PREBUNDLE_EXPORTS', 'entryPoint must be an ES module with explicit named exports');
    if (built.outputFiles.length !== 1) fail('WGA_PREBUNDLE_OUTPUT', 'Expected one self-contained JavaScript artifact');
    const source = built.outputFiles[0].text;
    checkArtifact(ts, source, names);
    const presetManifest = preset.manifest(), graph = checkRuntimeGraph(projectRoot, built.metafile, presetManifest);
    const declaration = fs.readFileSync(declarationFile);
    checkDeclarations(ts, declaration.toString('utf8'), names);
    const facade = `import owned from './index.cjs';\n${names.map((name, index) => `const value${index} = owned[${JSON.stringify(name)}];\nexport { value${index} as ${name} };\n`).join('')}`;
    const blocked = `throw new Error('WGA_PREBUNDLE_SERVER_ONLY: import this package only from server code');\n`;
    const pkg = { name: packageName, version: '0.0.0', private: true, type: 'commonjs', main: './index.cjs', module: './index.mjs', types: './index.d.ts', browser: './server-only.cjs',
      exports: { '.': { workerd: { types: './index.d.mts', default: './index.mjs' }, worker: { types: './index.d.mts', default: './index.mjs' }, browser: './server-only.cjs', import: { types: './index.d.mts', default: './index.mjs' }, require: { types: './index.d.cts', default: './index.cjs' } }, './manifest.json': './manifest.json', './package.json': './package.json' },
      files: ['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.mts', 'index.d.cts', 'server-only.cjs', 'manifest.json'] };
    const files = { 'index.cjs': source, 'index.mjs': facade, 'index.d.ts': declaration, 'index.d.mts': declaration, 'index.d.cts': declaration, 'server-only.cjs': blocked, 'package.json': JSON.stringify(pkg, null, 2) + '\n' };
    const artifacts = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }]));
    const manifest = { schemaVersion: 1, kind: 'google-worker-prebundle', serverOnly: true, exports: names, profile: presetManifest.profile, revision: presetManifest.revision,
      profileSha256: presetManifest.profileSha256, cacheKey: presetManifest.cacheKey, inputSha256: presetManifest.inputSha256, transformer: presetManifest.transformer,
      build: { prebundleVersion: 1, prebundleSha256: hash(fs.readFileSync(__filename)), esbuildVersion: esbuild.version, nodeVersion: process.version, format: 'cjs', target: 'es2022', minify: true, legalComments: 'eof', sourcemap: false },
      packages: presetManifest.packages, schemas: presetManifest.schemas, registrySha256: presetManifest.registrySha256,
      // Replacement text embeds a disposable registry path. The portable bundle
      // hash covers transformed output; retain path-independent source receipts.
      transformed: presetManifest.transformed.map(({ path: file, upstreamSha256, rules }) => ({ path: file, upstreamSha256, rules })),
      transformCoverage: coverage, runtime: graph.adapter, sources: graph.inputs,
      wrapper: { sha256: hash(fs.readFileSync(entryPoint)), declarationSha256: hash(declaration) }, artifacts };
    manifest.artifactSha256 = hash(JSON.stringify({ artifacts, exports: names, cacheKey: manifest.cacheKey }));
    files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
    fs.mkdirSync(path.dirname(outdir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(outdir), '.wga-prebundle-output-'));
    try {
      for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(staging, name), bytes);
      if (fs.existsSync(outdir)) {
        if (!fs.statSync(outdir).isDirectory() || fs.readdirSync(outdir).length) fail('WGA_PREBUNDLE_OUTPUT', 'outdir changed during the build; existing files were preserved');
        fs.rmdirSync(outdir);
      }
      fs.renameSync(staging, outdir);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    return { outdir, packageJsonPath: path.join(outdir, 'package.json'), manifestPath: path.join(outdir, 'manifest.json'), bundlePath: path.join(outdir, 'index.cjs'), typesPath: path.join(outdir, 'index.d.ts'), profileId: presetManifest.profile, exports: names };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { buildGoogleWorkerPrebundle };
