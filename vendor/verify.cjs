'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyVendorProvenance } = require('./provenance.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'verification/vendor-provenance.json');
try {
    if (process.argv.slice(2).some(arg => arg !== '--apply') || process.argv.slice(2).length > 1)
        throw new Error('Usage: node vendor/verify.cjs [--apply]');
    // An interrupted or failed check must not leave an earlier passing receipt.
    fs.rmSync(output, { force: true });
    const report = verifyVendorProvenance(root, { apply: process.argv.includes('--apply') });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Verified ${report.upstream.package}@${report.upstream.version}: pinned archive, registry provenance, LICENSE/NOTICE, and ${report.files.length} reproducible client files (offline).`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
