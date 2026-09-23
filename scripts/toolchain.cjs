'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
function toolchain() {
    let globalRoot;
    try {
        globalRoot = cp.execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    }
    catch {
    }
    const roots = [path.resolve(__dirname, '..'), ...(globalRoot ? [globalRoot] : [])];
    const tsPath = require.resolve('typescript', { paths: roots });
    const ts = require(tsPath);
    let nodeTypes;
    for (const root of [...roots, ...(globalRoot ? [path.join(globalRoot, 'ts-node'), path.join(globalRoot, 'pptxgenjs')] : [])]) {
        try {
            nodeTypes = require.resolve('@types/node/package.json', { paths: [root] });
            break;
        }
        catch {
        }
    }
    if (!nodeTypes) {
        throw new Error('Install development dependencies: npm install');
    }
    return { ts, tsPath, nodeTypes, typeRoots: [path.dirname(path.dirname(nodeTypes))] };
}
function compile(extra = {}, files) {
    const { ts, typeRoots, tsPath, nodeTypes } = toolchain();
    const root = path.resolve(__dirname, '..');
    const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { ...extra, typeRoots });
    const program = ts.createProgram(files || parsed.fileNames, parsed.options);
    const result = program.emit();
    const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
    if (errors.length) {
        console.error(ts.formatDiagnosticsWithColorAndContext(errors, {
            getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n'
        }));
        throw new Error(`TypeScript validation failed: ${errors.length} diagnostics`);
    }
    return { typescript: ts.version, nodeTypes: JSON.parse(fs.readFileSync(nodeTypes)).version,
        typescriptSource: tsPath.startsWith(path.join(root, 'node_modules')) ? 'local' : 'preinstalled-global', strict: true, skipLibCheck: false };
}
module.exports = { toolchain, compile };
