'use strict';
// This is an offline consistency check. It does not execute documented commands,
// diagnose a deployed service, or turn source references into runtime evidence.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const ts = require('typescript');
const { readDocumentation } = require('./documentation-sources.cjs');
const ROOT = path.resolve(__dirname, '..');
const manifestFile = 'compatibility/doc-references.json';
const generatedCompatibility = new Set(['compatibility/exports-contract.json', 'compatibility/google-graph.json',
  'compatibility/google-native-graph.json', 'compatibility/google-types.json', 'compatibility/google-local.json']);
const checks = ['classified-document-inventory', 'local-markdown-links-and-anchors',
  'documented-npm-and-node-commands', 'repository-example-paths',
  'implemented-diagnostics-and-environment-references', 'catalog-requirement-and-decision-identities',
  'explicit-planned-and-historical-exceptions', 'current-input-hashes'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function need(condition, message) { if (!condition) throw new Error(`WGA_DOC_REFERENCE: ${message}`); }
function json(root, file) { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
function safePath(root, relative, { directory = false, optional = false } = {}) {
  need(typeof relative === 'string' && relative.length > 0 && !path.posix.isAbsolute(relative)
    && !relative.includes('\\') && !/[\x00-\x1f\x7f]/.test(relative)
    && !relative.split('/').includes('..') && !/^[A-Za-z]:/.test(relative), `unsafe repository path ${relative}`);
  const absolute = path.resolve(root, relative);
  if (optional && !fs.existsSync(absolute)) return undefined;
  need(fs.existsSync(absolute), `missing repository path ${relative}`);
  const real = fs.realpathSync(absolute), realRoot = fs.realpathSync(root);
  need(real === realRoot || real.startsWith(realRoot + path.sep), `repository path escapes root ${relative}`);
  need(directory ? fs.statSync(real).isDirectory() : fs.statSync(real).isFile(), `wrong path kind ${relative}`);
  return absolute;
}
function sourceInventory(root) {
  const result = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'verification', 'artifacts', 'coverage'].includes(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) { need(!/\.(?:[cm]?[jt]s|json)$/.test(entry.name), `symbolic source ${file}`); continue; }
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|json)$/.test(entry.name)) result.push(file);
    }
  }
  for (const directory of ['src', 'scripts', 'test', 'fixtures']) walk(directory);
  return result.sort();
}
function codeReferences(root, files) {
  const diagnostics = new Map(), environment = new Map(), assertions = new Map();
  const asts = new Map();
  for (const file of files.filter(file => /\.[cm]?[jt]s$/.test(file))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    need(!ast.parseDiagnostics.length, `source syntax ${file}`); asts.set(file, ast);
  }
  function add(map, code, file, node, ast, kind) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const records = map.get(code) || [];
    if (!records.some(record => record.file === file && record.line === line && record.kind === kind)) records.push({ file, line, kind });
    map.set(code, records);
  }
  for (const [file, ast] of asts) {
    const declarations = new Map(), imports = new Map(), readers = new Map();
    function declarationsVisit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
        for (const item of node.importClause.namedBindings.elements) imports.set(item.name.text,
          { file: path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text)), name: (item.propertyName || item.name).text });
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        function findReads(child) {
          if (ts.isElementAccessExpression(child) && /(?:^|\.)env$/i.test(child.expression.getText(ast)) && ts.isIdentifier(child.argumentExpression)) {
            const parameter = node.parameters.findIndex(item => ts.isIdentifier(item.name) && item.name.text === child.argumentExpression.text);
            if (parameter >= 0) readers.set(node.name.text, { parameter, node: child });
          }
          ts.forEachChild(child, findReads);
        }
        findReads(node.body);
      }
      ts.forEachChild(node, declarationsVisit);
    }
    declarationsVisit(ast);
    const implementation = file.startsWith('src/') || (file.startsWith('scripts/')
      && !/(?:^|\/)(?:test[-.]|doc-references\.)/.test(file) && !file.endsWith('-evidence.cjs'));
    const testSource = file.startsWith('test/') || file.startsWith('fixtures/') || file.startsWith('scripts/test-');
    function assertionParent(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isCallExpression(parent)) {
          const callee = parent.expression.getText(ast);
          if (/^(?:assert(?:\.[A-Za-z]+)?|check|need|expect)$/.test(callee)) return true;
        }
      }
      return false;
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && readers.has(node.expression.text)) {
        const reader = readers.get(node.expression.text), value = node.arguments[reader.parameter];
        if (value && ts.isStringLiteralLike(value) && /^WGA_[A-Z0-9_]+$/.test(value.text)) {
          add(environment, value.text, file, value, ast, 'literal-forwarded-to-environment-reader');
          add(environment, value.text, file, reader.node, ast, 'parameterized-environment-read');
        }
      }
      if (ts.isPropertyAccessExpression(node) && /(?:^|\.)env$/i.test(node.expression.getText(ast)) && /^WGA_[A-Z0-9_]+$/.test(node.name.text)) {
        add(environment, node.name.text, file, node, ast, 'environment-read');
      }
      if (ts.isElementAccessExpression(node) && /(?:^|\.)env$/i.test(node.expression.getText(ast))
        && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && /^WGA_[A-Z0-9_]+$/.test(node.argumentExpression.text)) {
        add(environment, node.argumentExpression.text, file, node, ast, 'environment-read');
      }
      // A finite imported registry can supply an environment key. Resolve the
      // actual const object and the consumer's lookup; a quoted key elsewhere
      // in a source file is insufficient. No module is imported or evaluated.
      if (ts.isElementAccessExpression(node) && /(?:^|\.)env$/i.test(node.expression.getText(ast))
        && node.argumentExpression && ts.isPropertyAccessExpression(node.argumentExpression)
        && ts.isIdentifier(node.argumentExpression.expression)) {
        const selected = declarations.get(node.argumentExpression.expression.text)?.initializer;
        const lookup = selected && ts.isConditionalExpression(selected) ? selected.whenTrue : selected;
        const imported = lookup && ts.isElementAccessExpression(lookup) && ts.isIdentifier(lookup.expression) ? imports.get(lookup.expression.text) : undefined;
        const registryAst = imported && asts.get(imported.file);
        if (registryAst) {
          function registryVisit(candidate) {
            if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === imported.name
              && candidate.initializer && ts.isObjectLiteralExpression(candidate.initializer)) {
              for (const entry of candidate.initializer.properties) if (ts.isPropertyAssignment(entry) && ts.isObjectLiteralExpression(entry.initializer)) {
                for (const field of entry.initializer.properties) if (ts.isPropertyAssignment(field)
                  && field.name.getText(registryAst).replace(/['"]/g, '') === node.argumentExpression.name.text
                  && ts.isStringLiteralLike(field.initializer) && /^WGA_[A-Z0-9_]+$/.test(field.initializer.text)) {
                  add(environment, field.initializer.text, imported.file, field, registryAst, 'finite-registry-environment-key');
                  add(environment, field.initializer.text, file, node, ast, 'imported-registry-environment-read');
                }
              }
            }
            ts.forEachChild(candidate, registryVisit);
          }
          registryVisit(registryAst);
        }
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isRegularExpressionLiteral(node)) {
        const value = node.text, codes = value.match(/\bWGA_[A-Z0-9_]+\b/g) || [];
        if (testSource && assertionParent(node)) for (const code of codes) add(assertions, code, file, node, ast, 'assertion-expression');
        if (implementation && /^WGA_[A-Z0-9_]+(?:$|[:\s])/.test(value)) {
          // Only executable diagnostic value positions count. A comment, test
          // name, arbitrary quoted sentence or unused const string cannot create
          // an implementation reference for an otherwise orphaned code.
          let parent = node.parent;
          if (ts.isTemplateExpression(parent)) parent = parent.parent;
          while (parent && (ts.isConditionalExpression(parent) || ts.isParenthesizedExpression(parent))) parent = parent.parent;
          const callable = parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))
            && /(?:^|\.)(?:[A-Za-z]*Error|fail|finish|cancelWithStatus|headerBudget|healthError|requireNumber|stop|trailer|wireError)$/.test(parent.expression.getText(ast));
          let field = parent && ts.isPropertyAssignment(parent) && /^(?:code|details|diagnostic)$/.test(parent.name.getText(ast).replace(/['"]/g, ''));
          if (field) {
            let container = parent.parent;
            while (container && (ts.isObjectLiteralExpression(container) || ts.isConditionalExpression(container)
              || ts.isParenthesizedExpression(container) || ts.isPropertyAssignment(container)
              || ts.isBinaryExpression(container) || ts.isArrayLiteralExpression(container))) container = container.parent;
            field = container && (ts.isReturnStatement(container) || ts.isCallExpression(container)
              || (ts.isArrowFunction(container) && container.body === parent.parent));
            if (!field && container && ts.isVariableDeclaration(container) && ts.isIdentifier(container.name)) {
              let scope = container.parent;
              while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
              const binding = container.name.text;
              function returned(child) {
                if (child !== scope && ts.isFunctionLike(child)) return;
                if (ts.isReturnStatement(child) && child.expression && ts.isObjectLiteralExpression(child.expression)
                  && child.expression.properties.some(property => ts.isShorthandPropertyAssignment(property) && property.name.text === binding)) field = true;
                ts.forEachChild(child, returned);
              }
              if (scope) returned(scope);
            }
          }
          if (callable || field) add(diagnostics, codes[0], file, node, ast, callable ? 'diagnostic-call-argument' : 'diagnostic-field');
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { diagnostics, environment, assertions };
}
function withoutFences(document) {
  const lines = document.text.split('\n');
  for (const block of document.blocks) for (let line = block.startLine - 1; line < block.endLine; line++) lines[line] = ' '.repeat(lines[line].length);
  return lines.join('\n');
}
function headings(document) {
  const result = new Set(), counts = new Map(), text = withoutFences(document);
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$|^([^\n]+)\n {0,3}(?:=+|-+)\s*$/gm)) {
    const title = (match[1] || match[2]).replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) || 0; counts.set(base, count + 1); result.add(base + (count ? `-${count}` : ''));
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/g)) result.add(match[1]);
  return result;
}
function markdownLinks(document) {
  const text = withoutFences(document).replace(/`+[^`\n]*`+/g, match => ' '.repeat(match.length));
  const definitions = new Map(), result = [], definitionSpans = [];
  const label = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)(?:\s+["'(].*)?$/gm)) {
    const key = label(match[1]); need(!definitions.has(key), `${document.file}: duplicate reference link ${key}`);
    const target = match[2].replace(/^<|>$/g, '');
    definitions.set(key, target); definitionSpans.push([match.index, match.index + match[0].length]);
    result.push({ target, index: match.index });
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '[' || text[index - 1] === '\\' || definitionSpans.some(([start, end]) => index >= start && index < end)) continue;
    let end = index + 1;
    while (end < text.length && (text[end] !== ']' || text[end - 1] === '\\') && text[end] !== '\n') end++;
    if (text[end] !== ']') continue;
    if (text[end + 1] === '(') {
      let cursor = end + 2; while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      const start = cursor; let target;
      if (text[cursor] === '<') {
        cursor = text.indexOf('>', cursor + 1); need(cursor >= 0, `${document.file}: unclosed link target`);
        target = text.slice(start + 1, cursor++);
      } else {
        let depth = 0;
        while (cursor < text.length) {
          if (text[cursor] === '\\') { cursor += 2; continue; }
          if (text[cursor] === '(') depth++;
          if (text[cursor] === ')') { if (!depth) break; depth--; }
          if (/\s/.test(text[cursor]) && !depth) break;
          cursor++;
        }
        target = text.slice(start, cursor);
      }
      while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      if (/['"]/.test(text[cursor] || '')) { const quote = text[cursor++]; while (cursor < text.length && text[cursor] !== quote) cursor++; cursor++; }
      while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      need(text[cursor] === ')', `${document.file}: malformed markdown link ${target}`);
      result.push({ target, index }); index = cursor;
    } else if (text[end + 1] === '[') {
      const close = text.indexOf(']', end + 2); need(close >= 0, `${document.file}: unclosed reference link`);
      const key = label(text.slice(end + 2, close) || text.slice(index + 1, end));
      need(definitions.has(key), `${document.file}: missing reference link ${key}`);
      result.push({ target: definitions.get(key), index }); index = close;
    } else {
      const key = label(text.slice(index + 1, end));
      if (definitions.has(key)) result.push({ target: definitions.get(key), index });
    }
  }
  return result.sort((left, right) => left.index - right.index);
}
function linkTarget(root, document, target, documentMap, inputFiles) {
  need(!/[\x00-\x20\x7f]/.test(target) && !target.includes('\\'), `${document.file}: invalid link ${target}`);
  if (/^(?:https?:|mailto:)/i.test(target)) return { status: 'external-not-fetched', target };
  need(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('/'), `${document.file}: unsupported link ${target}`);
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { need(false, `${document.file}: malformed percent escape ${target}`); }
  need(!decoded.includes('\\') && !/[\x00-\x1f\x7f]/.test(decoded)
    && !decoded.startsWith('/') && !/%(?:2e|2f|5c|00)/i.test(decoded), `${document.file}: unsafe encoded link ${target}`);
  if (decoded !== target) need(!decoded.split(/[/?#]/).includes('..'), `${document.file}: encoded traversal ${target}`);
  const split = decoded.indexOf('#'), fragment = split < 0 ? null : decoded.slice(split + 1);
  const rawPath = (split < 0 ? decoded : decoded.slice(0, split)).split('?')[0];
  const file = rawPath ? path.posix.normalize(path.posix.join(path.posix.dirname(document.file), rawPath)) : document.file;
  const absolute = path.join(root, file), directory = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
  safePath(root, file, { directory });
  if (!directory) inputFiles.add(file);
  if (fragment !== null) {
    if (documentMap.has(file)) need(headings(documentMap.get(file)).has(fragment), `${document.file}: missing anchor ${file}#${fragment}`);
    else {
      const lines = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
      need(lines && Number(lines[1]) > 0 && Number(lines[2] || lines[1]) >= Number(lines[1])
        && Number(lines[2] || lines[1]) <= fs.readFileSync(absolute, 'utf8').split('\n').length,
      `${document.file}: unsupported or missing file anchor ${file}#${fragment}`);
    }
  }
  return { status: 'passed', target, file, fragment, directory };
}
function scanDocReferences(root = ROOT) {
  const documents = readDocumentation(root), documentMap = new Map(documents.map(document => [document.file, document]));
  const manifest = json(root, manifestFile);
  need(manifest.schemaVersion === 1 && manifest.documents && Array.isArray(manifest.exceptions), 'manifest schema');
  need(isDeepStrictEqual(Object.keys(manifest.documents).sort(), documents.map(document => document.file)), 'unclassified, missing or renamed documentation file');
  for (const [file, classification] of Object.entries(manifest.documents)) need(['maintained', 'historical', 'planned'].includes(classification), `invalid classification ${file}`);
  const files = sourceInventory(root), references = codeReferences(root, files);
  const inputFiles = new Set(['package.json', 'package-lock.json', manifestFile, 'compatibility/test-catalog.json',
    'compatibility/requirements.json', 'scripts/documentation-sources.cjs', ...files, ...documentMap.keys()]);
  const catalog = json(root, 'compatibility/test-catalog.json'), requirements = json(root, 'compatibility/requirements.json');
  const caseIds = catalog.cases.map(row => row.id), requirementIds = requirements.requirements.map(row => row.id);
  need(new Set(caseIds).size === caseIds.length && caseIds.every(id => /^[A-Z]+-\d{3}$/.test(id)), 'invalid catalog identities');
  need(new Set(requirementIds).size === requirementIds.length && requirementIds.every(id => /^R-\d{3}$/.test(id)), 'invalid requirement identities');
  for (const row of catalog.cases) need(Array.isArray(row.requirement_ids) && row.requirement_ids.every(id => requirementIds.includes(id)), `orphan catalog requirement ${row.id}`);
  const decisionDocument = documentMap.get('docs/decisions.md');
  const decisionIds = decisionDocument ? [...withoutFences(decisionDocument).matchAll(/^## (D-\d{3}):/gm)].map(match => match[1]) : [];
  need(new Set(decisionIds).size === decisionIds.length, 'duplicate decision identities');
  const namespaces = { catalog: caseIds, requirement: requirementIds, decision: decisionIds };
  const allIds = new Set([...caseIds, ...requirementIds, ...decisionIds]);
  const exceptionsUsed = new Map();
  for (const [index, exception] of manifest.exceptions.entries()) {
    need(exception && Object.keys(exception).sort().join(',') === 'classification,context,file,kind,reason,value'
      && documentMap.has(exception.file) && ['diagnostic', 'npm-script', 'repository-path'].includes(exception.kind)
      && ['planned', 'historical', 'generated'].includes(exception.classification)
      && typeof exception.value === 'string' && exception.value && typeof exception.context === 'string' && exception.context
      && typeof exception.reason === 'string' && exception.reason.length >= 20, `invalid exception ${index}`);
    need(documentMap.get(exception.file).text.includes(exception.context) && exception.context.includes(exception.value), `stale exception context ${exception.file}:${exception.value}`);
    if (exception.kind === 'repository-path') need(!path.posix.isAbsolute(exception.value)
      && !/[\\%\x00-\x1f\x7f]/.test(exception.value) && !exception.value.split('/').includes('..'), `unsafe planned repository path ${exception.value}`);
    need(!manifest.exceptions.slice(0, index).some(other => other.file === exception.file && other.kind === exception.kind && other.value === exception.value && other.context === exception.context), `duplicate exception ${exception.value}`);
  }
  function exceptionFor(document, kind, value, index) {
    const exception = manifest.exceptions.find(item => {
      const contextIndex = document.text.indexOf(item.context);
      return item.file === document.file && item.kind === kind && item.value === value
        && index >= contextIndex && index < contextIndex + item.context.length;
    });
    if (!exception) return undefined;
    exceptionsUsed.set(exception, (exceptionsUsed.get(exception) || 0) + 1);
    return { status: `declared-${exception.classification}`, reason: exception.reason };
  }
  const packageFiles = new Map();
  function npmPackage(file = 'package.json') {
    if (!packageFiles.has(file)) { safePath(root, file); inputFiles.add(file); packageFiles.set(file, json(root, file)); }
    return packageFiles.get(file);
  }
  const rows = documents.map(document => {
    const result = [], counts = new Map();
    function record(kind, value, index, data) {
      const ordinal = (counts.get(kind) || 0) + 1; counts.set(kind, ordinal);
      result.push({ id: `${document.file}#${kind}-${ordinal}`, kind, value,
        line: document.text.slice(0, index).split('\n').length, ...data });
    }
    for (const link of markdownLinks(document)) record('markdown-link', link.target, link.index, linkTarget(root, document, link.target, documentMap, inputFiles));
    for (const match of document.text.matchAll(/\bnpm\s+(?:--prefix\s+([^\s`]+)\s+)?(?:run\s+([^\s`'"|;&]+)|\b(test|ci|install|pack)\b)/g)) {
      const script = match[2] || (match[3] === 'test' ? 'test' : undefined);
      const packageFile = match[1] ? `${match[1].replace(/\/$/, '')}/package.json` : 'package.json';
      const pkg = npmPackage(packageFile);
      if (script) {
        need(/^[A-Za-z0-9:_-]+$/.test(script), `${document.file}: invalid npm script name ${script}`);
        const exception = exceptionFor(document, 'npm-script', script, match.index);
        need(exception || typeof pkg.scripts?.[script] === 'string', `${document.file}: missing npm script ${script}`);
        if (exception) need(typeof pkg.scripts?.[script] !== 'string', `${document.file}: obsolete npm-script exception ${script}`);
        record('npm-script', script, match.index, exception || { status: 'passed', packageFile, command: pkg.scripts[script] });
      } else record('npm-builtin', match[3], match.index, { status: 'passed', packageFile });
    }
    for (const match of document.text.matchAll(/\bnode\s+([^\n`]+)/g)) {
      const command = match[1].split(/\s+#|&&|\|\||;/)[0].trim();
      const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
      let scriptFound = false;
      for (let index = 0; index < tokens.length; index++) {
        if (scriptFound && !tokens.includes('--test')) break; // Application arguments are not Node entry files.
        const token = tokens[index].replace(/^['"]|['"]$/g, '');
        if (token.startsWith('--')) {
          if (['--version', '--help'].includes(token)) break;
          if (/^--(?:test(?:-[a-z-]+)?|enable-source-maps|conditions|import|require|loader|inspect(?:-brk)?)(?:=|$)/.test(token)) {
            if (/^--(?:import|require|loader)(?:=|$)/.test(token)) {
              const equals = token.indexOf('='), preload = equals < 0 ? tokens[++index] : token.slice(equals + 1);
              need(preload, `${document.file}: missing Node preload`);
              const file = preload.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
              need(!/[\\%]/.test(file), `${document.file}: invalid Node preload ${file}`);
              safePath(root, file); inputFiles.add(file); record('node-command', file, match.index, { status: 'passed', file });
            } else if (['--conditions', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-timeout'].includes(token)) index++;
            continue;
          }
          need(false, `${document.file}: unclassified Node option ${token}`);
        }
        need(!/[\\%*{}]/.test(token) && /\.[cm]?[jt]s$/.test(token), `${document.file}: invalid Node entry ${token}`);
        const file = token.replace(/^\.\//, '');
        safePath(root, file); inputFiles.add(file); record('node-command', file, match.index, { status: 'passed', file }); scriptFound = true;
      }
    }
    for (const match of document.text.matchAll(/`((?:scripts|fixtures|test|src|vendor|examples|compatibility)\/[^`\n]+)`/g)) {
      const file = match[1], exception = exceptionFor(document, 'repository-path', file, match.index);
      if (!exception && file.endsWith('/*') && !file.slice(0, -2).includes('*')) {
        const directory = file.slice(0, -2); safePath(root, directory, { directory: true });
        const matches = fs.readdirSync(path.join(root, directory), { withFileTypes: true })
          .filter(entry => entry.isFile()).map(entry => `${directory}/${entry.name}`).sort();
        need(matches.length > 0, `${document.file}: empty repository path glob ${file}`);
        for (const target of matches) { safePath(root, target); inputFiles.add(target); }
        record('repository-path', file, match.index, { status: 'passed', matches });
      } else if (!exception) {
        const absolute = path.join(root, file), directory = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
        safePath(root, file, { directory }); if (!directory) inputFiles.add(file);
        record('repository-path', file, match.index, { status: 'passed', file, directory });
      } else record('repository-path', file, match.index, exception);
    }
    for (const match of document.text.matchAll(/\bWGA_[A-Z0-9_]+\b/g)) {
      const code = match[0], exception = exceptionFor(document, 'diagnostic', code, match.index);
      const implementation = references.diagnostics.get(code), environment = references.environment.get(code);
      if (exception) {
        need(!implementation && !environment, `${document.file}: obsolete diagnostic exception ${code}`);
        record('diagnostic', code, match.index, exception);
      } else if (environment) record('environment', code, match.index, { status: 'passed', references: environment });
      else {
        need(implementation, `${document.file}: orphan diagnostic ${code}`);
        record('diagnostic', code, match.index, { status: 'passed', implementation,
          assertionReferences: references.assertions.get(code) || [], assertionReferencesAreExecutionEvidence: false });
      }
    }
    for (const match of document.text.matchAll(/\b([A-Z][A-Z0-9]*)-(\d{3})\b((?:\/\d{3}\b)*)/g)) {
      if (match[1] === 'SHA' && ['256', '512'].includes(match[2])) continue;
      const ids = [match[2], ...match[3].split('/').filter(Boolean)].map(number => `${match[1]}-${number}`);
      for (const id of ids) need(allIds.has(id), `${document.file}: unknown catalog, requirement or decision ID ${id}`);
      const namespace = match[1] === 'R' ? 'requirement' : match[1] === 'D' ? 'decision' : 'catalog';
      record('catalog-identity', match[0], match.index, { status: 'passed', namespace, ids, runtimeExecutionClaim: false });
    }
    for (const match of document.text.matchAll(/\b([A-Z]+)-(\d{3})`?\s*[–—-]\s*`?([A-Z]+)-(\d{3})\b/g)) {
      need(match[1] === match[3] && Number(match[2]) <= Number(match[4]), `${document.file}: invalid identity range ${match[0]}`);
      const ids = Array.from({ length: Number(match[4]) - Number(match[2]) + 1 }, (_, index) => `${match[1]}-${String(Number(match[2]) + index).padStart(3, '0')}`);
      need(ids.length <= 1000 && ids.every(id => allIds.has(id)), `${document.file}: missing identity within range ${match[0]}`);
      record('catalog-range', match[0], match.index, { status: 'passed', ids, runtimeExecutionClaim: false });
    }
    return { file: document.file, classification: manifest.documents[document.file], sha256: document.sha256, checks: result };
  });
  for (const exception of manifest.exceptions) need(exceptionsUsed.has(exception), `unused exception ${exception.file}:${exception.value}`);
  const inputHashes = [...inputFiles].sort().map(file => { safePath(root, file); return [file, hash(fs.readFileSync(path.join(root, file)))]; });
  const evidence = Object.fromEntries(inputHashes.filter(([file]) => !generatedCompatibility.has(file) && !file.includes('/node_modules/')));
  const artifactInputs = Object.fromEntries(inputHashes.filter(([file]) => generatedCompatibility.has(file)));
  const installedInputs = Object.fromEntries(inputHashes.filter(([file]) => file.includes('/node_modules/')));
  const classificationCounts = Object.fromEntries(['maintained', 'historical', 'planned'].map(value => [value, rows.filter(row => row.classification === value).length]));
  const referenceCounts = {};
  for (const row of rows) for (const check of row.checks) referenceCounts[check.kind] = (referenceCounts[check.kind] || 0) + 1;
  return { schemaVersion: 1, status: 'passed', scope: 'offline-repository-documentation-consistency',
    commandsExecuted: false, externalLinksFetched: false, runtimeExecutionEstablished: false,
    inventory: { documentCount: rows.length, classificationCounts, sourceCount: files.length,
      inputCount: inputHashes.length, referenceCounts, exceptionCount: manifest.exceptions.length },
    namespaces, documents: rows, checks, evidence, artifactInputs, installedInputs };
}
function validateDocReferencesReport(report, root = ROOT) {
  need(report && report.status === 'passed', 'report did not pass');
  need(isDeepStrictEqual(report, scanDocReferences(root)), 'stale, incomplete or altered documentation-reference report');
  return true;
}
if (require.main === module) {
  try {
    const report = scanDocReferences(ROOT);
    fs.mkdirSync(path.join(ROOT, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'verification/doc-references.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ status: report.status, ...report.inventory }) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { scanDocReferences, validateDocReferencesReport, markdownLinks, headings, codeReferences, sourceInventory, checks };
