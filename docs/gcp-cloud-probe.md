# Temporary GCP and Cloudflare test

The corrected adapter passes the finite live suites in both modes. The [automatic-conversion diagnosis](cloudflare-conversion.md) explains the initial failures: a missing conversion opt-in and a separate Google content-type incompatibility.

This explicit deployment test creates isolated resources in a specified existing GCP project, invokes real Google SDKs from native Node and deployed Workers, then deletes only the resources it created. It does not change the selected project's existing databases, services, IAM bindings, API enablement, domains or images.

## Preparation and execution

Install the repository's pinned fixtures using [the testing guide](testing.md), authenticate `gcloud`, and supply `CF_TOKEN` or `CLOUDFLARE_API_TOKEN` in the process environment. No dotenv file is loaded automatically. The selected project needs the already-enabled Firestore, Datastore, Secret Manager, IAM and Cloud Run APIs, billing, and permission to create and delete the temporary resources.

```sh
# Local build/guard/SDK-request checks; does not provision cloud resources.
node scripts/test-gcp-probe.cjs
node scripts/test-gcp-cleanup.cjs

# Explicitly provisions temporary resources and removes them after testing.
node scripts/gcp-cloud-probe.cjs --deploy-temporary \
  --project=YOUR_PROJECT --region=asia-northeast3

# Adds a third Worker with auto_grpc_convert to compare identical bundles.
node scripts/gcp-cloud-probe.cjs --deploy-temporary \
  --compare-auto-grpc-convert --project=YOUR_PROJECT --region=asia-northeast3
```

Run the deployment command in the background with stdout/stderr directed to a restricted log. It takes several minutes. Avoid terminating it during cleanup. `SIGINT` and `SIGTERM` stop subsequent test work and retain cleanup; an uncatchable termination or provider outage requires checking the saved receipt.

Add `--catalog --inject-catalog-failure` to execute the remaining live catalog
matrix in the same run. This adds typed Datastore entities and ordered cursor
pages, count/sum/average, explicit rollback, actual missing-index and invalid-query
errors, Secret Manager payload comparison and filtered pagination, a restricted
principal, and caller cancellation. The same business modules run first with
native grpc-js and then in both deployed Worker modes.

Catalog mode creates a second isolated secret and one synthetic secret version.
Only that generated payload is accessed; it is compared inside the test and never
returned in reports. The runner attempts a short-lived token for its newly created
new service account using existing IAM permissions. By default it records a
per-case blocker if impersonation is unavailable and adds no IAM grants.

The optional `--grant-owned-token-creator` flag requires `--catalog` and separate
authorization for its IAM change. It grants the active `gcloud` principal only
`roles/iam.serviceAccountTokenCreator` on the service account created by this
run, after confirming its immutable UID and ownership description. The helper
requires an empty existing policy, writes with its original `etag`, and verifies
the exact returned policy and readback. A conflict or unexpected policy aborts
the run. It does not grant Google data-service permissions to the test account,
change project IAM or create a key. Deleting the owned service account removes
this temporary policy. The restricted-account RPC must still actually return
`PERMISSION_DENIED`; lack of direct grants is not proof of that behavior.

Failure injection deliberately preserves `INTENTIONAL_CATALOG_E2E_FAILURE` as the
primary error and exits nonzero after cleanup. Inspect
`verification/gcp-cloud-catalog.json` for all ten case outcomes and
`verification/gcp-cloud-probe.json` for the deletion receipts. A nonzero exit is
expected for this negative test; it is not a successful release gate. The original
catalog also requires a dedicated test project. Supply `--dedicated-project` only
when that is true; an isolated namespace in an existing project records successful
behavior separately from that unmet environment condition. Negative environment
gate controls are local evidence. The public native echo image cannot expose
backend generator cleanup after caller cancellation.

## Bounded deployed repetition and client recovery

Add `--soak-seconds=600` to the temporary deployment command to exercise both
Workers for a ten-minute observation window. The optional value accepts only
whole seconds from 60 through 600; malformed or duplicate values fail before
credentials are read or infrastructure is created. This reuses the same isolated
services and adds no resources or IAM grants itself. With `--catalog
--inject-catalog-failure`, the intentional cleanup test runs after this window.

