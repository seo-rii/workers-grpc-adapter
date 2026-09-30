'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');
const compareNames = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...values].sort(compareNames);

function packageDirectory(file) {
    let directory = path.dirname(file);
    while (true) {
        if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
        const parent = path.dirname(directory);
        if (parent === directory) return path.dirname(file);
        directory = parent;
    }
}

/**
 * Inventory a declaration entry without loading its runtime module. Public
 * signatures and package-owned referenced declarations are fingerprinted;
 * external libraries are named, not recursively expanded. This is declaration
 * change detection, not a TypeScript structural-assignability proof.
 */
function inventory({ entry, packageRoot, typescript: ts = require('typescript') }) {
    entry = path.resolve(entry);
    packageRoot = path.resolve(packageRoot || packageDirectory(entry));
    if (!/\.d\.[cm]?ts$/.test(entry)) throw new TypeError('inventory entry must be a declaration file');
    const inside = file => {
        const relative = path.relative(packageRoot, file);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
            !relative.split(path.sep).includes('node_modules');
    };
    if (!inside(entry)) throw new TypeError('inventory entry must be inside packageRoot');
    const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16, skipLibCheck: true,
        types: [], noEmit: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(entry);
    if (!source) throw new Error('inventory declaration entry was not found');
    const module = checker.getSymbolAtLocation(source);
    if (!module) throw new Error('inventory declaration entry must be an external module');
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    const ownedSources = new Map([[slash(path.relative(packageRoot, entry)), hash(source.text)]]);
    const cache = new Map();
    const externalPackageCache = new Map();
    const target = symbol => symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
    const symbolName = symbol => {
        if (symbol.declarations?.some(ts.isSourceFile)) return '$module';
        const name = checker.getFullyQualifiedName(symbol);
        return name.replace(/^"[^"]*[/\\][^"]*"\.?/, '') || symbol.getName();
    };
    const isPrivate = node => !ts.isConstructorDeclaration(node) && (
        (node.name && ts.isPrivateIdentifier(node.name)) ||
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword));
    const isUnit = node => ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) || ts.isSourceFile(node);
    const declarationSymbol = symbol => {
        symbol = target(symbol);
        if (!symbol) return undefined;
        const declaration = symbol.declarations?.[0];
        if (!declaration || ts.isTypeParameterDeclaration(declaration)) return undefined;
        let node = declaration;
        while (node && !isUnit(node)) node = node.parent;
        if (!node || (ts.isSourceFile(node) && node !== declaration)) return undefined;
        return target(checker.getSymbolAtLocation(node.name || node)) || symbol;
    };
    const publicChildren = (node, visit) => {
        if (isPrivate(node)) return;
        visit(node);
        ts.forEachChild(node, child => publicChildren(child, visit));
    };
    const print = declaration => {
        // The compiler printer removes comments and normalizes whitespace. Drop
        // private implementation members, but keep constructor accessibility:
        // changing a private constructor to protected/public changes the API.
        const result = ts.transform(declaration, [context => {
            const visit = node => {
                if (isPrivate(node)) return undefined;
                if (node.kind === ts.SyntaxKind.ExportKeyword || node.kind === ts.SyntaxKind.DeclareKeyword ||
                    node.kind === ts.SyntaxKind.DefaultKeyword) return undefined;
                return ts.visitEachChild(node, visit, context);
            };
            return visit;
        }]);
        try {
            let node = result.transformed[0];
            if (ts.isVariableDeclaration(node)) {
                node = ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(
                    [node], declaration.parent.flags & ts.NodeFlags.BlockScoped));
            }
            return printer.printNode(ts.EmitHint.Unspecified, node, declaration.getSourceFile()).trim();
        } finally { result.dispose(); }
    };
    const external = symbol => {
        const declaration = symbol.declarations?.[0];
        const file = declaration?.getSourceFile().fileName;
        let owner = 'global';
        if (file) {
            let info = externalPackageCache.get(file);
            if (!info) {
                const directory = packageDirectory(file);
                const manifest = path.join(directory, 'package.json');
                const name = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).name : 'external';
                info = `${name}/${slash(path.relative(directory, file))}`;
                externalPackageCache.set(file, info);
            }
            owner = info;
        }
        const name = `${owner}#${symbolName(symbol)}`;
        return { name, kind: 'external', signature: name, references: [] };
    };
    const describe = original => {
        const symbol = target(original);
        if (cache.has(symbol)) return cache.get(symbol);
        const declarations = symbol.declarations || [];
        const owned = declarations.filter(declaration => inside(declaration.getSourceFile().fileName));
        if (!owned.length) {
            const result = external(symbol);
            cache.set(symbol, result);
            return result;
        }
        const first = owned[0];
        const name = `${slash(path.relative(packageRoot, first.getSourceFile().fileName))}#${symbolName(symbol)}`;
        const result = { name, kind: sorted(new Set(owned.map(node => ts.SyntaxKind[node.kind]))).join('+'), signature: '', references: [] };
        cache.set(symbol, result); // Break recursive and mutually recursive types.
        const references = new Set();
        const signatures = [];
        for (const declaration of owned) {
            const file = declaration.getSourceFile();
            ownedSources.set(slash(path.relative(packageRoot, file.fileName)), hash(file.text));
            if (ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration)) {
                const entries = checker.getExportsOfModule(symbol).map(exported => {
                    const resolved = target(exported);
                    references.add(resolved);
                    return `${exported.getName()}: ${exported.flags & ts.SymbolFlags.Alias && checker.getTypeOnlyAliasDeclaration(exported) ? 'type ' : ''}${symbolName(resolved)}`;
                });
                signatures.push(`namespace {\n${sorted(entries).map(value => `    ${value};`).join('\n')}\n}`);
            } else {
                signatures.push(print(declaration));
                publicChildren(declaration, node => {
                    let referenced;
                    if (ts.isIdentifier(node)) referenced = checker.getSymbolAtLocation(node);
                    // typeof import('./module') has no identifier for the module;
                    // retain its exported declaration graph as a dependency too.
                    else if (ts.isImportTypeNode(node) && !node.qualifier) referenced = checker.getTypeAtLocation(node).symbol;
                    const dependency = declarationSymbol(referenced);
                    if (dependency && dependency !== symbol) references.add(dependency);
                });
            }
        }
        result.signature = signatures.join('\n');
        result.references = [...references].map(describe);
        return result;
    };
    const records = checker.getExportsOfModule(module).map(exported => {
        const resolved = target(exported);
        const description = describe(resolved);
        const dependencies = new Map();
        const collect = dependency => {
            if (dependency === description || dependencies.has(dependency.name)) return;
            dependencies.set(dependency.name, { name: dependency.name, kind: dependency.kind, signature: dependency.signature });
            dependency.references.forEach(collect);
        };
        description.references.forEach(collect);
        const record = {
            name: exported.getName(),
            type: !!(resolved.flags & ts.SymbolFlags.Type),
            value: !!(resolved.flags & ts.SymbolFlags.Value) &&
                !(exported.flags & ts.SymbolFlags.Alias && checker.getTypeOnlyAliasDeclaration(exported)),
            kind: description.kind,
            signature: description.signature,
            dependencies: [...dependencies.values()].sort((a, b) => compareNames(a.name, b.name)),
        };
        return { ...record, sha256: hash(JSON.stringify(record)) };
    }).sort((a, b) => compareNames(a.name, b.name));
    return {
        schemaVersion: 1, compilerVersion: ts.version, exports: records,
        sources: [...ownedSources].map(([file, sha256]) => ({ file, sha256 })).sort((a, b) => compareNames(a.file, b.file)),
    };
}

function compareInventory(before, after) {
    const left = new Map(before.exports.map(record => [record.name, record]));
    const right = new Map(after.exports.map(record => [record.name, record]));
    const result = { added: [], removed: [], changed: [], same: [] };
    for (const name of sorted(new Set([...left.keys(), ...right.keys()]))) {
        if (!left.has(name)) result.added.push(name);
        else if (!right.has(name)) result.removed.push(name);
        else if (left.get(name).sha256 !== right.get(name).sha256) result.changed.push(name);
        else result.same.push(name);
    }
    return result;
}

module.exports = { inventory, compareInventory };
