'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { validateManifest, validateRegistryReceipt, validateArchive, tarMembers, verifyVendorProvenance,
    validateVendorProvenanceReport, validateVendorProvenanceArtifacts } = require('../vendor/provenance.cjs');
const { fetchUpstream } = require('../vendor/fetch-upstream.cjs');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/UPSTREAM.json')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const clone = value => JSON.parse(JSON.stringify(value));
const read = (base, file) => fs.readFileSync(path.join(base, file));
function put(base, file, bytes) {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    fs.writeFileSync(path.join(base, file), bytes);
}
function writeManifest(base, value) { put(base, 'vendor/UPSTREAM.json', JSON.stringify(value, null, 2) + '\n'); }
function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-vendor-test-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    fs.cpSync(path.join(root, 'vendor'), path.join(base, 'vendor'), { recursive: true });
    for (const file of manifest.files) put(base, file.target, read(root, file.target));
    for (const file of [manifest.archive.path, manifest.registryMetadata.path]) put(base, file, read(root, file));
    put(base, 'block-network.cjs', `for (const name of ['node:http', 'node:https']) {
        const module = require(name); module.get = module.request = () => { throw new Error('NETWORK_FORBIDDEN'); };
    }
    global.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
    return base;
}
function cli(base, args = []) {
    return spawnSync(process.execPath, ['--require', path.join(base, 'block-network.cjs'), 'vendor/verify.cjs', ...args],
        { cwd: base, encoding: 'utf8', timeout: 10000 });
}
function independentArchive(rows) {
    // A deliberately synthetic, minimal POSIX ustar writer independent of the
    // verifier. These controls do not claim to be an executed upstream release.
    const chunks = [];
    for (const { name, bytes, type = '0', link = '' } of rows) {
        assert.ok(Buffer.byteLength(name) < 100);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108);
        header.write('0000000\0', 116); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
        header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100);
        header.write('ustar\0', 257); header.write('00', 263);
        const sum = header.reduce((value, byte) => value + byte, 0);
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function syntheticRows() {
    return [{ name: 'package/package.json', bytes: Buffer.from(JSON.stringify({ name: '@grpc/grpc-js', version: '1.14.0', license: 'Apache-2.0' })) },
        { name: 'package/LICENSE', bytes: read(root, 'vendor/LICENSE') },
        ...manifest.files.map(file => ({ name: `package/${file.upstreamPath}`, bytes: read(root, file.source) }))];
}
function repinArchive(value, archive) {
    value.archive.bytes = archive.length; value.archive.sha256 = digest(archive); value.integrity = sri(archive);
    return value;
}

test('DOC vendor release verifies the actual pinned archive, license, notices and all twelve patches offline', t => {
    const base = fixture(t);
    const result = cli(base);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(read(base, 'verification/vendor-provenance.json'));
    assert.equal(report.archive.bytes, 434487);
    assert.equal(report.archive.sha256, 'fc30fc45d9f785af24f7153451b7e755f080ed258eca8fc956f3e9b39b075d12');
    assert.equal(report.archive.members, 681);
    assert.equal(report.upstream.gitHead, '3dd281b00fd54ad8f811e941c1d9acc0785c3182');
    assert.equal(report.files.length, 12);
    assert.equal(report.checks.length, 12);
    assert.equal(report.notice.status, 'absent');
    assert.deepEqual(report.notice.archiveNoticePaths, []);
    assert.equal(report.offline, true);
    assert.equal(validateVendorProvenanceArtifacts(report, base), report);
});

test('DOC vendor required provenance pins fail closed when missing, null or malformed', () => {
    const paths = ['schemaVersion', 'package', 'version', 'repository', 'gitHead', 'tarball', 'integrity', 'license', 'licenseSha256',
        'archive', 'archive.path', 'archive.bytes', 'archive.sha256', 'registryMetadata', 'registryMetadata.url',
        'registryMetadata.path', 'registryMetadata.sha256', 'upstreamNotice', 'upstreamNotice.status', 'upstreamNotice.files',
        'files', 'files.0.upstreamPath', 'files.0.source', 'files.0.sha256', 'files.0.target', 'files.0.patchedSha256',
        'files.0.patch', 'files.0.patchSha256'];
    for (const field of paths) for (const mutation of ['missing', 'null']) {
        const value = clone(manifest), parts = field.split('.'), key = parts.pop();
        const parent = parts.reduce((item, part) => item[part], value);
        if (mutation === 'missing') delete parent[key]; else parent[key] = null;
        assert.throws(() => validateManifest(value), /WGA_VENDOR_PROVENANCE/, `${field} ${mutation}`);
    }
    for (const change of [value => { value.version = '^1.14.0'; }, value => { value.gitHead = 'main'; },
        value => { value.tarball = 'http://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.14.0.tgz'; },
        value => { value.tarball = 'https://registry.npmjs.org.evil.invalid/@grpc/grpc-js/-/grpc-js-1.14.0.tgz'; },
        value => { value.archive.path = '../outside.tgz'; }, value => { value.archive.bytes = Infinity; },
        value => { value.integrity = 'sha256-' + '0'.repeat(64); }, value => { value.files.pop(); },
        value => { value.files[1] = clone(value.files[0]); }, value => { value.files[0].target = '../outside.ts'; },
        value => { value.upstreamNotice.status = 'unknown'; }, value => { value.upstreamNotice.status = 'present'; }]) {
        const value = clone(manifest); change(value);
        assert.throws(() => validateManifest(value), /WGA_VENDOR_PROVENANCE/);
    }
    const receipt = read(root, manifest.registryMetadata.path);
    for (const field of ['version', 'gitHead', 'license', 'tarball', 'integrity']) {
        const value = clone(manifest); value[field] = field === 'gitHead' ? '0'.repeat(40) : 'different';
        assert.throws(() => validateRegistryReceipt(value, receipt), /differs from required pin/, field);
    }
    assert.throws(() => validateRegistryReceipt(manifest, Buffer.concat([receipt, Buffer.from(' ')])), /receipt hash mismatch/);
});

test('DOC vendor CLI rejects missing archives and provenance or NOTICE drift without downloading or leaving a passing receipt', t => {
    const base = fixture(t);
    const controls = [
        ['missing gitHead', 'vendor/UPSTREAM.json', () => { const value = clone(manifest); delete value.gitHead; writeManifest(base, value); }, /required upstream gitHead/],
        ['null NOTICE policy', 'vendor/UPSTREAM.json', () => { const value = clone(manifest); value.upstreamNotice = null; writeManifest(base, value); }, /NOTICE policy/],
        ['missing archive', manifest.archive.path, () => fs.rmSync(path.join(base, manifest.archive.path)), /missing.*tgz/],
        ['tampered archive', manifest.archive.path, () => { const value = read(base, manifest.archive.path); value[32] ^= 1; put(base, manifest.archive.path, value); }, /archive SHA-256/],
        ['tampered registry receipt', manifest.registryMetadata.path, () => put(base, manifest.registryMetadata.path, '{}\n'), /receipt hash mismatch/],
        ['missing NOTICE', 'vendor/NOTICE', () => fs.rmSync(path.join(base, 'vendor/NOTICE')), /missing vendor\/NOTICE/],
        ['false NOTICE attribution', 'vendor/NOTICE', () => put(base, 'vendor/NOTICE', 'Upstream includes a NOTICE.\n'), /adapter NOTICE/],
        ['changed license', 'vendor/LICENSE', () => put(base, 'vendor/LICENSE', 'Apache-2.0\n'), /vendored LICENSE/],
    ];
    for (const [name, file, corrupt, expected] of controls) {
        const original = read(base, file);
        put(base, 'verification/vendor-provenance.json', '{"status":"passed"}\n');
        corrupt(); const result = cli(base);
        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.match(result.stderr, expected, name);
        assert.doesNotMatch(result.stderr, /NETWORK_FORBIDDEN/, name);
        assert.equal(fs.existsSync(path.join(base, 'verification/vendor-provenance.json')), false, name);
        put(base, file, original);
    }
});

test('DOC release prepack invokes the required vendor verifier and refuses missing provenance', t => {
    const base = fixture(t), prepack = JSON.parse(read(root, 'package.json')).scripts.prepack;
    assert.equal(prepack, 'npm run build && node vendor/verify.cjs');
    // Compilation has separate gates. This isolated release control exercises the
    // repository's actual prepack command with a successful, side-effect-free build.
    put(base, 'package.json', JSON.stringify({ name: 'vendor-prepack-control', private: true,
        scripts: { prepack, build: 'node scripts/build.cjs' } }));
    put(base, 'scripts/build.cjs', "'use strict';\n");
    const invoke = () => spawnSync('npm', ['run', 'prepack', '--silent'], { cwd: base, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: `--require=${path.join(base, 'block-network.cjs')}` } });
    const passed = invoke(); assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(read(base, 'verification/vendor-provenance.json')).status, 'passed');
    const invalid = clone(manifest); invalid.gitHead = null; writeManifest(base, invalid);
    const failed = invoke(); assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /required upstream gitHead/);
    assert.doesNotMatch(failed.stderr, /NETWORK_FORBIDDEN/);
    assert.equal(fs.existsSync(path.join(base, 'verification/vendor-provenance.json')), false);
});

test('DOC vendor archive controls independently enforce package, LICENSE, source and explicit NOTICE policies', () => {
    const rows = syntheticRows(), archive = independentArchive(rows), value = repinArchive(clone(manifest), archive);
    assert.equal(validateArchive(value, archive).size, 14);
    for (const name of ['package/NOTICE', 'package/NOTICE.txt', 'package/proto/notice.MD']) {
        const notice = Buffer.from('Independent synthetic upstream notice.\n');
        const withNotice = independentArchive([...rows, { name, bytes: notice }]);
        const pinned = repinArchive(clone(manifest), withNotice);
        assert.throws(() => validateArchive(pinned, withNotice), /NOTICE presence\/absence/);
        pinned.upstreamNotice = { status: 'present', files: [{ upstreamPath: name.slice(8), source: 'vendor/upstream-notices/NOTICE', sha256: digest(notice) }] };
        validateManifest(pinned);
        assert.equal(validateArchive(pinned, withNotice).get(name).toString(), notice.toString());
        pinned.upstreamNotice.files[0].sha256 = '0'.repeat(64);
        assert.throws(() => validateArchive(pinned, withNotice), /NOTICE hash mismatch/);
    }
    for (const [name, change, expected] of [
        ['package version', list => { list[0].bytes = Buffer.from('{"name":"@grpc/grpc-js","version":"9.0.0","license":"Apache-2.0"}'); }, /package identity/],
        ['LICENSE', list => { list[1].bytes = Buffer.from('different license'); }, /LICENSE differs/],
        ['pristine source', list => { list[2].bytes = Buffer.from('different source'); }, /archive source hash/],
        ['missing source', list => { list.pop(); }, /archive source hash/],
        ['missing package', list => { list.shift(); }, /required archive package/],
    ]) {
        const changed = syntheticRows(); change(changed);
        const bytes = independentArchive(changed), pinned = repinArchive(clone(manifest), bytes);
        assert.throws(() => validateArchive(pinned, bytes), expected, name);
    }
    const missingNotice = clone(value);
    missingNotice.upstreamNotice = { status: 'present', files: [{ upstreamPath: 'NOTICE', source: 'vendor/upstream-notices/NOTICE', sha256: '0'.repeat(64) }] };
    assert.throws(() => validateArchive(missingNotice, archive), /NOTICE presence\/absence/);
    const wrongSri = clone(value); wrongSri.integrity = manifest.integrity;
    assert.throws(() => validateArchive(wrongSri, archive), /archive SHA-512/);
});

test('DOC vendor tar parser rejects unsafe paths, links, duplicates, truncation and oversized decompression', () => {
    const base = { name: 'package/example', bytes: Buffer.from('test') };
    for (const rows of [[{ ...base, name: 'package/../escape' }], [{ ...base, name: '/absolute' }],
        [{ ...base, name: 'package//empty' }], [{ ...base, type: '2', link: '../../escape' }], [base, base]]) {
        assert.throws(() => tarMembers(independentArchive(rows)), /WGA_VENDOR_PROVENANCE/);
    }
    const tar = zlib.gunzipSync(independentArchive([base]));
    const badChecksum = Buffer.from(tar); badChecksum[0] ^= 1;
    assert.throws(() => tarMembers(zlib.gzipSync(badChecksum)), /checksum/);
    assert.throws(() => tarMembers(zlib.gzipSync(tar.subarray(0, tar.length - 512))), /zero blocks/);
    assert.throws(() => tarMembers(zlib.gzipSync(tar.subarray(0, tar.length - 1))), /truncated tar record/);
    const trailing = Buffer.from(tar); trailing[trailing.length - 1] = 1;
    assert.throws(() => tarMembers(zlib.gzipSync(trailing)), /zero blocks/);
    assert.throws(() => tarMembers(Buffer.alloc(2 * 1024 * 1024 + 1)), /compressed archive limit/);
    assert.throws(() => tarMembers(zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024 + 512))), /larger than|Cannot create|size/i);
});

test('DOC vendor apply validates every patch before changing source and safely reconstructs approved targets', t => {
    const base = fixture(t), first = manifest.files[0], last = manifest.files.at(-1);
    const original = read(base, first.target), patch = read(base, last.patch), pristine = read(base, first.source);
    put(base, first.source, Buffer.from('modified pristine file'));
    assert.throws(() => verifyVendorProvenance(base), /pristine bytes differ/);
    put(base, first.source, pristine);
    const damaged = Buffer.from('must remain unchanged on failed apply\n');
    put(base, first.target, damaged); put(base, last.patch, Buffer.from('invalid late patch\n'));
    const failed = cli(base, ['--apply']);
    assert.equal(failed.status, 1); assert.match(failed.stderr, /patch hash mismatch/);
    assert.deepEqual(read(base, first.target), damaged);
    put(base, last.patch, patch);
    assert.throws(() => verifyVendorProvenance(base), /source differs from recorded/);
    const success = cli(base, ['--apply']);
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(read(base, first.target), original);
    const value = clone(manifest);
    const changedPatch = Buffer.from(patch.toString().replace(`+++ b/${last.target}`, '+++ b/../../escaped.ts'));
    value.files.at(-1).patchSha256 = digest(changedPatch);
    put(base, last.patch, changedPatch); writeManifest(base, value);
    put(base, first.target, damaged);
    assert.throws(() => verifyVendorProvenance(base, { apply: true }), /only the declared file/);
    assert.deepEqual(read(base, first.target), damaged);
    assert.equal(fs.existsSync(path.join(base, 'escaped.ts')), false);
    writeManifest(base, manifest); put(base, last.patch, patch);
    fs.rmSync(path.join(base, first.target)); fs.symlinkSync(path.join(base, last.target), path.join(base, first.target));
    assert.throws(() => verifyVendorProvenance(base, { apply: true }), /expected regular path/);
});

test('EVIDENCE vendor provenance rejects incomplete receipts and rechecks actual artifact bytes', t => {
    const base = fixture(t), report = verifyVendorProvenance(base);
    for (const mutate of [value => { value.status = 'blocked'; }, value => { value.offline = false; },
        value => { value.scope = 'upstream Git build verified'; }, value => { value.checks.pop(); },
        value => { value.archive.bytes = 0; }, value => { value.archive.integrity = 'sha512-invalid'; },
        value => { value.archive.members = 0; }, value => { value.archive.packageJsonSha256 = null; },
        value => { value.registryMetadata.gitHeadMatchesPin = false; }, value => { value.registryMetadata.projection = 'all metadata'; },
        value => { value.upstream.gitHead = null; }, value => { value.notice.status = null; },
        value => { value.notice.archiveNoticePaths.push('package/NOTICE'); },
        value => { value.notice.attribution.sha256 = '0'.repeat(64); }, value => { value.license.source = 'LICENSE'; },
        value => { value.files[0].pristineMatchesArchive = false; }, value => { value.files[0].patchReproduced = false; },
        value => { value.files[0].targetMatches = false; }, value => { value.files[0].archiveSha256 = '0'.repeat(64); },
        value => { value.files.pop(); }, value => { delete value.evidence['vendor/NOTICE']; },
        value => { value.evidence['vendor/LICENSE'] = null; }, value => { delete value.artifacts[manifest.archive.path]; }]) {
        const changed = clone(report); mutate(changed);
        assert.throws(() => validateVendorProvenanceReport(changed), /WGA_VENDOR_PROVENANCE/);
    }
    const fakeHash = clone(report); fakeHash.evidence['vendor/README.md'] = '0'.repeat(64);
    validateVendorProvenanceReport(fakeHash);
    assert.throws(() => validateVendorProvenanceArtifacts(fakeHash, base), /do not reproduce/);
    put(base, 'vendor/README.md', Buffer.concat([read(base, 'vendor/README.md'), Buffer.from('\nchanged\n')]));
    assert.throws(() => validateVendorProvenanceArtifacts(report, base), /do not reproduce/);
    fs.rmSync(path.join(base, manifest.archive.path));
    assert.throws(() => validateVendorProvenanceArtifacts(report, base), /missing.*tgz/);
});

test('DOC vendor setup reuses only verified cache and bounds explicit registry downloads before writing', async t => {
    const base = fixture(t), previousGet = https.get;
    t.after(() => { https.get = previousGet; });
    let requests = 0;
    https.get = () => { requests++; throw new Error('NETWORK_FORBIDDEN'); };
    assert.equal((await fetchUpstream(base)).status, 'passed');
    assert.equal(requests, 0);
    const original = read(base, manifest.archive.path);
    put(base, manifest.archive.path, 'corrupt');
    await assert.rejects(fetchUpstream(base), /archive SHA-256/);
    assert.equal(requests, 0);
    const projected = JSON.parse(read(root, manifest.registryMetadata.path));
    const metadata = Buffer.from(JSON.stringify({ name: projected.package, version: projected.version, gitHead: projected.gitHead,
        repository: projected.repository, license: projected.license, dist: { tarball: projected.tarball, integrity: projected.integrity }, unrelated: 'ignored' }));
    function mockResponses({ statusCode = 200, registry = metadata, archive = original } = {}) {
        https.get = (url, _options, callback) => {
            requests++; const request = new EventEmitter();
            request.setTimeout = () => request;
            request.destroy = error => request.emit('error', error);
            setImmediate(() => {
                assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org');
                const response = new EventEmitter(); response.statusCode = statusCode; response.resume = () => {};
                callback(response);
                response.emit('data', url.toString() === manifest.registryMetadata.url ? registry : archive);
                response.emit('end');
            });
            return request;
        };
    }
    function clear() { for (const file of [manifest.archive.path, manifest.registryMetadata.path]) fs.rmSync(path.join(base, file), { force: true }); }
    function emptyCache() { for (const file of [manifest.archive.path, manifest.registryMetadata.path]) assert.equal(fs.existsSync(path.join(base, file)), false); }
    clear(); mockResponses({ statusCode: 302 });
    await assert.rejects(fetchUpstream(base), /redirects are not followed/); emptyCache();
    mockResponses({ registry: Buffer.alloc(1024 * 1024 + 1) });
    await assert.rejects(fetchUpstream(base), /download limit/); emptyCache();
    mockResponses({ archive: Buffer.from('incorrect archive') });
    await assert.rejects(fetchUpstream(base), /archive SHA-256/); emptyCache();
    mockResponses(); requests = 0;
    assert.equal((await fetchUpstream(base)).status, 'passed');
    assert.equal(requests, 2);
    assert.deepEqual(read(base, manifest.archive.path), original);
    assert.deepEqual(read(base, manifest.registryMetadata.path), read(root, manifest.registryMetadata.path));
});
