'use strict';
// Node-only build helper. Runtime consumers load only the generated package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { isBuiltin } = require('node:module');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// An async build can outlive a source-file update; identify its loaded helper.
const implementationSha256 = hash(fs.readFileSync(__filename));
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
function packageOf(file, cache, read) {
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
      const source = read(manifest), json = JSON.parse(source.contents.toString('utf8'));
      // A nameless package.json can set a nested CJS/ESM scope; it does not
      // replace the enclosing package's source identity.
      if (typeof json.name === 'string' && json.name) {
        const result = { root: fs.realpathSync(directory), name: json.name, version: json.version, packageJsonSha256: source.sha256 };
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
function captureBuildInputs(projectRoot, preset, ts) {
  const files = new Map(), modules = new Map(), packages = new Map(), scopes = new Map();
  const absent = new Set(), configDirectories = new Set(), configurationInputs = new Set();
  let sealed = false;
  function fileVersion(logical, physical) {
    const file = fs.statSync(physical, { bigint: true });
    const link = logical === physical ? file : fs.lstatSync(logical, { bigint: true });
    return [file, link].map(stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).join('|');
  }
  function read(logical) {
    logical = path.resolve(logical);
    if (!files.has(logical)) {
      if (sealed) fail('WGA_PREBUNDLE_INPUT_CHANGED', 'The build discovered a new input after its snapshot was sealed; retry with a stable source tree', { logicalPath: logical });
      const physical = fs.realpathSync(logical), version = fileVersion(logical, physical), contents = fs.readFileSync(physical);
      if (configurationInputs.has(logical) && fileVersion(logical, physical) !== version) fail('WGA_PREBUNDLE_INPUT_CHANGED', 'Compiler configuration changed while it was captured; retry with a stable source tree', { logicalPath: logical });
      files.set(logical, { logical, physical, contents, sha256: hash(contents), version });
    }
    return files.get(logical);
  }
  function optionalRead(file, configuration = false) {
    if (configuration) configurationInputs.add(path.resolve(file));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return read(file);
    absent.add(path.resolve(file));
  }
  function captureConfig(file) {
    let directory = path.dirname(file);
    while (!configDirectories.has(directory)) {
      configDirectories.add(directory);
      const config = path.join(directory, 'tsconfig.json');
      if (optionalRead(config, true)) {
        // Track inherited configs and package resolution receipts as well as
        // the nearest config. esbuild owns validation/lowering; TypeScript's
        // config reader only discovers the files that must remain stable.
        ts.getParsedCommandLineOfConfigFile(config, {}, {
          useCaseSensitiveFileNames: true, getCurrentDirectory: () => projectRoot,
          readDirectory: () => [], fileExists: file => !!optionalRead(file, true),
          readFile: file => optionalRead(file, true)?.contents.toString('utf8'),
          onUnRecoverableConfigFileDiagnostic() {},
        });
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  function unchanged(source) {
    let physical = null, sha256 = null, version = null, changedDuringRead = false;
    const configuration = configurationInputs.has(source.logical);
    try {
      physical = fs.realpathSync(source.logical);
      if (configuration) version = fileVersion(source.logical, physical);
      sha256 = hash(fs.readFileSync(physical));
      if (configuration) changedDuringRead = version !== fileVersion(source.logical, physical);
    } catch { /* Diagnose removed inputs like changed inputs. */ }
    if (physical !== source.physical || sha256 !== source.sha256 || configuration && (version !== source.version || changedDuringRead)) fail('WGA_PREBUNDLE_INPUT_CHANGED', 'A build input changed after it was captured; retry with a stable source tree', {
      logicalPath: source.logical, physicalPath: source.physical, actualPhysicalPath: physical, expectedSha256: source.sha256, actualSha256: sha256,
      metadataChanged: configuration && (version !== source.version || changedDuringRead),
    });
  }
  function nodeEsm(file) {
    if (/\.[cm][jt]s$/.test(file)) return /\.m[jt]s$/.test(file);
    let directory = path.dirname(file);
    const visited = [];
    while (true) {
      if (scopes.has(directory)) break;
      visited.push(directory);
      const manifest = path.join(directory, 'package.json'), parent = path.dirname(directory);
      if (path.basename(directory) === 'node_modules') { scopes.set(directory, false); break; }
      const scope = optionalRead(manifest);
      if (scope) { scopes.set(directory, JSON.parse(scope.contents).type === 'module'); break; }
      if (parent === directory) { scopes.set(directory, false); break; }
      directory = parent;
    }
    const result = scopes.get(directory);
    for (const parent of visited) scopes.set(parent, result);
    return result;
  }
  function record(args, source, contents, loader = 'default') {
    if (args.namespace !== 'file') fail('WGA_PREBUNDLE_AUDIT', 'Only captured file inputs may enter the prebundle');
    const key = path.resolve(args.path) + (args.suffix || ''), loadedSha256 = hash(contents);
    const previous = modules.get(key);
    if (previous && (previous.source.physical !== source.physical || previous.source.sha256 !== source.sha256 || previous.loadedSha256 !== loadedSha256)) {
      fail('WGA_PREBUNDLE_AUDIT', 'One bundled input has conflicting source receipts', { path: key });
    }
    captureConfig(source.physical);
    modules.set(key, { source, moduleIdentity: JSON.stringify([args.namespace, path.resolve(args.path), args.suffix || '']),
      loadedSha256, loadedBytes: Buffer.byteLength(contents), contents: Buffer.from(contents), loader,
      pkg: packageOf(source.physical, packages, read), nodeEsm: nodeEsm(source.physical) });
  }
  // Supplying the captured bytes to esbuild is essential: hashing the file only
  // before/after build() cannot identify an intermediate version it consumed.
  const plugin = { name: 'wga-prebundle-source-receipts', setup(build) {
    preset.plugin.setup({ ...build, onLoad(options, callback) {
      build.onLoad(options, async args => {
        const source = read(args.path), loaded = await callback(args);
        if (loaded?.contents !== undefined) {
          unchanged(source);
          // The preset reads pinned upstream bytes and returns transformed text.
          // Bind both identities to this receipt without changing its guards.
          const manifest = preset.manifest();
          const transformed = manifest.transformed.find(item => manifest.resolvedPaths.some(resolved => resolved.path === item.path && resolved.physicalPath === source.physical));
          const registry = source.physical === fs.realpathSync(preset.registryFile);
          if (source.sha256 !== (registry ? manifest.registrySha256 : transformed?.upstreamSha256)
            || hash(loaded.contents) !== (registry ? manifest.registrySha256 : transformed?.replacementSha256)) {
            fail('WGA_PREBUNDLE_AUDIT', 'The captured source does not match the verified transform input and output', { path: source.logical });
          }
          record(args, source, loaded.contents, loaded.loader);
        }
        return loaded;
      });
    } });
    build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
      const source = read(args.path);
      record(args, source, source.contents);
      return { contents: source.contents, loader: 'default', resolveDir: path.dirname(args.path) };
    });
  } };
  return { plugin, read, prepare(entry) {
    // The resolver may consume entry settings before its first onLoad hook.
    captureConfig(entry); nodeEsm(entry); packageOf(entry, packages, read);
  }, seal() { sealed = true; }, verify() {
    for (const source of files.values()) unchanged(source);
    for (const logical of absent) if (fs.existsSync(logical) && fs.statSync(logical).isFile()) fail('WGA_PREBUNDLE_INPUT_CHANGED', 'A configuration lookup changed during the build; retry with a stable source tree', { logicalPath: logical });
  },
    inputs(metafile) {
      return Object.entries(metafile.inputs).map(([input, info]) => {
        const receipt = modules.get(path.resolve(projectRoot, input));
        if (!receipt || receipt.loadedBytes !== info.bytes) fail('WGA_PREBUNDLE_AUDIT', 'A bundled input has no matching consumed-source receipt', { path: input });
        return { input, info, ...receipt };
      });
    },
  };
}
async function preserveModuleStrictness(esbuild, ts, projectRoot, captured, entry, names, outfile) {
  // Keep the captured ESM graph together inside one strict factory. Separately
  // lowering its files to CJS loses instantiation-time re-export bindings in
  // cycles and creates a fresh namespace wrapper at each import. Original CJS
  // factories stay outside that strict boundary and retain their own mode.
  // Every stage resolves only the previously audited edges.
  const modules = new Map(captured.map((receipt, index) => [receipt.input, { ...receipt, id: `module-${index}.cjs` }]));
  const byId = new Map([...modules.values()].map(receipt => [receipt.id, receipt]));
  const extensionLoader = file => ({ '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx',
    '.json': 'json', '.css': 'css' }[path.extname(file)] || 'js');
  const sources = new Map();
  for (const receipt of modules.values()) {
    receipt.loader = receipt.loader === 'default' ? extensionLoader(receipt.source.physical) : receipt.loader;
    if (!['js', 'jsx', 'ts', 'tsx'].includes(receipt.loader)) continue;
    // Normal extensions let the binder see scopes even for extensionless JS.
    const file = path.join(projectRoot, `${receipt.id}.${receipt.loader}`);
    receipt.ast = ts.createSourceFile(file, receipt.contents.toString('utf8'), ts.ScriptTarget.Latest, true);
    sources.set(file, receipt.ast);
  }
  const checker = bindSources(ts, sources);
  const edges = new Map(), dynamicModules = new Map();
  const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;
  function specifierText(expression) {
    const node = unwrap(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = specifierText(span.expression);
        if (part === undefined) return;
        value += part + span.literal.text;
      }
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = specifierText(node.left), right = specifierText(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
  }
  function specifierChoices(expression) {
    const node = unwrap(expression), value = specifierText(node);
    if (value !== undefined) return [value];
    if (ts.isConditionalExpression(node)) {
      const whenTrue = specifierChoices(node.whenTrue), whenFalse = specifierChoices(node.whenFalse);
      if (whenTrue && whenFalse) return [...new Set([...whenTrue, ...whenFalse])];
    }
  }
  function resolveEdge(receipt, specifier, kind) {
    const matches = receipt.info.imports.filter(dependency => (dependency.original || dependency.path) === specifier && dependency.kind === kind);
    // esbuild can omit import("node:module", {}) from the first metafile
    // while removing its empty options during compilation. Builtins have no
    // package resolution condition or physical installation to reselect.
    if (matches.length === 0 && isBuiltin(specifier)) return { path: specifier, external: true };
    const resolutions = new Set(matches.map(edge => JSON.stringify([edge.path, !!edge.external])));
    if (resolutions.size !== 1) fail('WGA_PREBUNDLE_AUDIT', 'A strict module import has no unique captured resolution', { path: receipt.input, import: specifier, kind });
    return matches[0];
  }
  for (const receipt of modules.values()) {
    if (!receipt.ast) continue;
    let source = receipt.contents.toString('utf8');
    const ast = receipt.ast;
    const replacements = [];
    for (const statement of ast.statements) {
      if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
        && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression) {
        const specifier = statement.moduleReference.expression, value = specifierText(specifier);
        if (value !== undefined && receipt.info.imports.some(edge => edge.kind === 'require-call' && (edge.original || edge.path) === value)) {
          const token = `wga-captured-import:${edges.size}`;
          edges.set(token, resolveEdge(receipt, value, 'require-call'));
          replacements.push({ start: specifier.getStart(ast), end: specifier.end, text: JSON.stringify(token) });
        }
      }
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.isTypeOnly || statement.importClause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      const matches = receipt.info.imports.filter(dependency => (dependency.original || dependency.path) === specifier.text && dependency.kind === 'import-statement');
      // Type-only named imports can be erased by the parser without an edge.
      if (!matches.length) continue;
      const edge = resolveEdge(receipt, specifier.text, 'import-statement'), token = `wga-captured-import:${edges.size}`;
      edges.set(token, edge);
      replacements.push({ start: specifier.getStart(ast), end: specifier.end, text: JSON.stringify(token) });
    }
    const identifiers = new Set(), imports = [];
    function identify(node) { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, identify); }
    identify(ast);
    function rewriteCalls(node) {
      const callee = ts.isCallExpression(node) && unwrap(node.expression);
      if (callee && ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1
        && !checker.getSymbolAtLocation(callee)?.declarations?.some(declaration => !ts.isIdentifier(declaration) && !ts.isBinaryExpression(declaration) && !ts.isSourceFile(declaration))) {
        const argument = node.arguments[0], start = argument.getStart(ast);
        const value = specifierText(argument);
        if (value !== undefined && receipt.info.imports.some(edge => edge.kind === 'require-call' && (edge.original || edge.path) === value)) {
          const token = `wga-captured-import:${edges.size}`;
          edges.set(token, resolveEdge(receipt, value, 'require-call'));
          replacements.push({ start, end: argument.end, text: JSON.stringify(token) });
        } else {
          // Let esbuild fold the same static expression it originally accepted,
          // while tagging its require condition independently of injected JSX.
          replacements.push({ start, end: argument.end, text: `"wga-original-require:" + (${source.slice(start, argument.end)})` });
        }
      }
      if (callee?.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && node.arguments.length <= 2) {
        const choices = specifierChoices(node.arguments[0]);
        // Only surviving, finite imports from the first audited graph may be
        // dispatched. Preserve evaluation of the original arguments/options.
        const resolutions = (choices || []).flatMap(specifier => {
          if (!isBuiltin(specifier) && !receipt.info.imports.some(edge => edge.kind === 'dynamic-import'
            && (edge.original || edge.path) === specifier)) return [];
          const edge = resolveEdge(receipt, specifier, 'dynamic-import');
          const target = edge.external ? undefined : modules.get(edge.path);
          return [{ specifier, edge, esm: target?.info.format === 'esm', commonJs: target && target.info.format !== 'esm' }];
        });
        if ((receipt.nodeEsm && resolutions.some(resolution => resolution.commonJs))
          || (receipt.info.format !== 'esm' && resolutions.some(resolution => resolution.esm))) {
          let name = '__wgaDynamicImport'; while (identifiers.has(name)) name += '_'; identifiers.add(name);
          const branches = resolutions.map(({ specifier, edge, esm, commonJs }) => {
            const token = `wga-captured-import:${edges.size}`; edges.set(token, edge);
            let load = esm ? `Promise.resolve().then(() => require(${JSON.stringify(token)}))` : `import(${JSON.stringify(token)})`;
            if (receipt.nodeEsm && commonJs) {
              // The final CJS bundle must still apply a Node ESM importer's
              // CJS default interop, including modules with __esModule set.
              const id = `dynamic-${dynamicModules.size}.mjs`;
              dynamicModules.set(id, `export function load() { return ${load}; }`);
              const bridge = `wga-captured-import:${edges.size}`; edges.set(bridge, { dynamicModule: id });
              load = `require(${JSON.stringify(bridge)}).load()`;
            }
            return `case ${JSON.stringify(specifier)}: return ${load};`;
          });
          const id = `dynamic-${dynamicModules.size}.cjs`;
          dynamicModules.set(id, `exports.load = function(specifier) { switch(specifier) { ${branches.join('\n')} } throw new Error('Uncaptured dynamic import target'); };`);
          const token = `wga-captured-import:${edges.size}`;
          edges.set(token, { dynamicModule: id });
          imports.push(receipt.info.format === 'esm' ? `import {load as ${name}} from ${JSON.stringify(token)};`
            : `function ${name}(specifier) { return import(${JSON.stringify(token)}).then(loaded => loaded.load(specifier)); }`);
          replacements.push({ start: node.expression.getStart(ast), end: node.expression.end, text: name });
        }
      }
      ts.forEachChild(node, rewriteCalls);
    }
    rewriteCalls(ast);
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
    if (imports.length) {
      let insertion = source.match(/^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/)?.[0].length || 0;
      let strict = false, escapedStrict;
      for (const statement of ast.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
        insertion = statement.end;
        if (statement.expression.text === 'use strict') {
          const literal = statement.expression.getText(ast);
          if (literal === '"use strict"' || literal === "'use strict'") strict = true;
          else escapedStrict ??= statement.getStart(ast);
        }
      }
      // Declarations before a directive disable CJS strictness. Keep the whole
      // prologue and terminate an ASI directive before inserting the helpers.
      // An escaped pseudo-directive is not strict; leave it after a declaration
      // so esbuild cannot reprint its decoded text as a new strict directive.
      if (!strict && escapedStrict !== undefined) insertion = escapedStrict;
      source = source.slice(0, insertion) + ';\n' + imports.join('\n') + '\n' + source.slice(insertion);
    }
    receipt.contents = source;
  }
  const scripts = [...modules.values()].filter(receipt => ['js', 'jsx', 'ts', 'tsx'].includes(receipt.loader));
  const byPath = new Map(scripts.map(receipt => [path.resolve(projectRoot, receipt.input), receipt]));
  // Keep the original file paths for this non-bundling compilation. esbuild
  // then retains package type/default-import interop and per-file tsconfig
  // lowering, which transform(sourcefile) alone cannot infer.
  for (const esm of [false, true]) {
    const group = scripts.filter(receipt => (receipt.info.format === 'esm') === esm);
    if (!group.length) continue;
    const compiled = await esbuild.build({ absWorkingDir: projectRoot,
      entryPoints: Object.fromEntries(group.map(receipt => [receipt.id, path.resolve(projectRoot, receipt.input)])),
      outdir: path.join(path.dirname(outfile), 'modules'), bundle: false, format: esm ? 'esm' : 'cjs', platform: 'node', target: 'es2022',
      write: false, legalComments: 'eof', sourcemap: false, logLevel: 'silent', plugins: [{ name: 'wga-captured-module-compilation', setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          const receipt = byPath.get(path.resolve(args.path) + (args.suffix || ''));
          if (!receipt) fail('WGA_PREBUNDLE_AUDIT', 'Module compilation requested uncaptured source');
          return { contents: receipt.contents, loader: receipt.loader, resolveDir: path.dirname(args.path) };
        });
      } }] });
    for (const receipt of group) {
      const output = compiled.outputFiles.find(file => path.basename(file.path) === `${receipt.id}.js`);
      if (!output) fail('WGA_PREBUNDLE_AUDIT', 'A captured module has no compiled output');
      // Hashbangs belong only at the start of an entry, never inside a factory.
      receipt.contents = output.text.replace(/^#![^\n]*(?:\n|$)/, '');
      receipt.loader = 'js';
    }
  }
  function capturedEdge(args, importer) {
    if (edges.has(args.path)) return edges.get(args.path);
    // Original require calls were tagged before compilation, unlike imports
    // introduced by JSX lowering. Never reselect the other export condition.
    return args.path.startsWith('wga-original-require:')
      ? resolveEdge(importer, args.path.slice('wga-original-require:'.length), 'require-call')
      : resolveEdge(importer, args.path, args.kind === 'require-call'
        && importer.info.imports.some(item => item.kind === 'import-statement' && (item.original || item.path) === args.path)
        ? 'import-statement' : args.kind);
  }
  const esmModules = [...modules.values()].filter(receipt => receipt.info.format === 'esm');
  const esmById = new Map(esmModules.map(receipt => [`${receipt.id}.${receipt.nodeEsm ? 'mjs' : 'js'}`, receipt]));
  const externalModules = new Map();
  const esmGraph = await esbuild.build({ absWorkingDir: projectRoot, entryPoints: ['wga-esm-entry'],
    bundle: true, format: 'cjs', platform: 'node', target: 'es2022', write: false, minify: false,
    legalComments: 'eof', sourcemap: false, logLevel: 'silent', plugins: [{ name: 'wga-captured-esm-graph', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return { path: 'entry.cjs', namespace: 'wga-esm' };
        if (args.importer === 'entry.cjs') return args.path.startsWith('wga-esm-value:')
          ? { path: args.path.slice('wga-esm-value:'.length), namespace: 'wga-esm' }
          : { path: args.path, namespace: 'wga-esm-namespace' };
        if (args.namespace === 'wga-esm-namespace') return { path: args.path, namespace: 'wga-esm' };
        const importer = esmById.get(args.importer);
        if (!importer) fail('WGA_PREBUNDLE_AUDIT', 'The ESM graph requested an uncaptured importer');
        const edge = capturedEdge(args, importer);
        if (edge.dynamicModule) {
          const token = `wga-dynamic:${edge.dynamicModule}`;
          edges.set(token, edge);
          return { path: token, external: true };
        }
        if (edge.external && isBuiltin(edge.path)) return { path: edge.path, external: true };
        const target = !edge.external && modules.get(edge.path);
        if (!target) fail('WGA_PREBUNDLE_AUDIT', 'The ESM graph requested an uncaptured module');
        if (args.kind === 'dynamic-import' && importer.nodeEsm && target.info.format !== 'esm') {
          fail('WGA_PREBUNDLE_AUDIT', 'A surviving strict dynamic import of a non-ESM target must use captured static targets', { path: importer.input });
        }
        if (target.info.format === 'esm' && args.kind !== 'require-call') return { path: `${target.id}.${target.nodeEsm ? 'mjs' : 'js'}`, namespace: 'wga-esm' };
        const token = `wga-cjs:${target.id}`;
        externalModules.set(token, target);
        return { path: token, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: 'wga-esm-namespace' }, args => ({ loader: 'js', contents:
        `export * as namespace from ${JSON.stringify(args.path)};` }));
      build.onLoad({ filter: /.*/, namespace: 'wga-esm' }, args => {
        if (args.path === 'entry.cjs') return { loader: 'js', contents: esmModules.map(receipt =>
          `exports[${JSON.stringify(receipt.id)}] = () => require(${JSON.stringify(`wga-esm-value:${receipt.id}.${receipt.nodeEsm ? 'mjs' : 'js'}`)});\n`
          + `exports[${JSON.stringify(`${receipt.id}:namespace`)}] = () => require(${JSON.stringify(`${receipt.id}.${receipt.nodeEsm ? 'mjs' : 'js'}`)}).namespace;`).join('\n') };
        const receipt = esmById.get(args.path);
        if (!receipt) fail('WGA_PREBUNDLE_AUDIT', 'The ESM graph loaded uncaptured source');
        return { contents: receipt.contents, loader: receipt.loader };
      });
    } }] });
  if (esmGraph.outputFiles.length !== 1) fail('WGA_PREBUNDLE_OUTPUT', 'Expected one captured ESM graph');
  // The registry exports lazy accessors to actual bundled namespace objects.
  // It evaluates no original module until its accessor is called, so dynamic
  // imports remain lazy and CJS/ESM cycles can reenter the completed registry.
  const esmSource = '"use strict";\n' + esmGraph.outputFiles[0].text;
  const namespaces = new Map(esmModules.map(receipt => [`namespace:${receipt.id}`, receipt]));
  const plugin = { name: 'wga-prebundle-module-strictness', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point' && args.path === 'wga-entry') return { path: 'facade.mjs', namespace: 'wga-strict' };
      if (args.path === 'wga-esm-graph') return { path: 'esm-graph.cjs', namespace: 'wga-strict' };
      if (args.importer === 'esm-graph.cjs' && isBuiltin(args.path)) return { path: args.path, external: true };
      let edge;
      if (args.importer === 'facade.mjs' && args.path === 'wga-original-entry') edge = { path: entry.input };
      else if (externalModules.has(args.path)) edge = { path: externalModules.get(args.path).input };
      else if (edges.has(args.path)) edge = edges.get(args.path);
      else {
        const importer = byId.get(args.importer);
        if (!importer) fail('WGA_PREBUNDLE_AUDIT', 'The strict bundle requested an uncaptured importer', { importer: args.importer, path: args.path });
        edge = capturedEdge(args, importer);
      }
      if (edge.dynamicModule) return { path: edge.dynamicModule, namespace: 'wga-strict' };
      if (edge.external && isBuiltin(edge.path)) return { path: edge.path, external: true };
      const target = modules.get(edge.path);
      if (!target || edge.external) fail('WGA_PREBUNDLE_AUDIT', 'The strict bundle requested an uncaptured module', { import: edge.path });
      if (target.info.format === 'esm' && edge.kind === 'dynamic-import') return { path: `namespace:${target.id}`, namespace: 'wga-strict' };
      return { path: target.id, namespace: 'wga-strict' };
    });
    build.onLoad({ filter: /.*/, namespace: 'wga-strict' }, args => {
      if (args.path === 'esm-graph.cjs') return { contents: esmSource, loader: 'js' };
      if (dynamicModules.has(args.path)) return { contents: dynamicModules.get(args.path), loader: 'js' };
      if (namespaces.has(args.path)) return { loader: 'js', contents:
        `module.exports = require('wga-esm-graph')[${JSON.stringify(`${namespaces.get(args.path).id}:namespace`)}]();` };
      if (args.path === 'facade.mjs') return { loader: 'js', contents: `import owned from 'wga-original-entry';\n${names.map((name, index) => `const value${index} = owned[${JSON.stringify(name)}]; export {value${index} as ${name}};`).join('\n')}` };
      const receipt = byId.get(args.path);
      if (!receipt) fail('WGA_PREBUNDLE_AUDIT', 'The strict bundle loaded an uncaptured module');
      if (receipt.info.format === 'esm') return { loader: 'js', contents:
        `module.exports = require('wga-esm-graph')[${JSON.stringify(receipt.id)}]();` };
      return { contents: receipt.contents, loader: receipt.loader };
    });
  } };
  return esbuild.build({ absWorkingDir: projectRoot, entryPoints: ['wga-entry'], bundle: true, format: 'cjs', platform: 'node',
    target: 'es2022', outfile, write: false, metafile: true, minify: true, legalComments: 'eof', sourcemap: false,
    logLevel: 'silent', plugins: [plugin] });
}
function checkRuntimeGraph(projectRoot, metafile, profile, captured) {
  const adapters = new Map(), adapterModules = new Map(), inputs = [];
  const allowed = new Map();
  for (const pkg of profile.packages) {
    const resolved = profile.resolvedPaths.find(item => item.path === `${pkg.path}/package.json`);
    if (!resolved?.physicalPath) fail('WGA_PREBUNDLE_AUDIT', 'A profiled package has no inspected physical identity');
    if (!allowed.has(pkg.name)) allowed.set(pkg.name, new Set());
    allowed.get(pkg.name).add(path.dirname(resolved.physicalPath));
  }
  for (const { input, info, source, pkg, moduleIdentity } of captured) {
    const { logical, physical } = source;
    if (pkg?.name === '@grpc/grpc-js') fail('WGA_PREBUNDLE_NATIVE_GRPC', 'Install workers-grpc-adapter under the @grpc/grpc-js alias', { logicalPath: logical, physicalPath: physical });
    if (pkg?.name === 'workers-grpc-adapter') {
      adapters.set(pkg.root, pkg);
      // esbuild caches by namespace/path/suffix, not physical package root.
      // Two identities for one source instantiate private symbols/state twice.
      const previous = adapterModules.get(physical);
      if (previous && previous.moduleIdentity !== moduleIdentity) fail('WGA_PREBUNDLE_RUNTIME_IDENTITY',
        'One adapter source cannot be instantiated as multiple bundled modules', { physicalPath: physical, inputs: [previous.input, input] });
      adapterModules.set(physical, { moduleIdentity, input });
    }
    if (allowed.has(pkg?.name) && !allowed.get(pkg.name).has(pkg.root)) fail('WGA_SOURCE_IDENTITY', `Bundled ${pkg.name} comes from an unverified physical installation`, { logicalPath: logical, physicalPath: physical, expected: [...allowed.get(pkg.name)] });
    if (pkg?.name.startsWith('@google-cloud/') && !allowed.has(pkg.name) && pkg.name !== '@google-cloud/promisify') fail('WGA_UNSUPPORTED_DEPENDENCY', `The selected profile does not verify ${pkg.name}`, { package: pkg.name, physicalPath: pkg.root });
    for (const dependency of info.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) fail('WGA_PREBUNDLE_EXTERNAL', `Unresolved runtime dependency ${JSON.stringify(dependency.path)}; install it in the build graph before generating a prebundle`, { path: input, import: dependency.path });
    }
    inputs.push({ path: publicPath(projectRoot, physical, pkg), sha256: source.sha256, bytes: source.contents.length });
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
  const options = { allowJs: true, allowNonTsExtensions: true, noResolve: true, noLib: true, types: [] }, host = ts.createCompilerHost(options);
  host.getSourceFile = file => sources.get(file);
  return ts.createProgram([...sources.keys()], options, host).getTypeChecker();
}
function checkModuleLoaders(ts, captured) {
  // Inspect original module scopes: esbuild renames the CommonJS `module`
  // parameter, so a spelling-only check of the minified artifact misses it.
  // The default esbuild loader accepts extensionless JavaScript, including
  // side-effect scripts that have no ESM/CJS format in the metafile.
  const sources = new Map(captured.filter(({ source, info }) => ['cjs', 'esm'].includes(info.format)
    || !path.extname(source.physical) || /\.[cm]?[jt]sx?$/.test(source.physical))
    .map(({ source }) => [source.physical, ts.createSourceFile(source.physical, source.contents.toString('utf8'), ts.ScriptTarget.Latest, true,
      path.extname(source.physical) ? undefined : ts.ScriptKind.JS)]));
  const checker = bindSources(ts, sources), values = new Map(), boundAliasNames = new Set(), originCache = new Map(), originQueries = [];
  const recordOriginDependency = dependency => {
    for (const query of originQueries) query.add(dependency);
  };
  const MODULE = 1n, NAMESPACE = 2n, LOADER = 4n, REQUIRE = 8n;
  const loaderMembers = ['createRequire', '_load', 'register', 'registerHooks'];
  const builtinExportNames = new Set([...Object.keys(require('node:module')), 'default']);
  const modules = new Map(captured.map(receipt => [receipt.input, receipt])), byFile = new Map();
  const exportsByFile = new Map(), starsByFile = new Map();
  for (const receipt of captured) {
    const file = receipt.source.physical;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(receipt);
  }
  function isRuntimeExport(symbol, seen = new Set()) {
    // Unknown runtime aliases still shadow stars. Only declarations known to
    // disappear during TypeScript erasure may expose the star's binding again.
    if (!symbol || seen.has(symbol)) return true;
    const declarations = symbol.declarations || [];
    if (symbol.flags & ts.SymbolFlags.Value) return !declarations.length || declarations.some(declaration =>
      !(declaration.flags & ts.NodeFlags.Ambient) && !ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration));
    if (!(symbol.flags & ts.SymbolFlags.Alias)) return false;
    const next = new Set([...seen, symbol]);
    return !declarations.length || declarations.some(declaration => {
      if (ts.isExportSpecifier(declaration)) {
        const statement = declaration.parent.parent;
        if (declaration.isTypeOnly || statement.isTypeOnly) return false;
        return !!statement.moduleSpecifier || isRuntimeExport(checker.getExportSpecifierLocalTargetSymbol(declaration), next);
      }
      if (ts.isNamespaceExport(declaration)) return !declaration.parent.isTypeOnly;
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
        return !statement?.importClause?.isTypeOnly && !declaration.isTypeOnly;
      }
      return !ts.isImportEqualsDeclaration(declaration) || !declaration.isTypeOnly;
    });
  }
  for (const [file, source] of sources) {
    const symbol = checker.getSymbolAtLocation(source);
    // getExportsOfModule flattens stars and can pick one conflicting symbol.
    // Keep only own exports; resolve stars and their binding identities below.
    exportsByFile.set(file, new Map([...(symbol?.exports?.values() || [])]
      .filter(item => !(item.flags & ts.SymbolFlags.ExportStar) && isRuntimeExport(item)).map(item => [item.name, item])));
    starsByFile.set(file, source.statements.filter(statement => ts.isExportDeclaration(statement)
      && !statement.isTypeOnly && !statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)));
  }
  const containers = new Map(), containerFlags = new Map();
  let nextContainer = 16n;
  function container(kind, value) {
    if (!value) return 0n;
    const key = `${kind}:${value}`;
    if (!containerFlags.has(key)) {
      const flag = nextContainer; nextContainer <<= 1n;
      containerFlags.set(key, flag); containers.set(flag, { kind, value });
    }
    return containerFlags.get(key);
  }
  const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    || ts.isAwaitExpression(node) ? unwrap(node.expression) : node;
  function key(expression, computed = false) {
    const value = keyValue(expression, computed);
    return value === undefined ? undefined : String(value);
  }
  function keyValue(expression, computed = false, seen = new Set()) {
    const node = unwrap(expression);
    if (ts.isComputedPropertyName(node)) return keyValue(node.expression, true, seen);
    // Preserve primitive types through addition: numeric operands add, while
    // a string operand concatenates. Coerce only the final property key.
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || !computed && ts.isIdentifier(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = keyValue(node.left, true, seen), right = keyValue(node.right, true, seen);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol) || symbol.declarations?.length !== 1) return;
      const declaration = symbol.declarations[0];
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
        return keyValue(declaration.initializer, true, new Set([...seen, symbol]));
      }
    }
  }
  function importedNamespace(node, specifier) {
    if (['module', 'node:module'].includes(specifier)) return NAMESPACE;
    let result = 0n;
    // Use the consumed graph's resolutions, including package export conditions
    // and aliases. A second filesystem resolver could inspect another module.
    for (const receipt of byFile.get(node.getSourceFile().fileName) || []) {
      for (const edge of receipt.info.imports) {
        if (edge.kind !== 'import-statement' || (edge.original || edge.path) !== specifier || edge.external) continue;
        const file = modules.get(edge.path)?.source.physical;
        if (sources.has(file)) result |= container('exports', file);
      }
    }
    return result;
  }
  // Each query unions reachable names/bindings, so share its visited set
  // across branches. Path-local copies re-expand diamonds exponentially;
  // caching partial cyclic results would instead lose reachable bindings.
  function exportedNames(file, seen = new Set()) {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const names = new Set(exportsByFile.get(file)?.keys());
    for (const declaration of starsByFile.get(file) || []) {
      const imported = importedNamespace(declaration, declaration.moduleSpecifier.text);
      if (imported & NAMESPACE) for (const name of builtinExportNames) if (name !== 'default') names.add(name);
      for (const [flag, shape] of containers) if (imported & flag && shape.kind === 'exports') {
        for (const name of exportedNames(shape.value, seen)) if (name !== 'default') names.add(name);
      }
    }
    return names;
  }
  function namespaceBindings(namespace, name, seen) {
    const bindings = new Map();
    if (namespace & NAMESPACE && (name === undefined || builtinExportNames.has(name))) bindings.set(name === undefined ? NAMESPACE : `node:module:${name}`,
      name === undefined ? NAMESPACE : member(NAMESPACE, name));
    for (const [flag, shape] of containers) if (namespace & flag && shape.kind === 'exports') {
      if (name === undefined) bindings.set(flag, flag);
      else for (const [key, value] of exportedBindings(shape.value, name, seen)) bindings.set(key, value);
    }
    return bindings;
  }
  function symbolBindings(symbol, seen) {
    if (!symbol || seen.has(symbol)) return new Map();
    seen.add(symbol);
    for (const declaration of symbol.declarations || []) {
      if (ts.isExportSpecifier(declaration)) {
        const statement = declaration.parent.parent;
        if (declaration.isTypeOnly || statement.isTypeOnly) return new Map();
        return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? namespaceBindings(importedNamespace(statement, statement.moduleSpecifier.text), (declaration.propertyName || declaration.name).text, seen)
          : symbolBindings(checker.getExportSpecifierLocalTargetSymbol(declaration), seen);
      }
      if (ts.isNamespaceExport(declaration)) {
        return namespaceBindings(importedNamespace(declaration, declaration.parent.moduleSpecifier.text), undefined, seen);
      }
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
        if (!statement || statement.importClause?.isTypeOnly || declaration.isTypeOnly) return new Map();
        const name = ts.isNamespaceImport(declaration) ? undefined : ts.isImportClause(declaration)
          ? 'default' : (declaration.propertyName || declaration.name).text;
        return namespaceBindings(importedNamespace(statement, statement.moduleSpecifier.text), name, seen);
      }
    }
    // Local declarations (including default export expressions) have their own
    // binding identity even when their values share the same provenance.
    return new Map([[symbol, symbol]]);
  }
  function exportedBindings(file, name, seen = new Set()) {
    const marker = JSON.stringify([file, name]);
    if (seen.has(marker)) return new Map();
    seen.add(marker);
    const exported = exportsByFile.get(file);
    if (exported?.has(name)) return symbolBindings(exported.get(name), seen);
    const bindings = new Map();
    if (name !== 'default') for (const declaration of starsByFile.get(file) || []) {
      for (const [key, value] of namespaceBindings(importedNamespace(declaration, declaration.moduleSpecifier.text), name, seen)) bindings.set(key, value);
    }
    return bindings;
  }
  function exportedOrigin(file, name, seen) {
    const marker = JSON.stringify([file, name]);
    recordOriginDependency(marker);
    if (seen.has(marker)) return 0n;
    const next = new Set([...seen, marker]);
    // Enumerate effective names, then use ordinary lookup so explicit exports
    // shadow star exports even when the consuming property is not known.
    if (name === undefined) return [...exportedNames(file)].reduce((flags, item) => flags | exportedOrigin(file, item, next), 0n);
    const bindings = exportedBindings(file, name);
    // Namespace objects omit ambiguous star exports. Compare final binding
    // identities, not flags: distinct bindings can contain the same namespace,
    // while multiple paths through a diamond can refer to one binding.
    if (bindings.size !== 1) return 0n;
    const value = bindings.values().next().value;
    return typeof value === 'bigint' ? value : symbolOrigin(value, next);
  }
  const member = (origin, name, seen = new Set()) => {
    let result = 0n;
    // Descriptors can themselves be reflected upon. Intern structural
    // containers instead of dropping provenance at a fixed nesting depth.
    for (const [flag, shape] of containers) if (origin & flag) {
      if (shape.kind.startsWith('property:')) {
        if (name === undefined || shape.kind === `property:${JSON.stringify(name)}`) result |= shape.value;
        continue;
      }
      result |= shape.kind === 'exports' ? exportedOrigin(shape.value, name, seen) : shape.kind === 'value'
        ? name === 'value' ? shape.value : name === undefined ? LOADER : 0n
        : container('value', member(shape.value, name, seen));
    }
    // Unknown computed access on a known module object could select a loader.
    // Ordinary application objects have no module provenance and stay valid.
    if (name === undefined && origin & (MODULE | NAMESPACE)) return LOADER;
    if (origin & MODULE) result |= name === 'require' ? LOADER : name === 'constructor' ? NAMESPACE : 0n;
    if (origin & NAMESPACE) result |= loaderMembers.includes(name) ? LOADER
      : ['Module', 'default'].includes(name) ? NAMESPACE : name === 'prototype' ? MODULE : 0n;
    return result;
  };
  function bind(name, value, keys = []) {
    name = unwrap(name);
    if (ts.isIdentifier(name)) {
      // In an assignment's shorthand property, the property symbol is not
      // the variable receiving the value.
      const symbol = ts.isShorthandPropertyAssignment(name.parent)
        ? checker.getShorthandAssignmentValueSymbol(name.parent) : checker.getSymbolAtLocation(name);
      if (symbol) {
        if (symbol.flags & ts.SymbolFlags.Alias) boundAliasNames.add(symbol.name);
        if (!values.has(symbol)) values.set(symbol, []);
        values.get(symbol).push({ value, keys });
        // Fulfillment callback parameters are bound after the first queries.
        originCache.clear();
      }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        bind(element.name, value, element.dotDotDotToken ? keys : [...keys, key(element.propertyName || element.name)]);
        if (element.initializer) bind(element.name, element.initializer);
      }
    } else if (ts.isArrayBindingPattern(name)) {
      name.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        bind(element.name, value, [...keys, element.dotDotDotToken ? { rest: index } : String(index)]);
        if (element.initializer) bind(element.name, element.initializer);
      });
    } else if (ts.isBinaryExpression(name) && name.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // A default can supply a namespace independently of the selected
      // source member. Keep both possible origins, as for conditional values.
      bind(name.left, value, keys);
      bind(name.left, name.right);
    } else if (ts.isArrayLiteralExpression(name)) {
      name.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        bind(ts.isSpreadElement(element) ? element.expression : element, value,
          [...keys, ts.isSpreadElement(element) ? { rest: index } : String(index)]);
      });
    } else if (ts.isObjectLiteralExpression(name)) {
      for (const property of name.properties) {
        if (ts.isPropertyAssignment(property)) bind(property.initializer, value, [...keys, key(property.name)]);
        else if (ts.isShorthandPropertyAssignment(property)) {
          bind(property.name, value, [...keys, property.name.text]);
          if (property.objectAssignmentInitializer) bind(property.name, property.objectAssignmentInitializer);
        } else if (ts.isSpreadAssignment(property)) bind(property.expression, value, keys);
      }
    }
  }
  function arrayRest(flags, start) {
    let result = 0n;
    // Rest bindings preserve the known suffix of a fixed literal array.
    // Source arrays containing arbitrary spreads still have no fixed slots.
    for (const [flag, shape] of containers) if (flags & flag && shape.kind.startsWith('property:')) {
      const name = JSON.parse(shape.kind.slice('property:'.length)), index = Number(name);
      if (Number.isInteger(index) && String(index) === name && index >= start) {
        result |= container(`property:${JSON.stringify(String(index - start))}`, shape.value);
      }
    }
    return result;
  }
  function builtinMethod(node, receiver, method) {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    const object = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && unwrap(callee.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isElementAccessExpression(callee) && callee.argumentExpression ? key(callee.argumentExpression, true) : undefined;
    return name === method && object && ts.isIdentifier(object) && object.text === receiver
      && !checker.getSymbolAtLocation(object)?.declarations?.length;
  }
  const objectAssign = node => builtinMethod(node, 'Object', 'assign');
  const reflectGet = node => builtinMethod(node, 'Reflect', 'get');
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) bind(node.left, node.right);
    if (objectAssign(node) && node.arguments.length && ts.isIdentifier(node.arguments[0])) bind(node.arguments[0], node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const imported = importedNamespace(node, node.moduleSpecifier.text);
      if (clause?.name) bind(clause.name, imported, ['default']);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, imported);
        else for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) bind(item.name, imported, [(item.propertyName || item.name).text]);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
      && ['module', 'node:module'].includes(node.moduleReference.expression.text)) bind(node.name, NAMESPACE);
    ts.forEachChild(node, collect);
  }
  for (const source of sources.values()) collect(source);
  function symbolOrigin(symbol, seen) {
    if (!symbol) return 0n;
    recordOriginDependency(symbol);
    if (seen.has(symbol)) return 0n;
    const cached = originCache.get(symbol);
    if (cached && [...cached.dependencies].every(dependency => cached.ancestors.has(dependency) === seen.has(dependency))) {
      for (const dependency of cached.dependencies) recordOriginDependency(dependency);
      return cached.result;
    }
    const dependencies = new Set();
    originQueries.push(dependencies);
    const next = new Set([...seen, symbol]);
    let result = (values.get(symbol) || []).reduce((flags, value) => flags
      | value.keys.reduce((current, name) => typeof name === 'object' ? arrayRest(current, name.rest)
        : member(current, name, next), origin(value.value, next)), 0n);
    for (const declaration of symbol.declarations || []) {
      if (ts.isExportSpecifier(declaration)) {
        const statement = declaration.parent.parent;
        if (declaration.isTypeOnly || statement.isTypeOnly) continue;
        result |= statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? member(importedNamespace(statement, statement.moduleSpecifier.text), (declaration.propertyName || declaration.name).text, next)
          : symbolOrigin(checker.getExportSpecifierLocalTargetSymbol(declaration), next);
      } else if (ts.isNamespaceExport(declaration) && ts.isStringLiteral(declaration.parent.moduleSpecifier)) {
        result |= importedNamespace(declaration, declaration.parent.moduleSpecifier.text);
      } else if (ts.isExportAssignment(declaration)) result |= origin(declaration.expression, next);
    }
    originQueries.pop();
    // Cycle cuts depend only on ancestors the query actually touched. Share
    // unrelated diamond paths, but recompute when a relevant ancestor changes.
    originCache.set(symbol, { result, dependencies, ancestors: new Set(seen) });
    return result;
  }
  function origin(expression, seen = new Set()) {
    if (typeof expression === 'bigint') return expression;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      // The checker can omit a value reference when a TypeScript-only export
      // shadows its import in type space. Recover the bound lexical import;
      // esbuild's runtime graph can still supply that name through a star.
      const parent = node.parent;
      const reference = parent.name !== node && parent.propertyName !== node && parent.label !== node;
      const symbol = checker.getSymbolAtLocation(node) || (reference && boundAliasNames.has(node.text)
        ? checker.getSymbolsInScope(node, ts.SymbolFlags.Alias).find(item => item.name === node.text && values.has(item)) : undefined);
      // TypeScript can attach synthetic Identifier/BinaryExpression declarations
      // to the implicit CommonJS globals. Lexical declarations still shadow them.
      const local = symbol?.declarations?.some(declaration => !ts.isIdentifier(declaration) && !ts.isBinaryExpression(declaration) && !ts.isSourceFile(declaration));
      if (!local && node.text === 'module') return MODULE;
      if (!local && node.text === 'require') return REQUIRE;
      return symbolOrigin(symbol, seen);
    }
    if (ts.isPropertyAccessExpression(node)) return member(origin(node.expression, seen), node.name.text, seen);
    if (ts.isElementAccessExpression(node) && node.argumentExpression) return member(origin(node.expression, seen), key(node.argumentExpression, true), seen);
    // Value-producing expressions preserve every possible module origin. A
    // comma expression returns only its right operand; the discarded operand
    // is still independently visited for direct loader use.
    if (ts.isConditionalExpression(node)) return origin(node.whenTrue, seen) | origin(node.whenFalse, seen);
    if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken]
        .includes(node.operatorToken.kind)) return origin(node.left, seen) | origin(node.right, seen);
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) return origin(node.right, seen);
    }
    if (ts.isArrayLiteralExpression(node)) {
      // Do not guess offsets across arbitrary iterables. Only literal arrays
      // whose element positions are fixed participate in this source audit.
      if (node.elements.some(ts.isSpreadElement)) return 0n;
      return node.elements.reduce((result, element, index) =>
        result | container(`property:${JSON.stringify(String(index))}`, origin(element, seen)), 0n);
    }
    if (ts.isObjectLiteralExpression(node)) return node.properties.reduce((result, property) =>
      result | (ts.isSpreadAssignment(property) ? copiedOrigin(property.expression, seen) : 0n), 0n);
    if (objectAssign(node)) return node.arguments.reduce((result, argument) => result | copiedOrigin(argument, seen), 0n);
    if (reflectGet(node) && node.arguments.length >= 2) return member(origin(node.arguments[0], seen), key(node.arguments[1], true), seen);
    if ((builtinMethod(node, 'Object', 'getOwnPropertyDescriptor') || builtinMethod(node, 'Reflect', 'getOwnPropertyDescriptor'))
      && node.arguments.length >= 2) return container('value', member(origin(node.arguments[0], seen), key(node.arguments[1], true), seen));
    if (builtinMethod(node, 'Object', 'getOwnPropertyDescriptors') && node.arguments.length >= 1) return container('members', origin(node.arguments[0], seen));
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && node.arguments.length <= 2
      && ['module', 'node:module'].includes(key(node.arguments[0], true))) return NAMESPACE;
    if (ts.isCallExpression(node) && origin(node.expression, seen) & REQUIRE && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]) && ['module', 'node:module'].includes(node.arguments[0].text)) return NAMESPACE;
    if (ts.isNewExpression(node) && origin(node.expression, seen) & NAMESPACE) return MODULE;
    return 0n;
  }
  function copiedOrigin(expression, seen) {
    let result = origin(expression, seen);
    // Object copies do not track property overwrite order. Keep fixed array
    // slots in indexed reads only, where their positions are still meaningful.
    for (const [flag, shape] of containers) if (shape.kind.startsWith('property:')) result &= ~flag;
    return result;
  }
  function bindCallback(expression, value, seen = new Set()) {
    const node = unwrap(expression);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      if (node.parameters[0] && !node.parameters[0].dotDotDotToken) bind(node.parameters[0].name, value);
    } else if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return;
      const next = new Set([...seen, symbol]);
      for (const declaration of symbol.declarations || []) if (ts.isFunctionDeclaration(declaration)) bindCallback(declaration, value, next);
      for (const assigned of values.get(symbol) || []) if (!assigned.keys.length && typeof assigned.value !== 'number') bindCallback(assigned.value, value, next);
    }
  }
  function collectCallbacks(node) {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = unwrap(node.expression);
      const receiver = ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' ? callee.expression
        : ts.isElementAccessExpression(callee) && callee.argumentExpression && key(callee.argumentExpression, true) === 'then' ? callee.expression : undefined;
      if (receiver && origin(receiver) & NAMESPACE) bindCallback(node.arguments[0], receiver);
    }
    ts.forEachChild(node, collectCallbacks);
  }
  // Gather ordinary aliases first: a function can use a pending import or a
  // named callback whose declaration appears later in the source file.
  for (const source of sources.values()) collectCallbacks(source);
  function visit(node) {
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && origin(node) & LOADER) {
      fail('WGA_PREBUNDLE_DYNAMIC_IMPORT', 'Node module loading APIs cannot remain in a self-contained prebundle; use explicit static imports', { path: node.getSourceFile().fileName });
    }
    ts.forEachChild(node, visit);
  }
  for (const source of sources.values()) visit(source);
}
function checkExportStability(ts, entryPoint, original, source, expected) {
  const reject = name => fail('WGA_PREBUNDLE_EXPORT_STABILITY', 'Public export bindings must be stable; expose a factory or a stable object for changing state', { export: name });
  const wrapper = ts.createSourceFile(entryPoint, original, ts.ScriptTarget.Latest, true), mutable = new Set();
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
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
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
  // CJS re-exports point at esbuild's namespace wrapper, while writes happen
  // on the separate CommonJS factory's exports parameter. Follow that bridge
  // before deciding whether the ESM facade may snapshot a named property.
  const initializers = new Map();
  function variables(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(checker.getSymbolAtLocation(node.name), node.initializer);
    ts.forEachChild(node, variables);
  }
  variables(ast);
  function factoryOf(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!initializers.has(symbol) || seen.has(symbol)) return;
      return factoryOf(initializers.get(symbol), new Set([...seen, symbol]));
    }
    if (!ts.isCallExpression(node)) return;
    if (node.arguments.length === 0 && ts.isIdentifier(node.expression)) {
      const initializer = initializers.get(checker.getSymbolAtLocation(node.expression));
      if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        const helper = initializers.get(checker.getSymbolAtLocation(initializer.expression)), factory = initializer.arguments[0];
        if (helper && ts.isArrowFunction(helper) && ts.isArrowFunction(unwrap(helper.body))
          && factory && ts.isArrowFunction(factory) && factory.parameters.length && ts.isBlock(factory.body)) return factory;
      }
    }
    for (const argument of node.arguments) { const factory = factoryOf(argument, seen); if (factory) return factory; }
  }
  function canonical(assigned, seen = new Set()) {
    if (!assigned || seen.has(assigned.symbol)) return assigned;
    const alias = initializers.get(assigned.symbol), next = alias && target(alias);
    return next ? canonical({ symbol: next.symbol, keys: [...next.keys, ...assigned.keys] }, new Set([...seen, assigned.symbol])) : assigned;
  }
  const audited = new Map();
  function auditCommonJs(binding) {
    const initializer = initializers.get(binding.symbol), factory = binding.factory || initializer && factoryOf(initializer);
    if (!factory) return;
    if (!audited.has(factory)) audited.set(factory, new Set());
    if (audited.get(factory).has(binding.keys[0])) return;
    audited.get(factory).add(binding.keys[0]);
    const exported = checker.getSymbolAtLocation(factory.parameters[0].name);
    const module = factory.parameters[1] && checker.getSymbolAtLocation(factory.parameters[1].name);
    const publicKey = binding.keys[0];
    let lockedGetter = false, namespaceRebound = false;
    function exportPath(expression) {
      const assigned = canonical(target(expression));
      if (assigned?.symbol === exported) return assigned.keys;
      if (module && assigned?.symbol === module && assigned.keys[0] === 'exports') return assigned.keys.slice(1);
    }
    function initialization(node) {
      for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent === factory;
      return false;
    }
    function unconditional(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent === factory.body) return true;
        if (!ts.isExpressionStatement(parent) && !ts.isParenthesizedExpression(parent)
          && !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken)) return false;
      }
      return false;
    }
    function getter(property) {
      const fn = ts.isPropertyAssignment(property) ? property.initializer : property;
      if (!ts.isFunctionLike(fn) || !fn.body) reject(binding.name);
      const body = ts.isBlock(fn.body) && fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
        ? fn.body.statements[0].expression : !ts.isBlock(fn.body) ? fn.body : undefined;
      const result = body && canonical(target(body));
      if (!result) {
        // esbuild's CommonJS loader returns one cached namespace. A lazy
        // require getter preserves that identity unless the module replaces it.
        const call = body && unwrap(body);
        const cached = call && ts.isCallExpression(call) && call.arguments.length === 0
          && ts.isIdentifier(call.expression) && factoryOf(call);
        if (!cached) reject(binding.name);
        auditCommonJs({ factory: cached, keys: [], name: binding.name });
        return;
      }
      // A getter into an arbitrary object can change through aliases or helper
      // calls. Only a whole binding or another audited CJS export is provable.
      const origin = initializers.get(result.symbol);
      if (result.keys.length && (result.keys.length !== 1 || !origin || !factoryOf(origin))) reject(binding.name);
      const inherited = { ...result, name: binding.name };
      bindings.push(inherited);
      auditCommonJs(inherited);
    }
    function descriptor(node) {
      if (!node || !ts.isObjectLiteralExpression(node)) reject(binding.name);
      let hasGetter = false, fixed = true;
      for (const property of node.properties) {
        if (!property.name || ts.isComputedPropertyName(property.name)) reject(binding.name);
        if (property.name.text === '__proto__' && (!ts.isPropertyAssignment(property)
          || unwrap(property.initializer).kind !== ts.SyntaxKind.NullKeyword)) reject(binding.name);
        if (property.name.text === 'get') { getter(property); hasGetter = true; }
        if (property.name.text === 'set') fixed = false;
        if (property.name.text === 'configurable') {
          const value = ts.isPropertyAssignment(property) && unwrap(property.initializer);
          if (!value || !(value.kind === ts.SyntaxKind.FalseKeyword || ts.isPrefixUnaryExpression(value)
            && value.operator === ts.SyntaxKind.ExclamationToken && ts.isNumericLiteral(value.operand) && Number(value.operand.text) !== 0)) fixed = false;
        }
      }
      return hasGetter && fixed;
    }
    function mutation(expression, node) {
      expression = unwrap(expression);
      if (ts.isArrayLiteralExpression(expression)) {
        for (const element of expression.elements) if (!ts.isOmittedExpression(element)) mutation(ts.isSpreadElement(element) ? element.expression : element, node);
      } else if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (ts.isPropertyAssignment(property)) mutation(property.initializer, node);
          else if (ts.isShorthandPropertyAssignment(property)) mutation(property.name, node);
          else if (ts.isSpreadAssignment(property)) mutation(property.expression, node);
        }
      }
      const keys = exportPath(expression);
      if (keys && (keys.length === 0 || keys.length === 1 && keys[0] === publicKey) && !initialization(node)) reject(binding.name);
      // Computed writes with an unknown key cannot prove a stable export.
      if (publicKey !== undefined && ts.isElementAccessExpression(expression) && exportPath(expression.expression)?.length === 0 && !target(expression)) reject(binding.name);
      if (module && ts.isElementAccessExpression(expression) && !target(expression)) {
        const object = canonical(target(expression.expression));
        if (object?.symbol === module && object.keys.length === 0) reject(binding.name);
      }
    }
    function visit(node) {
      // A module-object escape can replace exports indirectly, even when the
      // old namespace has a non-configurable getter. Its own fields remain
      // usable, but calls and storage of the module object are unprovable.
      if (module && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        const object = canonical(target(node));
        if (object?.symbol === module && object.keys.length === 0) {
          const parent = node.parent;
          const understood = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node
            || ts.isParenthesizedExpression(parent)
            || ts.isVariableDeclaration(parent) && (parent.name === node || parent.initializer === node && ts.isIdentifier(parent.name))
            || ts.isParameter(parent) && parent.name === node;
          if (!understood) reject(binding.name);
        }
      }
      if (publicKey === undefined) {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mutation(node.left, node);
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mutation(node.operand, node);
        if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) mutation(node.initializer, node);
        if (ts.isDeleteExpression(node)) mutation(node.expression, node);
        ts.forEachChild(node, visit);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        mutation(node.left, node);
        if (exportPath(node.left)?.length === 0) { lockedGetter = false; namespaceRebound = true; }
        if (exportPath(node.right)?.length === 0) reject(binding.name);
        if (exportPath(node.left)?.length === 0 && ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name)) reject(binding.name);
            if (property.name?.text === publicKey && ts.isGetAccessorDeclaration(property)) getter(property);
          }
        }
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mutation(node.operand, node);
      if (ts.isDeleteExpression(node)) mutation(node.expression, node);
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) mutation(node.initializer, node);
      if (ts.isCallExpression(node) && node.arguments.some(argument => exportPath(argument)?.length === 0)) {
        const method = ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast);
        if (method === 'Object.defineProperty' || method === 'Reflect.defineProperty') {
          if (exportPath(node.arguments[0])?.length !== 0) reject(binding.name);
          const name = node.arguments[1];
          if (!name || !ts.isStringLiteral(name)) reject(binding.name);
          if (name.text === publicKey) {
            if (!initialization(node)) reject(binding.name);
            const fixed = descriptor(node.arguments[2]);
            const owner = target(node.arguments[0]);
            const currentNamespace = owner && (module && owner.symbol === module && owner.keys.length === 1 && owner.keys[0] === 'exports'
              || !namespaceRebound && owner.symbol === exported && owner.keys.length === 0);
            if (method === 'Object.defineProperty' && fixed && currentNamespace && unconditional(node)) lockedGetter = true;
          }
        } else if (method === 'Object.assign') {
          if (exportPath(node.arguments[0])?.length === 0 && !initialization(node)) {
            for (const source of node.arguments.slice(1)) {
              if (!ts.isObjectLiteralExpression(source)) reject(binding.name);
              if (source.properties.some(property => property.name?.text === publicKey || ts.isSpreadAssignment(property)
                || property.name && ts.isComputedPropertyName(property.name)) && !initialization(node)) reject(binding.name);
            }
          }
        } else if (!lockedGetter || !initialization(node)) reject(binding.name);
      }
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && exportPath(node)?.length === 0) {
        const parent = node.parent;
        const understood = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node
          || ts.isParenthesizedExpression(parent)
          || ts.isVariableDeclaration(parent) && (parent.name === node || parent.initializer === node && ts.isIdentifier(parent.name))
          || ts.isParameter(parent) && parent.name === node
          || ts.isCallExpression(parent) && parent.arguments.includes(node)
          || ts.isBinaryExpression(parent) && parent.left === node;
        if (!understood) reject(binding.name);
      }
      ts.forEachChild(node, visit);
    }
    visit(factory.body);
  }
  for (const binding of [...bindings]) auditCommonJs(binding);
  function sameRoot(left, right) {
    if (left.symbol === right.symbol) return true;
    const first = initializers.get(left.symbol), second = initializers.get(right.symbol);
    const factory = first && factoryOf(first);
    return factory && second && factory === factoryOf(second);
  }
  function write(expression) {
    const node = unwrap(expression), assigned = target(node);
    if (assigned) {
      for (const candidate of [assigned, canonical(assigned)]) {
        for (const binding of bindings) if (sameRoot(binding, candidate) && JSON.stringify(binding.keys) === JSON.stringify(candidate.keys)) reject(binding.name);
      }
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
  function writeProperty(expression, key) {
    const object = canonical(target(expression));
    if (!object) return;
    for (const binding of bindings) {
      if (sameRoot(binding, object) && binding.keys.length === object.keys.length + 1
        && object.keys.every((part, index) => binding.keys[index] === part)
        && (key === undefined || binding.keys.at(-1) === key)) reject(binding.name);
    }
  }
  function mutations(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) write(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) write(node.operand);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) write(node.initializer);
    if (ts.isDeleteExpression(node)) write(node.expression);
    if (ts.isCallExpression(node) && node.arguments.length) {
      const method = ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast);
      if (method === 'Object.assign') {
        for (const source of node.arguments.slice(1)) {
          if (!ts.isObjectLiteralExpression(source)) writeProperty(node.arguments[0]);
          else for (const property of source.properties) writeProperty(node.arguments[0], property.name?.text);
        }
      } else if (['Object.defineProperty', 'Reflect.defineProperty', 'Reflect.set', 'Reflect.deleteProperty'].includes(method)) {
        const name = node.arguments[1];
        writeProperty(node.arguments[0], name && (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : undefined);
      } else {
        // An imported namespace passed to an unknown helper can be mutated
        // outside its own factory, including through a second require alias.
        for (const argument of node.arguments) writeProperty(argument);
      }
    }
    ts.forEachChild(node, mutations);
  }
  mutations(ast);
}
function checkDeclarations(ts, source, expected) {
  const ast = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), names = new Set();
  const reject = message => fail('WGA_PREBUNDLE_DECLARATIONS', message);
  if (ast.parseDiagnostics.length) reject('declarationFile contains invalid TypeScript syntax');
  const specifier = name => {
    if (name.startsWith('#')) reject('Package-private declaration imports require an imports map and resources that are not copied');
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
    const capture = captureBuildInputs(projectRoot, preset, ts), declaration = capture.read(declarationFile).contents;
    capture.prepare(entryPoint);
    async function auditBuild() {
      let built;
      try {
        built = await esbuild.build({ absWorkingDir: projectRoot, entryPoints: [entryPoint], bundle: true, format: 'cjs', platform: 'node',
          target: 'es2022', outfile: path.join(temporary, 'index.cjs'), write: false, metafile: true, minify: true,
          legalComments: 'eof', sourcemap: false, logLevel: 'silent', plugins: [capture.plugin] });
      } catch (error) {
        // esbuild wraps plugin errors. Preserve the profile diagnostic contract.
        const cause = error.errors?.map(item => item.detail).find(detail => typeof detail?.code === 'string' && detail.code.startsWith('WGA_'));
        throw cause || error;
      }
      const unsupportedMeta = built.warnings.find(warning => warning.id === 'empty-import-meta');
      if (unsupportedMeta) fail('WGA_PREBUNDLE_IMPORT_META', 'import.meta is unavailable in the CommonJS prebundle; use an explicit portable value', {
        path: unsupportedMeta.location?.file, line: unsupportedMeta.location?.line,
      });
      const coverage = preset.verifyBuild(built.metafile);
      const captured = capture.inputs(built.metafile), entry = captured.find(({ source }) => source.physical === entryPoint);
      if (entry?.info.format !== 'esm') fail('WGA_PREBUNDLE_EXPORTS', 'entryPoint must be an ES module with explicit named exports');
      if (built.outputFiles.length !== 1) fail('WGA_PREBUNDLE_OUTPUT', 'Expected one self-contained JavaScript artifact');
      let source = built.outputFiles[0].text;
      checkArtifact(ts, source, names);
      const presetManifest = preset.manifest(), graph = checkRuntimeGraph(projectRoot, built.metafile, presetManifest, captured);
      checkModuleLoaders(ts, captured);
      checkExportStability(ts, entryPoint, entry.source.contents.toString('utf8'), source, names);
      checkDeclarations(ts, declaration.toString('utf8'), names);
      capture.verify();
      return { coverage, captured, entry, source, presetManifest, graph };
    }
    // Discover the whole graph before the authoritative compilation. Config
    // receipts gathered by a dependency's onLoad may postdate resolver reads
    // in that discovery pass. The second build starts with all those receipts
    // frozen, rechecks them, and cannot introduce a previously uncaptured file.
    await auditBuild();
    capture.seal();
    const { coverage, captured, entry, source: auditedSource, presetManifest, graph } = await auditBuild();
    let source = auditedSource;
    let strict;
    try {
      strict = await preserveModuleStrictness(esbuild, ts, projectRoot, captured, entry, names, path.join(temporary, 'index.cjs'));
    } catch (error) {
      capture.verify();
      const cause = error.errors?.map(item => item.detail).find(detail => typeof detail?.code === 'string' && detail.code.startsWith('WGA_'));
      throw cause || error;
    }
    if (strict.outputFiles.length !== 1) fail('WGA_PREBUNDLE_OUTPUT', 'Expected one self-contained strict module artifact');
    source = strict.outputFiles[0].text;
    checkArtifact(ts, source, names);
    const facade = `import owned from './index.cjs';\n${names.map((name, index) => `const value${index} = owned[${JSON.stringify(name)}];\nexport { value${index} as ${name} };\n`).join('')}`;
    const blocked = `throw new Error('WGA_PREBUNDLE_SERVER_ONLY: import this package only from server code');\n`;
    const pkg = { name: packageName, version: '0.0.0', private: true, type: 'commonjs', main: './index.cjs', module: './index.mjs', types: './index.d.ts', browser: './server-only.cjs',
      exports: { '.': { workerd: { types: './index.d.mts', default: './index.mjs' }, worker: { types: './index.d.mts', default: './index.mjs' }, browser: './server-only.cjs', import: { types: './index.d.mts', default: './index.mjs' }, require: { types: './index.d.cts', default: './index.cjs' } }, './manifest.json': './manifest.json', './package.json': './package.json' },
      files: ['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.mts', 'index.d.cts', 'server-only.cjs', 'manifest.json'] };
    const files = { 'index.cjs': source, 'index.mjs': facade, 'index.d.ts': declaration, 'index.d.mts': declaration, 'index.d.cts': declaration, 'server-only.cjs': blocked, 'package.json': JSON.stringify(pkg, null, 2) + '\n' };
    const artifacts = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }]));
    const manifest = { schemaVersion: 1, kind: 'google-worker-prebundle', serverOnly: true, exports: names, profile: presetManifest.profile, revision: presetManifest.revision,
      profileSha256: presetManifest.profileSha256, cacheKey: presetManifest.cacheKey, inputSha256: presetManifest.inputSha256, transformer: presetManifest.transformer,
      build: { prebundleVersion: 1, prebundleSha256: implementationSha256, esbuildVersion: esbuild.version, nodeVersion: process.version, format: 'cjs', moduleStrictness: 'preserved', target: 'es2022', minify: true, legalComments: 'eof', sourcemap: false },
      packages: presetManifest.packages, schemas: presetManifest.schemas, registrySha256: presetManifest.registrySha256,
      // Replacement text embeds a disposable registry path. The portable bundle
      // hash covers transformed output; retain path-independent source receipts.
      transformed: presetManifest.transformed.map(({ path: file, upstreamSha256, rules }) => ({ path: file, upstreamSha256, rules })),
      transformCoverage: coverage, runtime: graph.adapter, sources: graph.inputs,
      wrapper: { sha256: entry.source.sha256, declarationSha256: hash(declaration) }, artifacts };
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
      capture.verify();
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
