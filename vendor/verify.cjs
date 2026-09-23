'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('./UPSTREAM.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-upstream-'));
try {
    assert.equal(hash(fs.readFileSync(path.join(__dirname, 'LICENSE'))), manifest.licenseSha256, 'upstream license changed');
    for (const file of manifest.files) {
        const original = fs.readFileSync(path.join(root, file.source));
        assert.equal(hash(original), file.sha256, `${file.source}: pristine hash mismatch`);
        const target = path.join(scratch, file.target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, original);
        if (file.patch) {
            assert.equal(hash(fs.readFileSync(path.join(root, file.patch))), file.patchSha256, `${file.patch}: patch hash mismatch`);
            execFileSync('patch', ['--batch', '--forward', '-p1', '-i', path.join(root, file.patch)], { cwd: scratch, stdio: 'pipe' });
        }
        const patched = fs.readFileSync(target);
        assert.equal(hash(patched), file.patchedSha256, `${file.target}: reconstructed hash mismatch`);
        if (process.argv.includes('--apply')) fs.writeFileSync(path.join(root, file.target), patched);
        assert.deepEqual(fs.readFileSync(path.join(root, file.target)), patched, `${file.target}: source differs from recorded upstream patches`);
    }
    console.log(`Verified ${manifest.package}@${manifest.version}: ${manifest.files.length} source hashes and reproducible patches.`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
