'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const manifest = require('./toolchain.json');
const cache = path.join(__dirname, '.cache');

async function verify(file, pin) {
  if (!fs.existsSync(file)) return false;
  if (fs.statSync(file).size !== pin.size) return false;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === pin.sha256;
}

async function download(pin) {
  const target = path.join(cache, pin.filename);
  if (await verify(target, pin)) return target;
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.partial`;
  try {
    const response = await fetch(pin.url, {
      headers: { 'user-agent': 'workers-grpc-adapter-local-emulator-tests' },
      signal: AbortSignal.timeout(240000),
    });
    if (!response.ok || !response.body) throw new Error(`Emulator toolchain download HTTP ${response.status}`);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > pin.size ? new Error('Emulator toolchain artifact exceeds pinned size') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!await verify(temporary, pin)) throw new Error(`Emulator toolchain checksum mismatch: ${pin.filename}`);
    fs.renameSync(temporary, target);
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function ensureToolchain() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Pinned emulator fixture currently requires linux-x64; add an explicit verified Java runtime pin for this platform');
  }
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const [jar, archive] = await Promise.all([download(manifest.firestore), download(manifest.java)]);
  const java = path.join(cache, manifest.java.directory, 'bin/java');
  const marker = path.join(cache, manifest.java.directory, '.wga-archive-sha256');
  if (!fs.existsSync(java) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== manifest.java.sha256) {
    const temporary = fs.mkdtempSync(path.join(cache, '.java-'));
    try {
      const result = spawnSync('tar', ['-xzf', archive, '--no-same-owner', '-C', temporary], { encoding: 'utf8', timeout: 60000 });
      if (result.status !== 0) throw new Error(`Pinned Java extraction failed (${result.status})`);
      const extracted = path.join(temporary, manifest.java.directory);
      if (!fs.existsSync(path.join(extracted, 'bin/java'))) throw new Error('Pinned Java archive layout changed');
      fs.writeFileSync(path.join(extracted, '.wga-archive-sha256'), `${manifest.java.sha256}\n`, { mode: 0o600 });
      fs.rmSync(path.join(cache, manifest.java.directory), { recursive: true, force: true });
      fs.renameSync(extracted, path.join(cache, manifest.java.directory));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return { jar, java, manifest, cache };
}

module.exports = { ensureToolchain };
if (require.main === module) ensureToolchain().then(({ manifest }) => {
  console.log(JSON.stringify({ status: 'ready', emulator: manifest.firestore.version, java: manifest.java.version }));
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
