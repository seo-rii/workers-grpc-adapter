'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('CI receipts include prebundle phase logs and exit statuses without following unrelated directories or links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-ci-prebundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs'), archive = path.join(root, 'receipts.tar.gz');
  const expected = {
    'wga-flat.log': 'existing log\n',
    'wga-flat.exit.json': '{"exitCode":0}\n',
    'wga-sveltekit-install.status': '{"exitCode":1}\n',
    'wga-hono-build.status': '{"exitCode":0}\n',
    'wga-prebundle-sdks/wga-prebundle-sdks-types.log': 'compiler diagnostic\n',
    'wga-prebundle-sdks/wga-prebundle-sdks-types.status.json': '{"exitCode":2}\n',
  };
  function put(file, bytes) {
    fs.mkdirSync(path.dirname(path.join(logs, file)), { recursive: true });
    fs.writeFileSync(path.join(logs, file), bytes);
  }
  for (const [file, bytes] of Object.entries(expected)) put(file, bytes);
  for (const file of ['private.log', 'wga-unrelated/wga-private.log',
    'wga-prebundle-sdks/private.log', 'wga-prebundle-sdks/.env', 'wga-prebundle-sdks/deep/wga-hidden.log']) put(file, 'excluded\n');
  fs.symlinkSync(path.join(logs, 'private.log'), path.join(logs, 'wga-linked.log'));
  fs.symlinkSync(path.join(logs, 'private.log'), path.join(logs, 'wga-prebundle-sdks/wga-prebundle-sdks-linked.log'));
  function collect() {
    execFileSync('python3', [path.resolve(__dirname, '../scripts/collect-ci-receipts.py'),
      '--root', root, '--log-dir', logs, '--output', archive], { timeout: 10000 });
    return JSON.parse(execFileSync('python3', ['-c',
      'import json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as t:\n'
      + '    assert all(m.isfile() for m in t.getmembers())\n'
      + '    print(json.dumps({m.name:t.extractfile(m).read().decode() for m in t.getmembers()}))\n', archive],
    { encoding: 'utf8', timeout: 10000 }));
  }
  assert.deepEqual(collect(), Object.fromEntries(Object.entries(expected).map(([file, bytes]) => [`logs/${file}`, bytes])));
  const nested = path.join(logs, 'wga-prebundle-sdks');
  fs.renameSync(nested, path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), nested, 'dir');
  assert.deepEqual(collect(), Object.fromEntries(Object.entries(expected).filter(([file]) => !file.includes('/'))
    .map(([file, bytes]) => [`logs/${file}`, bytes])));
});
