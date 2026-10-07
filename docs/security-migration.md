# Dependency security migration

The 2026-10-07 migration updates the locked SDK and local verification graphs.
Fresh `npm audit --json` checks, including development and optional packages,
reported zero known vulnerable packages in all six graphs. This is a dated
registry advisory result, not a guarantee that the adapter or its dependencies
are free of security defects.

## Exact pins

| Component | Previous pin | Current pin | Scope |
| --- | --- | --- | --- |
| Static-profile Datastore | 10.1.0 | 10.1.1 | Adapter and native SDK fixtures |
| Static-profile protobufjs | Root 7.4.0 plus nested 7.6.6 copies | 7.6.6 | SDK build inputs and deployed SDK bundle |
| Native grpc-js | 1.14.0 | 1.14.5 | Both native comparison fixtures |
| Wrangler | 4.136.3 | 4.148.0 | Deployment and local development tooling |
| Miniflare | 5.20260921.0-alpha | 5.20261006.0-alpha | Local Worker integration tooling |
| workerd | 1.20260921.1 | 1.20261006.1 | Locked local Worker runtime |
| Undici | 7.29.0 | 7.29.1 | Worker development tooling dependency |
| sharp | 0.35.4 | 0.35.5 | Explicit override in the Worker tooling fixture |

The modern SDK profile still pins Datastore 11.1.0, Firestore 9.2.0 and Secret
Manager 7.1.0. The static profile still pins Firestore 8.3.0 and Secret Manager
7.1.0. Miniflare remains an alpha release; it is local verification tooling,
and the runtime matrix is deliberately pinned rather than advertised as
support for arbitrary Miniflare versions.

`google-static-v1` advances from revision 4 to revision 5. Its manifest records
the new package, source, schema and code-generator hashes and the deduplicated
physical protobuf installation. Source checks, transform counts and schema
validation remain strict. The migration does not broaden supported dependency
versions. `google-modern-v1` remains revision 2.

The static bootstrap inventory now contains 14 physical schema inputs and 764
type occurrences; its earlier 18-input/891-type inventory included repeated
protobuf descriptor copies. The modern inventory remains 15 inputs and 1069
type occurrences. Each input's complete native and workerd type inventory is
still compared, including cold codec entrypoints and reflection variants.

The updated protobuf runtime preserves the independent application's
`9007199254740993` int64 roundtrip in workerd. The bootstrap gate checks it
against native execution and the unmodified application baseline, while
continuing to require that the SDK preset never rewrites application-owned
protobuf copies or enables runtime code generation.

## Advisory coverage and reachability

The protobuf upgrade covers the previously reported code-generation and
schema-derived-name issues, including
[GHSA-xq3m-2v4x-88gg](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg)
and [GHSA-f38q-mgvj-vph7](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-f38q-mgvj-vph7).
The build continues to accept only reviewed schema hashes. Trusted schemas
reduce exposure to schema-injection attacks but do not replace using a patched
dependency or validating wire data.

The native upgrade covers grpc-js advisories through 1.14.5, including
[unauthorized certificate exposure through getAuthContext](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j).
Both executable native baselines now use 1.14.5. The adapter's copied client
sources remain derived from the independently archived **1.14.0** artifact.
`vendor/UPSTREAM.json` preserves that provenance; `compatibility/candidates.json`
records the native baseline separately. Package auditing cannot assess copied
source files. The vulnerable native HTTP/2 server, TLS implementation and
compression filter are excluded from the adapter's runtime graph. Adapter
`getAuthContext()` returns `null`, and custom certificate and mTLS options are
rejected. Its Fetch server and bounded compression implementation are separate
code and retain their own error and malformed-input tests.

The tooling graph now resolves patched Undici 7.29.1, including the
[BalancedPool TLS option issue](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3),
and sharp 0.35.5, which supplies the patched librsvg dependency described in
[GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
Wrangler, Miniflare, Undici and sharp belong to the local tooling graph; they
are not production adapter dependencies. Node's built-in Fetch uses the Node
runtime's own bundled Undici, which this npm dependency migration does not
replace. Choose and maintain the Node runtime independently.

## Recorded checks

The before and after scans used the same six graph locations and the default
npm registry. Counts describe vulnerable **packages**, including parent packages
marked vulnerable through their dependencies, rather than unique advisories.

| Graph | Before | After | After audit exit code |
| --- | ---: | ---: | ---: |
| Repository root | 0 | 0 | 0 |
| `fixtures/google` | 2 | 0 | 0 |
| `fixtures/native` | 4 | 0 | 0 |
| `fixtures/worker` | 4 | 0 | 0 |
| `fixtures/modern` | 0 | 0 | 0 |
| `fixtures/modern-native` | 2 | 0 | 0 |

The fresh scan receipt is
`wga-security-audit-after-1791358750198516633.exit.json`, stored with private
local verification logs. Its six raw audit JSON files are kept outside the
checkout. To repeat the advisory checks after installing the locked fixtures:

```sh
npm audit --json
npm --prefix fixtures/google audit --json
npm --prefix fixtures/native audit --json
npm --prefix fixtures/worker audit --json
npm --prefix fixtures/modern audit --json
npm --prefix fixtures/modern-native audit --json
```

Use `npm run verify` to validate package installation, exact build profiles,
vendor patch reconstruction, native comparisons, workerd integrations and
the remaining local regression gates. Security scans and local gates do not
establish production IAM, credential renewal, sustained operating reliability
or complete native grpc-js behavior. Historical audit results in
[Evidence review](evidence-review.md) remain tied to their original source
revisions; they do not describe the migrated graph.
