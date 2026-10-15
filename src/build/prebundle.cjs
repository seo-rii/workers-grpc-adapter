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
function bindSources(ts, sources) {
  const options = { allowJs: true, noResolve: true, noLib: true, types: [] }, host = ts.createCompilerHost(options);
  host.getSourceFile = file => sources.get(file);
  return ts.createProgram([...sources.keys()], options, host).getTypeChecker();
}
function checkModuleLoaders(ts, projectRoot, metafile) {
  // Inspect original module scopes: esbuild renames the CommonJS `module`
  // parameter, so a spelling-only check of the minified artifact misses it.
  const files = [...new Set(Object.keys(metafile.inputs).map(file => fs.realpathSync(path.resolve(projectRoot, file))))]
    .filter(file => /\.[cm]?[jt]sx?$/.test(file));
  const sources = new Map(files.map(file => [file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)]));
  const checker = bindSources(ts, sources), values = new Map();
  const MODULE = 1, NAMESPACE = 2, LOADER = 4, REQUIRE = 8;
  const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;
  const key = node => ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : undefined;
  const member = (origin, name) => {
    let result = 0;
    if (origin & MODULE) result |= name === 'require' ? LOADER : name === 'constructor' ? NAMESPACE : 0;
    if (origin & NAMESPACE) result |= ['createRequire', '_load', 'register', 'registerHooks'].includes(name) ? LOADER
      : ['Module', 'default'].includes(name) ? NAMESPACE : name === 'prototype' ? MODULE : 0;
    return result;
  };
  function bind(name, value, keys = []) {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) { if (!values.has(symbol)) values.set(symbol, []); values.get(symbol).push({ value, keys }); }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) bind(element.name, value, [...keys, key(element.propertyName || element.name)]);
    }
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) bind(node.left, node.right);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && ['module', 'node:module'].includes(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) bind(clause.name, NAMESPACE);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, NAMESPACE);
        else for (const item of clause.namedBindings.elements) bind(item.name, member(NAMESPACE, (item.propertyName || item.name).text));
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
      && ['module', 'node:module'].includes(node.moduleReference.expression.text)) bind(node.name, NAMESPACE);
    ts.forEachChild(node, collect);
  }
  for (const source of sources.values()) collect(source);
  function origin(expression, seen = new Set()) {
    if (typeof expression === 'number') return expression;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      // TypeScript can attach synthetic Identifier/BinaryExpression declarations
      // to the implicit CommonJS globals. Lexical declarations still shadow them.
      const local = symbol?.declarations?.some(declaration => !ts.isIdentifier(declaration) && !ts.isBinaryExpression(declaration) && !ts.isSourceFile(declaration));
      if (!local && node.text === 'module') return MODULE;
      if (!local && node.text === 'require') return REQUIRE;
      if (!symbol || seen.has(symbol)) return 0;
      const next = new Set(seen); next.add(symbol);
      return (values.get(symbol) || []).reduce((result, value) => result | value.keys.reduce(member, origin(value.value, next)), 0);
    }
    if (ts.isPropertyAccessExpression(node)) return member(origin(node.expression, seen), node.name.text);
    if (ts.isElementAccessExpression(node) && node.argumentExpression) return member(origin(node.expression, seen), key(node.argumentExpression));
    if (ts.isCallExpression(node) && origin(node.expression, seen) & REQUIRE && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]) && ['module', 'node:module'].includes(node.arguments[0].text)) return NAMESPACE;
    if (ts.isNewExpression(node) && origin(node.expression, seen) & NAMESPACE) return MODULE;
    return 0;
  }
  function visit(node) {
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && origin(node) & LOADER) {
      fail('WGA_PREBUNDLE_DYNAMIC_IMPORT', 'Node module loading APIs cannot remain in a self-contained prebundle; use explicit static imports', { path: node.getSourceFile().fileName });
    }
    ts.forEachChild(node, visit);
  }
  for (const source of sources.values()) visit(source);
}
function checkExportStability(ts, entryPoint, source, expected) {
  const reject = name => fail('WGA_PREBUNDLE_EXPORT_STABILITY', 'Public export bindings must be stable; expose a factory or a stable object for changing state', { export: name });
  const wrapper = ts.createSourceFile(entryPoint, fs.readFileSync(entryPoint, 'utf8'), ts.ScriptTarget.Latest, true), mutable = new Set();
  function names(node, into) {
    if (ts.isIdentifier(node)) into.add(node.text);
    else for (const element of node.elements) if (ts.isBindingElement(element)) names(element.name, into);
  }
  for (const statement of wrapper.statements) {
    if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const)) {
      const declared = new Set();
      for (const declaration of statement.declarationList.declarations) names(declaration.name, declared);
      for (const name of declared) mutable.add(name);
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) reject([...declared].join(', '));
    }
  }
  for (const statement of wrapper.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) if (!item.isTypeOnly && mutable.has((item.propertyName || item.name).text)) reject(item.name.text);
    }
  }
  // Follow esbuild's actual export getters instead of guessing where a wrapper
  // re-export originated. The facade may snapshot stable bindings only.
  const file = `${entryPoint}.wga-artifact.cjs`, ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const checker = bindSources(ts, new Map([[file, ast]])), namespaces = new Set(), bindings = [];
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  function target(expression) {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol && { symbol, keys: [] };
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = target(node.expression);
      return base && { symbol: base.symbol, keys: [...base.keys, node.name.text] };
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
      const base = target(node.expression);
      return base && { symbol: base.symbol, keys: [...base.keys, node.argumentExpression.text] };
    }
  }
  function namespace(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(ast) === 'module.exports'
      && ts.isCallExpression(node.right) && node.right.arguments.length === 1 && ts.isIdentifier(node.right.arguments[0])) {
      namespaces.add(checker.getSymbolAtLocation(node.right.arguments[0]));
    }
    ts.forEachChild(node, namespace);
  }
  namespace(ast);
  function getters(node) {
    if (ts.isCallExpression(node) && node.arguments.length === 2 && ts.isIdentifier(node.arguments[0])
      && namespaces.has(checker.getSymbolAtLocation(node.arguments[0])) && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const property of node.arguments[1].properties) {
        if (!ts.isPropertyAssignment(property) || !expected.includes(property.name.text) || !ts.isArrowFunction(property.initializer)) continue;
        const binding = !ts.isBlock(property.initializer.body) && target(property.initializer.body);
        if (!binding) reject(property.name.text);
        bindings.push({ ...binding, name: property.name.text });
      }
    }
    ts.forEachChild(node, getters);
  }
  getters(ast);
  if (JSON.stringify(bindings.map(binding => binding.name).sort()) !== JSON.stringify([...expected].sort())) reject('unrecognized export getter');
  function write(expression) {
    const node = unwrap(expression), assigned = target(node);
    if (assigned) {
      for (const binding of bindings) if (binding.symbol === assigned.symbol && JSON.stringify(binding.keys) === JSON.stringify(assigned.keys)) reject(binding.name);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) if (!ts.isOmittedExpression(element)) write(ts.isSpreadElement(element) ? element.expression : element);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) write(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) write(property.name);
        else if (ts.isSpreadAssignment(property)) write(property.expression);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) write(node.left);
  }
  function mutations(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) write(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) write(node.operand);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) write(node.initializer);
    ts.forEachChild(node, mutations);
  }
  mutations(ast);
}
function checkDeclarations(ts, source, expected) {
  const ast = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), names = new Set();
  const reject = message => fail('WGA_PREBUNDLE_DECLARATIONS', message);
  if (ast.parseDiagnostics.length) reject('declarationFile contains invalid TypeScript syntax');
  const specifier = name => {
    if (name.startsWith('.') || name.startsWith('/') || name.startsWith('\\') || /^[a-z]:[/\\]|^file:/i.test(name)) reject('Declarations must use external package imports; relative declaration resources are not copied');
  };
  if (ast.referencedFiles.length) reject('Declaration reference paths are not copied into the generated package');
  for (const reference of ast.typeReferenceDirectives) specifier(reference.fileName);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier(node.argument.literal.text);
    if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) specifier(node.expression.text);
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) specifier(node.name.text);
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
  if (!ts || typeof ts.createSourceFile !== 'function' || typeof ts.createProgram !== 'function' || typeof ts.createCompilerHost !== 'function') fail('WGA_PREBUNDLE_OPTIONS', 'Pass the installed TypeScript compiler as typescript');
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
    checkModuleLoaders(ts, projectRoot, built.metafile);
    checkExportStability(ts, entryPoint, source, names);
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
      for (const [name, bytes] of Object.entries(files)) {
        const file = path.join(staging, name);
        fs.writeFileSync(file, bytes);
        fs.chmodSync(file, 0o644);
      }
      fs.chmodSync(staging, 0o755);
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
