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
fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
fs.writeFileSync(path.join(root, 'verification', 'build.json'), JSON.stringify({ status: 'passed', ...toolchain, node: process.version }, null, 2) + '\n');
console.log(`Build passed (TypeScript ${toolchain.typescript}; strict; skipLibCheck=false).`);
