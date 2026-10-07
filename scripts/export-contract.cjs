'use strict';
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function need(value, message) {
    if (!value) throw new Error(`WGA_EXPORT_CONTRACT: ${message}`);
}

function reviewExports({ policy, upstream, adapter, upstreamRuntime, adapterRuntime, extensions, subpaths = new Map(), subpathRuntime = new Map() }) {
    need(policy.schemaVersion === 1 && policy.upstream?.package === '@grpc/grpc-js'
        && policy.upstream.version === '1.14.5', 'unreviewed upstream reference');
    const native = new Map(upstream.exports.map(item => [item.name, item]));
    const replacement = new Map(adapter.exports.map(item => [item.name, item]));
    const names = [...new Set([...native.keys(), ...replacement.keys()])].sort();
    need(Array.isArray(policy.entries) && isDeepStrictEqual(policy.entries.map(item => item.name).sort(), names),
        'policy must classify every export exactly once');
    for (const [inventory, runtime, label] of [[upstream, upstreamRuntime, 'upstream'], [adapter, adapterRuntime, 'adapter']]) {
        need(isDeepStrictEqual(inventory.exports.filter(item => item.value).map(item => item.name).sort(), [...runtime].sort()),
            `${label} runtime/declaration export mismatch`);
    }
    need(Array.isArray(policy.extensions) && isDeepStrictEqual(policy.extensions.map(item => item.entry).sort(), [...extensions].sort()),
        'policy must classify every public type subpath exactly once');
    need(isDeepStrictEqual([...subpaths.keys()].sort(), [...extensions].sort())
        && isDeepStrictEqual([...subpathRuntime.keys()].sort(), [...extensions].sort()),
        'every public type subpath needs a declaration inventory and runtime exports');
    for (const entry of extensions) {
        need(isDeepStrictEqual(subpaths.get(entry).exports.filter(item => item.value).map(item => item.name).sort(),
            [...subpathRuntime.get(entry)].sort()), `${entry} runtime/declaration export mismatch`);
    }
    for (const item of [...policy.entries, ...policy.extensions]) {
        need(typeof item.scope === 'string' && item.scope.length >= 20
            && typeof item.signatureNotes === 'string' && item.signatureNotes.length >= 20, 'missing scope or signature explanation');
    }
    return policy.entries.map(item => {
        const before = native.get(item.name), after = replacement.get(item.name);
        need(['S', 'I', 'T', 'U'].includes(item.grade), `unknown grade for ${item.name}`);
        need(item.grade === 'U' ? !after : item.grade === 'T' ? after?.type && !after.value : after?.value,
            `grade disagrees with exported surface: ${item.name}`);
        return { ...item, status: 'passed', difference: !before ? 'added' : !after ? 'removed'
            : before.sha256 === after.sha256 ? 'same' : 'changed',
            upstream: before ? { type: before.type, value: before.value, sha256: before.sha256 } : null,
            adapter: after ? { type: after.type, value: after.value, sha256: after.sha256 } : null };
    });
}

// Keep readable declarations once, rather than repeating their dependency
// closures beneath every root symbol. Source-byte hashes belong to run evidence:
// comment/private-field changes alone are not public API changes.
function compactInventory(inventory) {
    const declarations = new Map();
    const exports = inventory.exports.map(({ dependencies, ...entry }) => ({ ...entry,
        dependencies: dependencies.map(item => {
            const key = digest(item);
            declarations.set(key, structuredClone(item));
            return key;
        }).sort(),
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { compilerVersion: inventory.compilerVersion, exports,
        declarations: Object.fromEntries([...declarations].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}

function checkReviewedSnapshot(expected, actual) {
    need(isDeepStrictEqual(expected, actual), 'public declarations or consumer imports changed; review the diff and regenerate the snapshot explicitly');
}

function reviewConsumerImports(records, policy, subpaths) {
    const grades = new Map(policy.entries.map(item => [item.name, item.grade]));
    return records.map(record => {
        need(record.specifier === '@grpc/grpc-js' || record.specifier.startsWith('@grpc/grpc-js/'),
            `unsupported consumer package ${record.specifier}`);
        const entry = record.specifier === '@grpc/grpc-js' ? '.' : '.' + record.specifier.slice('@grpc/grpc-js'.length);
        need(entry === '.' || entry === './package.json' || subpaths.has(entry), `unsupported consumer path ${record.specifier}`);
        const names = record.names.map(name => {
            if (entry === './package.json') return { name, grade: 'metadata' };
            const exported = entry === '.' ? grades.has(name) && grades.get(name) !== 'U'
                : subpaths.get(entry).exports.some(item => item.name === name);
            need(exported, `consumer imports unavailable name ${record.specifier}:${name}`);
            const value = entry === '.' ? ['S', 'I'].includes(grades.get(name)) : subpaths.get(entry).exports.find(item => item.name === name).value;
            need(!record.runtime || value, `consumer uses type-only name at runtime: ${record.specifier}:${name}`);
            // These public aliases share the root client implementation, so an
            // import-only readiness helper must not become supported by moving
            // the import to a deep client path.
            const clientAlias = entry === './build/src/client' || entry === './build/src/client.js';
            if (clientAlias && grades.has(name)) {
                const grade = grades.get(name);
                const declaration = subpaths.get(entry).exports.find(item => item.name === name);
                need(grade !== 'U' && (grade === 'T' ? declaration.type && !value : value),
                    `client alias disagrees with root grade: ${record.specifier}:${name}`);
            }
            return { name, grade: entry === '.' || clientAlias && grades.has(name) ? grades.get(name) : value ? 'S' : 'T' };
        });
        return { ...record, reviewedNames: names };
    });
}

module.exports = { reviewExports, compactInventory, checkReviewedSnapshot, reviewConsumerImports };
