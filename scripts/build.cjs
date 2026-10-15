'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const toolchain = require('./toolchain.cjs').compile();
const buildPreset = path.join(root, 'src/build');
if (fs.existsSync(buildPreset)) {
    fs.cpSync(buildPreset, path.join(root, 'dist/build'), { recursive: true });
}
for (const entry of ['index', 'config', 'adapter', 'client', 'server', 'status-details', 'sdk']) {
    const mod = require(path.join(root, 'dist', entry + '.js'));
    const names = Object.keys(mod).filter(k => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
    fs.writeFileSync(path.join(root, 'dist', entry + '.mjs'), `import cjs from './${entry}.js';\nexport default cjs;\n` + names.map(k => `export const ${k} = cjs.${k};\n`).join(''));
}
// Rebuilding with a private caller umask must preserve the package archive's
// permissions and integrity. Normalize only public dist output, not log files
// or the process umask. Declared CLI entries retain their executable mode.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {});
const executableFiles = new Set(bins.map(file => path.resolve(root, file)));
function normalizeOutputModes(directory) {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) normalizeOutputModes(file);
        else if (entry.isFile()) fs.chmodSync(file, executableFiles.has(file) ? 0o755 : 0o644);
    }
}
normalizeOutputModes(path.join(root, 'dist'));
fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
fs.writeFileSync(path.join(root, 'verification', 'build.json'), JSON.stringify({ status: 'passed', ...toolchain, node: process.version }, null, 2) + '\n');
console.log(`Build passed (TypeScript ${toolchain.typescript}; strict; skipLibCheck=false).`);
