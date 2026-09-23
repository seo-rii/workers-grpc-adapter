# Google database emulator fixtures

This fixture pins the official Firestore emulator **1.22.0** and an isolated
Eclipse Temurin **21.0.12.1+1** JRE for Linux x64. Both artifacts have fixed URLs,
byte lengths and SHA-256 hashes in [toolchain.json](./toolchain.json). The emulator
pin comes from an immutable commit of Google's Firebase CLI download manifest.
Downloads and Java extraction stay in the ignored `.cache/` directory; global
Java, gcloud components, gcloud configuration and credentials are untouched.

```sh
npm ci
npm run fixtures:install
node fixtures/emulators/download.cjs
node fixtures/emulators/launcher.cjs
node fixtures/emulators/lifecycle.cjs
```

Run these commands from the repository root. `launcher.cjs` starts both modes,
resets their data and stops both processes. `lifecycle.cjs` verifies shutdown after
SIGINT/SIGTERM, shutdown during startup and repeated `stop()` calls. It writes
`verification/emulator-lifecycle.json`.

To run the SDK compatibility scenarios through real Envoy with native grpc-js,
the Node adapter and workerd:

```sh
node fixtures/envoy/download.cjs
node scripts/google-emulator-test.cjs
```

Results are written to `verification/google-emulators.json`. `npm run verify`
includes both the SDK scenarios and lifecycle checks after the pinned artifacts
have been downloaded. The [CI workflow](../../.github/workflows/local.yml)
downloads them automatically and retains reports and process logs as an artifact.

```js
const { startEmulators } = require('./fixtures/emulators/launcher.cjs');
const emulators = await startEmulators({
  projectId: 'demo-wga-local',
  modes: ['firestore', 'datastore'],
});
try {
  // Configure native gRPC clients to use these insecure loopback endpoints.
  console.log(emulators.firestore.endpoint, emulators.datastore.endpoint);
  await emulators.firestore.reset();
  await emulators.datastore.reset();
  // Run local SDK scenarios here; attach a grpc-web bridge for the adapter.
} finally {
  await emulators.stop();
}
// JSON-safe metadata includes each PID, log path, final exit code and signal.
console.log(emulators.metadata);
```

Each call starts independent Java processes on dynamically allocated
`127.0.0.1` ports with in-memory data, a temporary working directory and a
synthetic `demo-` project. The launcher rejects other project IDs. It passes no
credentials or inherited Java options to the processes. Logs are created under
`~/logs` with mode `0600` before spawning, and each process has an
`.exit.json` status file. `stop()` is idempotent, waits for termination and
removes the working directory; callers must await it in `finally`.
The launcher also stops and records its Java children when the parent receives
SIGINT or SIGTERM, including signals received during startup.
Downloaded artifacts stay cached for subsequent runs. Initial downloads require
network access; database requests use local endpoints only.

The executable is the same official Firestore emulator used by gcloud and the
Firebase Local Emulator Suite. It is launched directly with the verified Java
runtime and Google's `CloudFirestore` entry point. Firestore uses
`--database-mode=firestore-native`; Datastore uses `--database-mode=datastore-mode`,
the mode [Google recommends for modern Datastore applications](https://docs.cloud.google.com/datastore/docs/emulator).
The legacy Cloud Datastore emulator is not used.

An emulator pass establishes local SDK/protobuf/transport interoperability and
the specific tested database behavior. It does not establish production IAM,
quotas, composite-index requirements or full concurrency semantics. The official
[Firestore emulator documentation](https://docs.cloud.google.com/firestore/native/docs/emulator)
describes simplified transaction locking and limits/index differences. The
fixture does not emulate Secret Manager; its controlled-service tests remain
separate from these official database emulator tests.
