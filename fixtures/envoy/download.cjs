'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pin = require('./binary.json');
async function main() {
    if (`${process.platform}-${process.arch}` !== pin.platform) throw new Error(`Pinned binary requires ${pin.platform}`);
    const target = path.join(__dirname, '.cache', `envoy-${pin.version}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const staging = target + '.partial';
    try {
        const response = await fetch(pin.url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`Binary download HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(staging, { mode: 0o600 }));
        const content = fs.readFileSync(staging);
        if (content.length !== pin.size || crypto.createHash('sha256').update(content).digest('hex') !== pin.sha256) throw new Error('Binary integrity mismatch');
        fs.chmodSync(staging, 0o700);
        fs.renameSync(staging, target);
        console.log(`Verified Envoy ${pin.version}: ${target}`);
    } finally {
        fs.rmSync(staging, { force: true });
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
