# Official local Google database emulators

This fixture pins the official Firestore emulator **1.22.0** and an isolated
Eclipse Temurin **21.0.12.1+1** JRE for Linux x64. Both artifacts have fixed URLs,
byte lengths and SHA-256 hashes in [toolchain.json](./toolchain.json). The emulator
pin comes from an immutable commit of Google's Firebase CLI download manifest.
Downloads and Java extraction stay in the ignored `.cache/` directory; global
Java, gcloud components, gcloud configuration and credentials are untouched.

```sh
node fixtures/emulators/download.cjs
node fixtures/emulators/launcher.cjs
```

The second command is a lifecycle smoke test: start both modes, reset their data,
and stop both processes. Run long tests with stdout and stderr redirected to a
restrictive background log, as required by this workspace's AGENTS.md.

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