The scheduler starts at most one HTTP request per second, with at most two in
flight globally and at most 600 dispatch slots. It alternates the two transport
modes. Every sixth request for each mode runs the real Secret Manager SDK's
`GetSecret` suite against the temporary secret. Other requests run a fixed batch
on one gRPC client: unary success, an expected status-3 error, server-stream
cancellation after one message, then another successful unary call. Targets and
credentials come only from the deployment's fixed bindings.

Each batch checks exact message, callback, error and status counts, and observes
adapter resources and call execution ownership before closing its client.
The scheduler checks the complete planned slot sequence, mode and route identity,
HTTP and gRPC outcomes, response fields, cleanup counters, dispatch spacing and
maximum concurrency. Skipped capacity slots, missing or duplicate results,
unexpected errors and interrupted windows cannot become successful reports.
Each request has a deadline of at most 30 seconds; dispatch stops at the window
boundary and outstanding requests have at most 30 more seconds to drain. A
signal stops new requests, aborts those in flight and retains normal resource
cleanup.

The main receipt records `soak`, `soakSourceHashes`, the source `gitCommit` and
the deployed `bundle` hash. Observations contain bounded protocol counts and timing, with no metadata,
payloads or tokens. Receipt schema version 2 also records failed HTTP requests'
stage (`fetch`, `response-body`, or an unclassified request callback), allowlisted
error names and transport codes. Response-body failures retain the HTTP status
already received. Error messages, stacks, hostnames and raw causes are discarded;
unknown codes become a fixed fallback. These diagnostics never retry or turn a
failed request into a successful observation. The driver and result validator have deterministic clock
tests; the exact deployable Worker also runs the recovery batch locally in
workerd before deployment. Normal CI exercises those local checks and never
enables the deployed repetition automatically.

This provides a finite observation of repeated deployed calls and recovery on the
same client after application errors and caller cancellation. It does not measure
the full deployed isolate heap, prove backend cancellation, exercise real service
outages or credential renewal, or establish multi-hour stream reliability.
`releaseEligible` remains `false` even when this bounded test passes.

The first ten-minute run, `wga-probe-20261004-6272d586` at source `edf2827`,
completed all 600 planned requests: 597 passed and three probe requests rejected
before returning a complete HTTP response. There were no skipped slots, request
timeouts or scheduler concurrency violations. The original receipt did not retain
the failure stage or cause, so these failures cannot be attributed to the adapter
or a specific network layer. The campaign correctly failed with
`DEPLOYED_SOAK_FAILED`; its per-run receipt is retained. All nine temporary
resources were deleted and the existing inventory was unchanged. Schema version
2 adds the diagnostics needed to investigate subsequent failures without exposing
credentials or treating this first run as a pass.

## Isolation

Every run generates a random `wga-probe-*` prefix and records inventory before creating resources:

| Resource | Isolation and purpose |
|---|---|
| Datastore-mode database | Named temporary database; never `(default)` |
| Firestore-native database | Separate named temporary database |
| Secret Manager secret | New metadata-only secret; catalog mode adds a second secret and one synthetic version |
| Service account | New runtime identity with no project-role grants or keys; optional approved caller token-mint permission on this account only |
| Native Cloud Run service | Private native gRPC echo/status server |
| Envoy Cloud Run service | Private gRPC-Web gateway to fixed Google APIs and the new native service |
| Two Cloudflare Workers | Separate Worker deployment for each transport mode; fixed authenticated test routes |

Each exact resource name must return `404` before creation. Google resources use create-only POST APIs, which reject collisions. The runner records creation operations, UIDs or ownership markers, waits for operations, and checks identity again before deletion. Supported delete APIs receive the current `etag`; service accounts are deleted by immutable ID. Ambiguous creation or unresolved deletion is reported as a failure rather than silently treated as clean.

