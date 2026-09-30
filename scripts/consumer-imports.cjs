'use strict';
const ts = require('typescript');

// This is a source inventory, not a resolver or evaluator. In particular an
// escaped module namespace remains an explicit gap in the list of named uses.
function inspectConsumerImports(source, file) {
    if (typeof source !== 'string' || typeof file !== 'string') throw new TypeError('Consumer source and file must be strings');
    if (!source.includes('@grpc/grpc-js')) return [];
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
        /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length) {
        throw new TypeError(`Cannot inventory malformed consumer source: ${file}:${sourceFile.parseDiagnostics[0].start}`);
    }
    // A one-file, no-lib program binds local names without reading dependencies.
    // Symbol identity prevents a shadowing parameter from being attributed to
    // the imported namespace. No type/module resolution is performed.
    const host = {
        getSourceFile: name => name === file ? sourceFile : undefined,
        getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => '',
        getDirectories: () => [], fileExists: name => name === file,
        readFile: name => name === file ? source : undefined,
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    };
    const checker = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
    const records = [];
    const namespaces = new Map();
    const namespaceDeclarations = new Set();
    function target(node) {
        return node && ts.isStringLiteralLike(node) && (node.text === '@grpc/grpc-js' || node.text.startsWith('@grpc/grpc-js/')) ? node.text : null;
    }
    function runtime(node) {
        if (sourceFile.isDeclarationFile) return false;
        for (let current = node; current; current = current.parent) {
            if (current.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
        }
        return true;
    }
    function add(specifier, kind, isRuntime, names = [], namespace = false, dynamicAccess = false) {
        const record = { specifier, kind, runtime: isRuntime, names: new Set(names), namespace, dynamicAccess };
        records.push(record);
        return record;
    }
    function register(identifier, record) {
        const symbol = checker.getSymbolAtLocation(identifier);
        namespaceDeclarations.add(identifier);
        if (symbol) namespaces.set(symbol, record);
        else record.dynamicAccess = true;
    }
    function unwrapped(node) {
        while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) ||
            ts.isTypeAssertionExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent))) node = node.parent;
        return node;
    }
    function propertyName(node) {
        return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : null;
    }
    function destructure(pattern, record) {
        for (const element of pattern.elements) {
            if (element.dotDotDotToken) { record.dynamicAccess = true; continue; }
            const property = element.propertyName || (ts.isIdentifier(element.name) ? element.name : null);
            const name = property && ts.isComputedPropertyName(property) ?
                (ts.isStringLiteralLike(property.expression) || ts.isNumericLiteral(property.expression) ? property.expression.text : null) : propertyName(property);
            if (name === null) record.dynamicAccess = true;
            else record.names.add(name);
        }
    }
    function useNamespace(expression, record, canBind) {
        const node = unwrapped(expression);
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) record.names.add(parent.name.text);
        else if (ts.isQualifiedName(parent) && parent.left === node) record.names.add(parent.right.text);
        else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
            if (parent.argumentExpression && (ts.isStringLiteralLike(parent.argumentExpression) || ts.isNumericLiteral(parent.argumentExpression))) record.names.add(parent.argumentExpression.text);
            else record.dynamicAccess = true;
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
            if (canBind && ts.isIdentifier(parent.name)) register(parent.name, record);
            else if (ts.isObjectBindingPattern(parent.name)) {
                if (canBind) record.namespace = false;
                destructure(parent.name, record);
            }
            else record.dynamicAccess = true;
        } else if (ts.isExpressionStatement(parent)) {
            // A bare require has an import side effect but requests no exports.
            if (!canBind) record.dynamicAccess = true;
        } else record.dynamicAccess = true;
    }
    function visit(node) {
        if (ts.isImportDeclaration(node)) {
            const specifier = target(node.moduleSpecifier);
            if (specifier) {
                const clause = node.importClause;
                if (!clause) add(specifier, 'import', runtime(node));
                else {
                    if (clause.name) add(specifier, 'import', runtime(node) && !clause.isTypeOnly, ['default']);
                    const bindings = clause.namedBindings;
                    if (bindings && ts.isNamespaceImport(bindings)) {
                        register(bindings.name, add(specifier, 'import', runtime(node) && !clause.isTypeOnly, [], true));
                    } else if (bindings) {
                        for (const element of bindings.elements) add(specifier, 'import', runtime(node) && !clause.isTypeOnly && !element.isTypeOnly, [(element.propertyName || element.name).text]);
                    }
                }
            }
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const specifier = target(node.moduleReference.expression);
            if (specifier) register(node.name, add(specifier, 'import-equals', runtime(node) && !node.isTypeOnly, [], true));
        } else if (ts.isExportDeclaration(node)) {
            const specifier = target(node.moduleSpecifier);
            if (specifier) {
                if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) add(specifier, 'export', runtime(node) && !node.isTypeOnly, [], true, true);
                else for (const element of node.exportClause.elements) add(specifier, 'export', runtime(node) && !node.isTypeOnly && !element.isTypeOnly, [(element.propertyName || element.name).text]);
            }
        } else if (ts.isImportTypeNode(node)) {
            const specifier = ts.isLiteralTypeNode(node.argument) && target(node.argument.literal);
            if (specifier) {
                let qualifier = node.qualifier;
                while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
                add(specifier, 'import-type', false, qualifier ? [qualifier.text] : [], !qualifier, !qualifier);
            }
        } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
            const specifier = target(node.arguments[0]);
            if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require' && !checker.getSymbolAtLocation(node.expression)?.declarations?.length) {
                const record = add(specifier, 'require', runtime(node), [], true);
                let expression = unwrapped(node);
                const parent = expression.parent;
                if (ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === expression &&
                    (ts.isIdentifier(parent.expression) ? parent.expression.text : ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : '') === '__importStar') expression = parent;
                useNamespace(expression, record, true);
            } else if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                // Promise callbacks/await aliases need dataflow beyond the
                // lexical module bindings inventoried here.
                add(specifier, 'dynamic-import', runtime(node), [], true, true);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    function references(node) {
        if (ts.isIdentifier(node) && !namespaceDeclarations.has(node)) {
            let symbol = checker.getSymbolAtLocation(node);
            if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) symbol = checker.getShorthandAssignmentValueSymbol(node.parent);
            if (ts.isExportSpecifier(node.parent)) symbol = checker.getExportSpecifierLocalTargetSymbol(node.parent);
            const record = namespaces.get(symbol);
            if (record) useNamespace(node, record, false);
        }
        ts.forEachChild(node, references);
    }
    references(sourceFile);
    const merged = new Map();
    for (const record of records) {
        const key = JSON.stringify([record.specifier, record.kind, record.runtime, record.namespace]);
        if (!merged.has(key)) merged.set(key, { ...record, names: new Set() });
        const entry = merged.get(key);
        for (const name of record.names) entry.names.add(name);
        entry.dynamicAccess ||= record.dynamicAccess;
    }
    return [...merged.values()].map(record => ({ ...record, names: [...record.names].sort() }))
        .sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
}

module.exports = { inspectConsumerImports };
