'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('PACK includes the Markdown targets linked from published documentation', () => {
    const [archive] = JSON.parse(cp.execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    }));
    const files = new Set(archive.files.map(file => file.path));
    const missing = [];
    for (const file of [...files].filter(file => file.endsWith('.md'))) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s[^)]*)?\)/g)) {
            const href = match[1].split('#')[0];
            if (!href || /^[a-z]+:/i.test(href)) continue;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href));
            if (target.endsWith('.md') && !files.has(target)) missing.push(`${file} -> ${target}`);
        }
    }
    assert.deepEqual(missing, [], 'Relative Markdown links must work within the installed package');
});