For Cloudflare, each upload carries the run tag and records its immutable version ID from pinned Wrangler's structured output. Cleanup verifies the active deployment, its single 100% version and that version's ownership tag before deletion. A replacement, split deployment, missing tag or unacknowledged upload fails cleanup; an ambiguous upload is not accepted as deleted merely because a lookup returns `404`. Local tests cover these paths without cloud access. Cloudflare's name-based create/delete operations are not conditional atomic operations, so a concurrent external mutation between the final identity check and mutation remains a limitation. The historical live results below predate this added ownership guard.

Database deletion can remain asynchronous after a resource starts returning `404`. The runner submits the two independent database deletions sequentially, then waits for both operation completions before accepting final absence. Local cleanup tests also verify that a replaced UID is never deleted and an unfinished operation cannot be treated as complete.

Cloud Run uses immutable public image digests, min instances `0`, max instances `1`, concurrency `4` and a 30-second request timeout. No build job, source upload or Artifact Registry repository/image is created. Both services require Cloud Run IAM authentication; no anonymous invoker grant is added. See the [upstream fixture guide](../fixtures/cloud-run-probe/README.md).

Existing-resource inventory is compared afterward: service identities/generations, database identities/configuration, secret metadata, service accounts and artifact repositories. A mismatch or failed final inventory is a failed verification, not permission to revert unrelated changes.

## Credentials and transport

The runner captures short-lived `gcloud auth print-access-token` and `gcloud auth print-identity-token` output in memory. No service-account private key or refresh token is created or uploaded. Worker credentials use secret bindings; the restricted upload file is removed immediately after deployment and again during final cleanup. Deleting the Workers removes their bindings. Tokens are not logged or included in reports.

