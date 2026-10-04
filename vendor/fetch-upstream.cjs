'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { MAX_ARCHIVE_BYTES, MAX_REGISTRY_BYTES, validateManifest, readRegular,
    registryBytes, validateRegistryReceipt, validateArchive } = require('./provenance.cjs');

function download(url, limit) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.port
        || parsed.username || parsed.password || parsed.hash) throw new Error('Only the pinned HTTPS npm registry is allowed');
    return new Promise((resolve, reject) => {
        const request = https.get(parsed, { headers: { accept: 'application/json' } }, response => {
            if (response.statusCode !== 200) {
                response.resume(); reject(new Error(`Registry request returned ${response.statusCode}; redirects are not followed`)); return;
            }
            const chunks = []; let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > limit) request.destroy(new Error('Registry response exceeded the pinned download limit'));
                else chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.setTimeout(30000, () => request.destroy(new Error('Registry download timed out')));
        request.on('error', reject);
    });
}
async function fetchUpstream(root) {
    const manifest = validateManifest(JSON.parse(readRegular(root, 'vendor/UPSTREAM.json', MAX_REGISTRY_BYTES)));
    const cache = path.join(root, '.cache/vendor');
    for (const relative of ['.cache', '.cache/vendor']) {
        const target = path.join(root, relative);
        try {
            const stat = fs.lstatSync(target);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Upstream cache must use regular directories');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const registryPath = path.join(root, manifest.registryMetadata.path), archivePath = path.join(root, manifest.archive.path);
    const registry = fs.existsSync(registryPath) ? readRegular(root, manifest.registryMetadata.path, MAX_REGISTRY_BYTES)
        : registryBytes(JSON.parse(await download(manifest.registryMetadata.url, MAX_REGISTRY_BYTES)));
    validateRegistryReceipt(manifest, registry);
    const archive = fs.existsSync(archivePath) ? readRegular(root, manifest.archive.path, MAX_ARCHIVE_BYTES)
        : await download(manifest.tarball, MAX_ARCHIVE_BYTES);
    validateArchive(manifest, archive);
    // Nothing is cached until both independent pins and archive contents pass.
    fs.mkdirSync(cache, { recursive: true });
    for (const [target, bytes] of [[registryPath, registry], [archivePath, archive]]) {
        if (fs.existsSync(target)) continue;
        const temporary = `${target}.${process.pid}.tmp`;
        try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, target); }
        finally { fs.rmSync(temporary, { force: true }); }
    }
    return { status: 'passed', package: manifest.package, version: manifest.version,
        archive: manifest.archive.path, registryMetadata: manifest.registryMetadata.path };
}
if (require.main === module) {
    if (process.argv.length !== 2) { console.error('Usage: node vendor/fetch-upstream.cjs'); process.exitCode = 1; }
    else fetchUpstream(path.resolve(__dirname, '..')).then(value => console.log(JSON.stringify(value)), error => {
        console.error(error.message); process.exitCode = 1;
    });
}
module.exports = { fetchUpstream };
