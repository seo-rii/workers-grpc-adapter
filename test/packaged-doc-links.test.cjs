'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');

function packedFiles() {
    const [archive] = JSON.parse(cp.execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    }));
    return new Set(archive.files.map(file => file.path));
}

test('PACK includes the Markdown targets linked from published documentation', () => {
    const files = packedFiles();
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

test('PACK evidence file counts match the actual published inventory', () => {
    const mapping = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/test-evidence.json'), 'utf8'));
    const counts = mapping.cases.filter(row => ['PKG-005', 'PKG-013'].includes(row.id))
        .flatMap(row => row.references.filter(ref => ref.report === 'verification/packaging.json'))
        .flatMap(ref => ref.assertions.filter(assertion => ['/packedFiles', '/files'].includes(assertion.pointer)));
    assert.equal(counts.length, 3, 'Both SDK profiles and the package asset check must retain their inventory assertions');
    const actual = packedFiles().size;
    for (const count of counts) assert.equal(count.equals, actual, 'Reviewed packaging evidence must match the real tarball inventory');
});