Google SDK calls preserve OAuth `Authorization`. Gateway calls additionally carry a Cloud Run ID token in `X-Serverless-Authorization`; Envoy removes that header before sending the RPC to Google. This follows [Cloud Run's separate-header authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service#acquire_and_configure_the_id_token). Direct Cloudflare mode does not attach the gateway token to Google APIs.

SDK fixtures require explicit live/write flags, the project binding, named database bindings and the exact temporary secret name. Request bodies cannot select targets or credentials. CRUD and transaction suites reuse the existing shared source files; a native grpc-js consumer runs the same files. The default Secret Manager test reads metadata only; catalog mode accesses only its synthetic version.

Database SDKs receive the project ID in `WGA_GCP_PROJECT`. Secret Manager uses the separate numeric `WGA_GCP_PROJECT_NUMBER` for its canonical resource name. These identifiers are not interchangeable for database data-plane calls. All five native Google suites must pass before dependent Workers are deployed.

The runner uses separate Workers per mode and statically imports the shared SDK modules for a controlled deployment comparison. The adapter now supports mixed-mode clients in one isolate and bundled SDK imports during requests; [local regression gates](testing.md) exercise those newer behaviors. The earlier cloud runs used the separate-deployment workaround for the former GAX cache and Datastore initialization limitations.

## Evidence and cleanup

`verification/gcp-cloud-probe.json` and a per-run `.wga-build/gcp-cloud-probe/*/receipt.json` contain resource names, creation/deletion receipts, existing-resource comparisons, native controls, SDK assertions and the deployed bundle hash. Both locations are ignored by Git. A cleanup failure exits nonzero and identifies the exact remaining resource; do not delete by a broad name prefix or touch pre-existing resources.

Before running RPCs, every Worker must return an authenticated, mode-matching JSON response from `/gcp/{mode}/ready`. The runner polls for at most two minutes, with a five-second request timeout. An unauthenticated 404 or a deployment-propagation 404 is not readiness evidence. This protected route makes no Google calls and confirms deployment availability only; the native controls and SDK suites separately verify credentials, configuration and transport behavior.

Successful fallback calls establish Worker → private Envoy → real Google API behavior. Automatic conversion additionally requires successful calls to the controlled native gRPC origin, with matching native positive and direct gRPC-Web negative controls. An existing gRPC-Web service cannot prove Cloudflare translation. Public-service success, SDK initialization and local emulator results remain separate evidence categories. Load, failure recovery and full grpc-js API compatibility are outside this finite smoke test; `releaseEligible` remains `false`.

## Complete catalog campaign: 2026-10-04

Run `wga-probe-20261004-28c804b3` executed the expanded shared business modules
with native grpc-js and both deployed Worker modes. CRUD, typed int64/bytes/date
entities, ordered cursor pages, aggregation, explicit rollback, missing-index
and invalid-query errors, and Secret Manager payload/list checks passed. Unary,
server streaming, non-OK status and caller cancellation also passed in both
Worker modes.

The separate role-free principal could not obtain a token: IAM Credentials
returned HTTP 403. That case was recorded as blocked, with no new permission
grants. This existing-project run also does not meet the original dedicated
project invariant or expose native backend generator cleanup.

The injected primary failure was retained and the runner exited `1`, as intended
for this negative test. All nine owned resources were verified absent, both
asynchronous database deletions completed, and the existing inventory was
unchanged. The per-run receipt is retained independently from subsequent runs;
current results are in the two verification receipts described above. Ordinary
CI still performs no cloud deployment.

## Earlier regression: 2026-09-30

Run `wga-probe-20260930-cf08e0d1` tested source commit
[`5e6f87c`](https://github.com/seo-rii/workers-grpc-adapter/commit/5e6f87c2cad3d477d79fa4d7b48c50bfe00de421)
after the Firestore read and Datastore transaction regression gates were added.
The deployed bundle SHA-256 was
`3347803bd7999bebd74c7e7914401af749251c64eec53d30f0af5bb259663974`.
Both Workers used only `nodejs_compat`; authenticated readiness succeeded on
the first attempt for each mode.

| Check | Result |
|---|---|
| Native grpc-js Google baseline | All five suites passed |
| Worker automatic conversion → Google APIs | All five suites passed |
| Worker fallback → private Envoy → Google APIs | All five suites passed |
| Native and both Worker modes → private native origin | Unary, ten-message stream and exact status-3 error passed |
| Worker request without conversion → native origin | Expected HTTP 502/plain-text negative control |
| Direct HTTP/2 gRPC-Web → native origin | Expected HTTP 502/plain-text negative control |

The Google suites exercise Datastore and Firestore CRUD/query and transactions,
plus Secret Manager metadata `GetSecret`. The new local fault matrices remain
separate evidence: this live run does not reproduce their injected connection
resets, deadlines or SDK retry sequences. It also does not establish production
token renewal, quotas, transaction contention, sustained load or deployed
request streaming. `releaseEligible` remains `false`.

All eight created resources were deleted. Both database deletion operations
completed, and every final resource lookup returned `404`. The existing GCP
inventory and recorded identity/configuration fields were unchanged: 81 Cloud
Run services, three databases, 34 secrets, 31 service accounts and six artifact
repositories. The temporary Worker secret upload file was removed. The runner
exited `0` with status `passed`; the per-run receipt records both
`allCreatedResourcesDeleted: true` and `existingResourcesUnchanged: true`.

## Corrected results: 2026-09-26

Run `wga-probe-20260926-6c3b0f09` deployed the corrected adapter with bundle SHA-256 `5dbcd1c3a4597c9c2d19aced212e70301fdf7e54c8491873f2a9def72f16c67c`. Both Workers used only `nodejs_compat`, verified from deployed settings. The adapter explicitly sends `cf.grpcWeb: "convert"` with bare `application/grpc-web` for direct calls, and `passthrough` with `application/grpc-web+proto` for the gateway. It does not require a Worker-wide conversion flag.

| Check | Result |
|---|---|
| Native grpc-js Google baseline | All five suites passed |
| Worker automatic conversion → Google APIs | All five suites passed |
| Worker fallback → private Envoy → Google APIs | All five suites passed |
| Native gRPC → private Cloud Run | Unary, ten-message stream and exact status-3 error passed |
| Worker automatic conversion → private native origin | The same three checks passed |
| Worker fallback → private Envoy → native origin | The same three checks passed |
| Raw Worker request without conversion → native origin | HTTP 502/plain text, the expected negative control |
| Direct HTTP/2 gRPC-Web → native origin | HTTP 502/plain text, the expected negative control |

The five suites cover Datastore and Firestore CRUD/query and transactions, plus Secret Manager metadata `GetSecret`. Native and Worker consumers execute the same shared business modules. No secret payload or version is accessed. This run used separate Workers to avoid the then-unresolved GAX constructor cache issue. The tokens are short-lived user credentials; this is finite integration evidence, not a production authentication or load certification.

Authenticated readiness succeeded on the first fallback attempt and second automatic-mode attempt. An earlier attempt, `wga-probe-20260926-c1e397e2`, lacked that per-Worker check and received non-JSON 404s from the automatic Worker; those responses are excluded as adapter evidence. Its native/fallback suites passed, all eight resources were deleted, and the existing inventory was unchanged.

All eight resources from the corrected run were deleted. Both database deletion operations completed and every final resource lookup returned `404`. The existing GCP inventory and recorded identity/configuration fields matched before and after: 82 Cloud Run services, three databases, 34 secrets, 31 service accounts and six artifact repositories. The secret upload file was removed. The runner exited `0` with status `passed`; `releaseEligible` remains `false`.

## Initial results: 2026-09-24

Run `wga-probe-20260924-665a7940` tested the pinned Datastore 10.1.0, Firestore 8.3.0 and Secret Manager 7.1.0 SDKs against newly created Google resources. Native Node used grpc-js 1.14.0. The deployed Worker bundle SHA-256 was `eec89a6163ff61b4438ec1b3ff0191b360fabd3f229d828dc937f44e63339c07`.

| Check | Observed result |
|---|---|
| Native gRPC → private Cloud Run | Unary echo, 10-message stream and exact status-3 error/reason passed |
| Direct HTTP/2 gRPC-Web → same native origin | HTTP 502, plain text, no valid gRPC-Web response |
| Worker `grpc-web` → private Envoy → native origin | All three echo/stream/error checks passed; raw response HTTP 200 with `application/grpc-web+proto` |
| Native Google SDK baseline | All five suites passed |
| Worker `grpc-web` → private Envoy → Google APIs | All five suites passed |
| Worker `cloudflare` → native origin | All three checks failed with status 14 / `WGA_NOT_GRPC_WEB`; raw response HTTP 502, plain text |
| Worker `cloudflare` → Google APIs | All five suites failed with code 12, including nested aggregate causes |

The five Google suites cover Datastore CRUD/query and transactions, Firestore CRUD/query and transactions, and Secret Manager `GetSecret` metadata. Test records were removed by suite cleanup; no Secret Manager payload or version was created or accessed. Native and Worker consumers used the same shared business source files.

These initial results established a working gateway fallback for this finite set of real Google operations. Automatic conversion failed in that deployment. At the time, this run alone did not identify the cause; the [follow-up diagnosis](cloudflare-conversion.md) established the missing conversion opt-in and the `+proto` incompatibility. Code 12 alone did not identify the upstream cause; separate raw Google response controls were needed.

Both deployments used short-lived user tokens and separate Workers per mode, with SDK modules imported during startup. This test does not establish credential refresh, a service-account or workload-identity lifecycle, mixed-mode GAX clients in one isolate, dynamic SDK loading during requests, sustained load or recovery after failures. The project remains experimental.

All eight resources created in this run were deleted: both database deletion operations completed, and each resource's final lookup returned `404`. The existing inventory matched before and after: 81 Cloud Run services, three databases, 34 secrets, 31 service accounts and six artifact repositories, including the selected identity/configuration fields. The earlier setup attempt also deleted all eight of its resources before this run began. Its database calls had incorrectly used the numeric project number; the corrected run uses the project ID and requires a passing native baseline before Worker deployment.

The cloud runner exited `0` after collecting results and completing cleanup, with report status `completed-with-cloudflare-mode-failure`. That exit code is not an all-modes success or release approval. Both runs' per-run receipts retain deletion evidence; no test service remains deployed.

The separate final local gate passed 168 tests, all 80 official-emulator results, exact Worker bundle/request checks and cleanup failure simulations. `verification/report.json` describes that local run only; its disabled live-execution flags do not summarize this explicit cloud run.
