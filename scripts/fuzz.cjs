'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let files = fs.readdirSync(path.join(root, 'test'))
    .filter(name => /(?:-fuzz|-property)\.test\.cjs$/.test(name))
    .sort().map(name => path.join('test', name));
const args = process.argv.slice(2);
if (process.env.WGA_FUZZ_PATH !== undefined) {
    const prefix = '--test-name-pattern=';
    if (args.length !== 1 || !args[0].startsWith(prefix)) {
        throw new Error('Replay requires only --test-name-pattern=<exact test name>');
    }
    const pattern = new RegExp(args[0].slice(prefix.length));
    const { namedTests } = require('./test-evidence.cjs');
    const matches = files.filter(file => file.endsWith('-property.test.cjs')).flatMap(file =>
        namedTests(fs.readFileSync(path.join(root, file), 'utf8'), file)
            .filter(name => pattern.test(name)).map(name => ({ file, name })));
    if (matches.length !== 1) throw new Error('Replay pattern must match exactly one property test');
    files = [matches[0].file];
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args, ...files], {
    cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
