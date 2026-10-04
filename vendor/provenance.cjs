'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const checks = ['required-upstream-pins', 'registry-version-provenance', 'archive-sha512-and-sha256',
    'bounded-safe-tar-members', 'archive-package-identity', 'archive-license-bytes',
    'explicit-archive-notice-policy', 'adapter-attribution', 'pristine-files-match-archive',
    'patch-input-hashes', 'patch-output-hashes', 'current-sources-match-patches'];
// Dropping a manifest row must not silently reduce the release check's scope.
const requiredFiles = [
    ['client.ts', 'client.ts'], ['make-client.ts', 'factory.ts'], ['metadata.ts', 'metadata.ts'],
    ['call.ts', 'call-surface.ts'], ['client-interceptors.ts', 'client-interceptors.ts'],
    ['call-interface.ts', 'call-interface.ts'], ['events.ts', 'events.ts'],
    ['object-stream.ts', 'object-stream.ts'], ['auth-context.ts', 'auth-context.ts'],
    ['error.ts', 'error.ts'], ['status-builder.ts', 'status-builder.ts'], ['index.ts', 'index.ts'],
];
const controlSources = ['vendor/verify.cjs', 'vendor/provenance.cjs', 'vendor/fetch-upstream.cjs',
    'vendor/UPSTREAM.json', 'vendor/README.md', 'vendor/NOTICE', 'vendor/LICENSE'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(value)
    && !value.startsWith('/') && !value.split('/').some(part => ['', '.', '..'].includes(part));
function need(value, message) { if (!value) throw new Error(`WGA_VENDOR_PROVENANCE: ${message}`); }
function equal(value, expected, message) {
    try { assert.deepEqual(value, expected); } catch { throw new Error(`WGA_VENDOR_PROVENANCE: ${message}`); }
}
function ownKeys(value, expected, message) {
    need(value && typeof value === 'object' && !Array.isArray(value), message);
    equal(Object.keys(value).sort(), [...expected].sort(), message);
}
function validateManifest(manifest) {
    need(manifest?.schemaVersion === 1, 'required manifest schemaVersion');
    need(manifest.package === '@grpc/grpc-js', 'required upstream package');
    need(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version), 'required exact upstream version');
    need(manifest.repository === 'https://github.com/grpc/grpc-node', 'required upstream repository');
    need(typeof manifest.gitHead === 'string' && /^[a-f0-9]{40}$/.test(manifest.gitHead), 'required upstream gitHead');
    need(manifest.tarball === `https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-${manifest.version}.tgz`, 'required allowlisted versioned tarball');
    need(typeof manifest.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.integrity)
        && Buffer.from(manifest.integrity.slice(7), 'base64').toString('base64') === manifest.integrity.slice(7), 'required canonical SHA-512 integrity');
    need(manifest.license === 'Apache-2.0' && hash(manifest.licenseSha256), 'required upstream license pins');
    ownKeys(manifest.archive, ['path', 'bytes', 'sha256'], 'required archive pins');
    need(manifest.archive.path === `.cache/vendor/grpc-js-${manifest.version}.tgz`
        && Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0 && manifest.archive.bytes <= MAX_ARCHIVE_BYTES
        && hash(manifest.archive.sha256), 'required bounded archive identity');
    ownKeys(manifest.registryMetadata, ['url', 'path', 'sha256'], 'required registry metadata pins');
    need(manifest.registryMetadata.url === `https://registry.npmjs.org/@grpc%2fgrpc-js/${manifest.version}`
        && manifest.registryMetadata.path === `.cache/vendor/grpc-js-${manifest.version}.registry.json`
        && hash(manifest.registryMetadata.sha256), 'required pinned registry version receipt');
    ownKeys(manifest.upstreamNotice, ['status', 'files'], 'explicit upstream NOTICE policy is required');
    need(['absent', 'present'].includes(manifest.upstreamNotice.status) && Array.isArray(manifest.upstreamNotice.files), 'explicit NOTICE presence/absence');
    need(manifest.upstreamNotice.status === 'absent' ? manifest.upstreamNotice.files.length === 0 : manifest.upstreamNotice.files.length > 0, 'NOTICE policy/file consistency');
    const noticePaths = new Set(), noticeCopies = new Set();
    for (const notice of manifest.upstreamNotice.files) {
        ownKeys(notice, ['upstreamPath', 'source', 'sha256'], 'NOTICE file pins');
        need(safePath(notice.upstreamPath) && /^NOTICE(?:\.[^/]+)?$/i.test(path.posix.basename(notice.upstreamPath))
            && safePath(notice.source) && notice.source.startsWith('vendor/upstream-notices/') && hash(notice.sha256), 'safe pinned NOTICE paths');
        need(!noticePaths.has(notice.upstreamPath) && !noticeCopies.has(notice.source), 'duplicate NOTICE path');
        noticePaths.add(notice.upstreamPath); noticeCopies.add(notice.source);
    }
    need(Array.isArray(manifest.files) && manifest.files.length === requiredFiles.length, 'complete client source manifest');
    manifest.files.forEach((file, index) => {
        ownKeys(file, ['upstreamPath', 'source', 'sha256', 'target', 'patchedSha256', 'patch', 'patchSha256'], 'complete client source pins');
        const [original, target] = requiredFiles[index];
        need(file.upstreamPath === `src/${original}` && file.source === `vendor/client/${original}` && file.target === `src/${target}`, 'exact client source/target set and order');
        need(hash(file.sha256) && hash(file.patchedSha256), `${file.target}: required source/output hashes`);
        if (['events.ts', 'error.ts'].includes(original)) {
            need(file.patch === null && file.patchSha256 === null && file.sha256 === file.patchedSha256, `${file.target}: unmodified upstream file pins`);
        } else {
            need(file.patch === `vendor/patches/${target}.patch` && hash(file.patchSha256), `${file.target}: required patch pins`);
        }
    });
    return manifest;
}
function regularPath(root, relative, { allowMissing = false } = {}) {
    need(safePath(relative), `unsafe repository path ${relative}`);
    let current = root;
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
            if (allowMissing && error.code === 'ENOENT') continue;
            need(false, `missing ${relative}; run node vendor/fetch-upstream.cjs explicitly for upstream cache files`);
        }
        need(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `expected regular path ${relative}`);
    }
    return current;
}
function readRegular(root, relative, limit = MAX_UNPACKED_BYTES) {
    const file = regularPath(root, relative);
    need(fs.statSync(file).size <= limit, `oversized input ${relative}`);
    return fs.readFileSync(file);
}
function registryProjection(value) {
    return { package: value.name, version: value.version, gitHead: value.gitHead,
        repository: value.repository, license: value.license, tarball: value.dist?.tarball, integrity: value.dist?.integrity };
}
function registryBytes(value) { return Buffer.from(JSON.stringify(registryProjection(value), null, 2) + '\n'); }
function validateRegistryReceipt(manifest, bytes) {
    need(bytes.length <= MAX_REGISTRY_BYTES && sha256(bytes) === manifest.registryMetadata.sha256, 'registry version receipt hash mismatch');
    const value = JSON.parse(bytes);
    ownKeys(value, ['package', 'version', 'gitHead', 'repository', 'license', 'tarball', 'integrity'], 'canonical registry projection fields');
    need(Buffer.from(JSON.stringify(value, null, 2) + '\n').equals(bytes), 'canonical registry receipt encoding');
    for (const key of ['package', 'version', 'gitHead', 'license', 'tarball', 'integrity'])
        need(value[key] === manifest[key], `registry ${key} differs from required pin`);
    ownKeys(value.repository, ['type', 'url'], 'registry repository identity');
    need(value.repository.type === 'git' && value.repository.url === 'git+https://github.com/grpc/grpc-node.git#master', 'registry repository differs from upstream pin');
    return value;
}
function tarMembers(bytes) {
    need(bytes.length <= MAX_ARCHIVE_BYTES, 'compressed archive limit');
    const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
    need(tar.length % 512 === 0, 'truncated tar record');
    const files = new Map();
    let offset = 0, terminated = false;
    const field = (header, start, end) => {
        const bytes = header.subarray(start, end), zero = bytes.indexOf(0);
        need(zero < 0 || bytes.subarray(zero).every(byte => byte === 0), 'non-canonical tar string');
        const text = bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('ascii');
        need(bytes.subarray(0, zero < 0 ? bytes.length : zero).every(byte => byte >= 32 && byte <= 126), 'non-ASCII tar path');
        return text;
    };
    const octal = bytes => {
        const value = bytes.toString('ascii');
        need(/^[0-7]+[\0 ]*$/.test(value), 'unsupported tar numeric encoding');
        const number = Number.parseInt(value, 8);
        need(Number.isSafeInteger(number) && number >= 0, 'invalid tar size/checksum');
        return number;
    };
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            need(tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'tar must end with zero blocks only');
            terminated = true; break;
        }
        let checksum = 0;
        for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
        need(octal(header.subarray(148, 156)) === checksum, 'tar header checksum mismatch');
        need(header.toString('ascii', 257, 263) === 'ustar\0' && header.toString('ascii', 263, 265) === '00', 'unsupported tar format');
        need(header[156] === 48 && header.subarray(157, 257).every(byte => byte === 0), 'only regular tar members are allowed');
        const prefix = field(header, 345, 500), basename = field(header, 0, 100);
        const name = prefix ? `${prefix}/${basename}` : basename;
        need(safePath(name) && name.startsWith('package/') && !files.has(name), 'unsafe or duplicate tar member');
        const size = octal(header.subarray(124, 136)), start = offset + 512;
        need(start + size <= tar.length && start + Math.ceil(size / 512) * 512 <= tar.length, 'truncated tar member');
        files.set(name, tar.subarray(start, start + size));
        need(files.size <= 4096, 'tar member count limit');
        offset = start + Math.ceil(size / 512) * 512;
    }
    need(terminated && files.size > 0, 'missing tar terminator/members');
    return files;
}
function validateArchive(manifest, bytes) {
    need(bytes.length === manifest.archive.bytes && sha256(bytes) === manifest.archive.sha256, 'upstream archive SHA-256/size mismatch');
    need(integrity(bytes) === manifest.integrity, 'upstream archive SHA-512 mismatch');
    const members = tarMembers(bytes);
    need(members.has('package/package.json') && members.has('package/LICENSE'), 'required archive package metadata and LICENSE');
    const pkg = JSON.parse(members.get('package/package.json'));
    need(pkg.name === manifest.package && pkg.version === manifest.version && pkg.license === manifest.license, 'archive package identity mismatch');
    need(sha256(members.get('package/LICENSE')) === manifest.licenseSha256, 'archive LICENSE differs from pin');
    const noticePaths = [...members.keys()].filter(name => /^NOTICE(?:\.[^/]+)?$/i.test(path.posix.basename(name))).sort();
    equal(noticePaths, manifest.upstreamNotice.files.map(file => `package/${file.upstreamPath}`).sort(), 'archive NOTICE presence/absence differs from explicit policy');
    for (const file of manifest.upstreamNotice.files) need(sha256(members.get(`package/${file.upstreamPath}`)) === file.sha256, 'archive NOTICE hash mismatch');
    for (const file of manifest.files) need(members.has(`package/${file.upstreamPath}`)
        && sha256(members.get(`package/${file.upstreamPath}`)) === file.sha256, `${file.source}: archive source hash mismatch`);
    return members;
}
function attribution(manifest) {
    return `This package includes modified client-side source files from ${manifest.package} ${manifest.version}.\n`
        + 'Copyright gRPC authors. Licensed under the Apache License, Version 2.0.\n'
        + `Upstream archive: ${manifest.tarball}\n`
        + `Upstream integrity: ${manifest.integrity}\n`
        + (manifest.upstreamNotice.status === 'absent'
            ? 'The verified npm archive contains LICENSE and no NOTICE or NOTICE.* file.\n'
            : 'The verified npm archive contains LICENSE and the upstream notices listed in\nUPSTREAM.json; exact notice copies are preserved under upstream-notices/.\n')
        + 'This attribution is supplied by workers-grpc-adapter, not the upstream project.\n'
        + 'Pristine files, source hashes, modifications, and reproduction instructions are\n'
        + 'preserved in this directory. See UPSTREAM.json and README.md.\n';
}
function provenanceSources(manifest) {
    return [...new Set([...controlSources, ...manifest.files.flatMap(file => [file.source, file.target, ...(file.patch ? [file.patch] : [])]),
        ...manifest.upstreamNotice.files.map(file => file.source)])].sort();
}
function verifyVendorProvenance(root, { apply = false } = {}) {
    const manifest = validateManifest(JSON.parse(readRegular(root, 'vendor/UPSTREAM.json', MAX_REGISTRY_BYTES)));
    // Required policy/verification sources are checked before --apply writes too.
    for (const source of controlSources) readRegular(root, source);
    const archive = readRegular(root, manifest.archive.path, MAX_ARCHIVE_BYTES);
    const registry = readRegular(root, manifest.registryMetadata.path, MAX_REGISTRY_BYTES);
    validateRegistryReceipt(manifest, registry);
    const members = validateArchive(manifest, archive);
    const license = readRegular(root, 'vendor/LICENSE');
    need(license.equals(members.get('package/LICENSE')), 'vendored LICENSE differs from actual archive');
    const notice = readRegular(root, 'vendor/NOTICE');
    need(notice.equals(Buffer.from(attribution(manifest))), 'adapter NOTICE does not match verified upstream provenance');
    for (const file of manifest.upstreamNotice.files) need(readRegular(root, file.source).equals(members.get(`package/${file.upstreamPath}`)), 'vendored NOTICE differs from actual archive');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-upstream-'));
    const reconstructed = [];
    try {
        for (const file of manifest.files) {
            const original = readRegular(root, file.source);
            need(original.equals(members.get(`package/${file.upstreamPath}`)), `${file.source}: pristine bytes differ from archive`);
            const target = path.join(scratch, path.basename(file.target));
            fs.writeFileSync(target, original);
            if (file.patch) {
                const patch = readRegular(root, file.patch);
                need(sha256(patch) === file.patchSha256, `${file.patch}: patch hash mismatch`);
                const lines = patch.toString('utf8').split('\n');
                need(lines[0] === `--- a/${file.target}` && lines[1] === `+++ b/${file.target}`
                    && lines.slice(2).every(line => !line.startsWith('--- ') && !line.startsWith('+++ ')), `${file.patch}: only the declared file may be patched`);
                // Passing the explicit scratch file prevents patch headers choosing paths.
                execFileSync('patch', ['--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch',
                    '-i', regularPath(root, file.patch), target], { cwd: scratch, stdio: 'pipe', timeout: 10000 });
            }
            const patched = fs.readFileSync(target);
            need(sha256(patched) === file.patchedSha256, `${file.target}: reconstructed hash mismatch`);
            regularPath(root, file.target, { allowMissing: apply });
            reconstructed.push({ file, patched });
        }
        // Every provenance and patch check completes before --apply can modify source.
        if (apply) for (const { file, patched } of reconstructed) {
            const target = regularPath(root, file.target, { allowMissing: true });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const temporary = `${target}.wga-apply-${process.pid}`;
            try {
                fs.writeFileSync(temporary, patched, { flag: 'wx' });
                fs.renameSync(temporary, target);
            } finally { fs.rmSync(temporary, { force: true }); }
        }
        for (const { file, patched } of reconstructed)
            need(readRegular(root, file.target).equals(patched), `${file.target}: source differs from recorded upstream patches`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    const report = {
        schemaVersion: 1, status: 'passed', offline: true,
        scope: 'Pinned npm archive and registry metadata; local source and patch provenance, not upstream signature or Git checkout verification',
        upstream: Object.fromEntries(['package', 'version', 'tarball', 'integrity', 'gitHead', 'repository', 'license'].map(key => [key, manifest[key]])),
        checks: [...checks],
        archive: { ...manifest.archive, integrity: integrity(archive), members: members.size, packageJsonSha256: sha256(members.get('package/package.json')) },
        registryMetadata: { ...manifest.registryMetadata, projection: 'package/version/gitHead/repository/license/tarball/integrity', gitHeadMatchesPin: true },
        license: { source: 'vendor/LICENSE', archivePath: 'package/LICENSE', sha256: sha256(license), bytes: license.length },
        notice: { status: manifest.upstreamNotice.status, files: manifest.upstreamNotice.files,
            archiveNoticePaths: [...members.keys()].filter(name => /^NOTICE(?:\.[^/]+)?$/i.test(path.posix.basename(name))).sort(),
            attribution: { path: 'vendor/NOTICE', sha256: sha256(notice), bytes: notice.length } },
        files: manifest.files.map(file => ({ ...file, archiveSha256: sha256(members.get(`package/${file.upstreamPath}`)),
            pristineMatchesArchive: true, patchReproduced: true, targetMatches: true })),
        evidence: Object.fromEntries(provenanceSources(manifest).map(file => [file, sha256(readRegular(root, file))])),
        artifacts: { [manifest.archive.path]: sha256(archive), [manifest.registryMetadata.path]: sha256(registry) },
    };
    validateVendorProvenanceReport(report);
    return report;
}
function validateVendorProvenanceReport(report) {
    need(report?.schemaVersion === 1 && report.status === 'passed' && report.offline === true, 'completed offline provenance report');
    need(report.scope === 'Pinned npm archive and registry metadata; local source and patch provenance, not upstream signature or Git checkout verification', 'provenance scope');
    equal(report.checks, checks, 'complete provenance check set');
    const manifest = validateManifest({ schemaVersion: 1, ...report.upstream, archive: {
        path: report.archive?.path, bytes: report.archive?.bytes, sha256: report.archive?.sha256 },
        registryMetadata: { url: report.registryMetadata?.url, path: report.registryMetadata?.path, sha256: report.registryMetadata?.sha256 },
        licenseSha256: report.license?.sha256, upstreamNotice: { status: report.notice?.status, files: report.notice?.files },
        files: report.files?.map(({ archiveSha256, pristineMatchesArchive, patchReproduced, targetMatches, ...file }) => file) });
    need(report.archive.integrity === manifest.integrity && Number.isSafeInteger(report.archive.members) && report.archive.members >= 14
        && hash(report.archive.packageJsonSha256), 'archive measurement');
    need(report.registryMetadata.projection === 'package/version/gitHead/repository/license/tarball/integrity'
        && report.registryMetadata.gitHeadMatchesPin === true, 'registry git provenance');
    need(report.license.source === 'vendor/LICENSE' && report.license.archivePath === 'package/LICENSE'
        && Number.isSafeInteger(report.license.bytes) && report.license.bytes > 0, 'archive license measurement');
    equal(report.notice.archiveNoticePaths, manifest.upstreamNotice.files.map(file => `package/${file.upstreamPath}`).sort(), 'reported archive NOTICE policy');
    need(report.notice.attribution?.path === 'vendor/NOTICE' && hash(report.notice.attribution.sha256)
        && report.notice.attribution.bytes === Buffer.byteLength(attribution(manifest))
        && report.notice.attribution.sha256 === sha256(Buffer.from(attribution(manifest))), 'reported adapter attribution');
    for (const file of report.files) need(file.archiveSha256 === file.sha256 && file.pristineMatchesArchive === true
        && file.patchReproduced === true && file.targetMatches === true, 'verified source/patch result');
    equal(Object.keys(report.evidence || {}).sort(), provenanceSources(manifest), 'complete provenance source map');
    need(Object.values(report.evidence).every(hash), 'provenance source hashes');
    equal(report.artifacts, { [manifest.archive.path]: manifest.archive.sha256, [manifest.registryMetadata.path]: manifest.registryMetadata.sha256 }, 'complete provenance archive/receipt map');
    return report;
}
function validateVendorProvenanceArtifacts(report, root) {
    validateVendorProvenanceReport(report);
    equal(report, verifyVendorProvenance(root), 'current files/archive do not reproduce the provenance receipt');
    return report;
}
module.exports = { MAX_ARCHIVE_BYTES, MAX_REGISTRY_BYTES, checks, sha256, integrity,
    validateManifest, readRegular, registryBytes, validateRegistryReceipt, validateArchive, tarMembers,
    attribution, verifyVendorProvenance, validateVendorProvenanceReport, validateVendorProvenanceArtifacts };
