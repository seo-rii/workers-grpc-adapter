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

The existing-project runner accepts `--worker-http=fetch` (the default) or
`--worker-http=fresh`. The latter uses Node HTTPS with a new TLS connection for
each caller POST to a deployed Worker. It does not retry failed POSTs or follow
redirects, limits response bodies to 256 KiB, and preserves cancellation and
separate header/body error reporting. `workerHttp` records the selected caller
transport and Node version in the receipt. The helper is included in source
provenance. Invalid or repeated options fail before credentials or deployment.

Use the fresh option as a caller-connection control when investigating pooled
connection resets. Its TLS cost changes caller latency. It does not change
Worker-to-backend Fetch, SDK retries or adapter behavior, and a successful run
does not demonstrate production connection-pool reliability. Provider API calls
still use Fetch. The dedicated-project wrapper does not accept this control.
See the [controlled reset diagnosis](caller-connection-resets.md) for the local
and deployed comparisons, their failed inventory gate and the remaining limits
on attributing the original SDK-run errors.

Add `--catalog --inject-catalog-failure` to execute the remaining live catalog
matrix in the same run. This adds typed Datastore entities and ordered cursor
pages, count/sum/average, explicit rollback, actual missing-index and invalid-query
errors, Secret Manager payload comparison and filtered pagination, a restricted
principal, and caller cancellation. The same business modules run first with
native grpc-js and then in both deployed Worker modes.

Catalog mode creates a second isolated secret and one synthetic secret version.
Only that generated payload is accessed; it is compared inside the test and never
returned in reports. The runner attempts a short-lived token for its newly created
service account using existing IAM permissions. By default it records a
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

After an explicitly requested and verified grant, the runner allows at most five
minutes for IAM propagation, retrying only HTTP 403 token-mint reads at ten-second
intervals. It never retries the policy write. Other errors fail that mint attempt;
without the grant flag, it attempts minting only once. The public receipt includes
attempt counts and fixed reason codes, while credentials remain private.
[IAM propagation can exceed this finite window](https://docs.cloud.google.com/iam/docs/access-change-propagation),
so a timeout is a failed or blocked probe, not proof of an invalid policy.

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

## Optional dedicated project lifecycle

The separate `scripts/gcp-dedicated-probe.cjs` wrapper can create a new random
project, link the sole visible open billing account and enable the fixed APIs
needed by this probe. It requires both `--create-dedicated-project` and
`--link-unique-billing-account`. These flags authorize additional infrastructure
changes; use them only with permission to create and bill that project. This
wrapper rejects `--project`, so it cannot repurpose an existing project.

It accepts the same `--region`, `--catalog`, `--grant-owned-token-creator`,
`--verify-auth-renewal`, `--soak-seconds`, `--soak-burst` and
`--inject-catalog-failure` options described here. CF credentials and `gcloud`
authentication are still required. Run it in a restricted background log, as
with the existing-project runner. Normal CI only exercises simulated provider
responses and never invokes this opt-in command.

Before provisioning, it saves a private plan under `.wga-build/gcp-dedicated/`.
The helper requires an absent project ID, an acknowledged creation operation,
the resulting immutable project number and exact ownership labels. It checks
identity again before billing, API enablement and deletion. A collision, denied
lookup, ambiguous response or multiple visible billing accounts stops setup.
An uncertain creation preserves the plan and any acknowledged operation name
for manual recovery; it does not infer ownership from a later matching lookup.

The child probe waits for its per-resource cleanup before the wrapper unlinks
billing and requests deletion of the owned project, including on test failure.
The private receipt records child and project cleanup separately: shutting down
GCP cannot remove a Cloudflare Worker. A missing child receipt or unresolved
resource cleanup keeps the run failed even when project shutdown succeeds.
The final project state is `DELETE_REQUESTED`, not an immediate 404. Google
retains a deleted project during its restoration period; see
[project shutdown](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects#shutting_down_projects).
Signals stop subsequent work and let cleanup finish. An uncatchable process
termination or provider outage still requires inspecting the saved receipts.

## Optional credential renewal

Add `--catalog --verify-auth-renewal` to verify an impersonated credential's
natural expiry and renewal in native grpc-js and both deployed Worker modes.
This flag creates no permission grant by itself. Minting must already be allowed
on the new owned account, or the separately authorized
`--grant-owned-token-creator` flag must be supplied. Missing permission aborts
this requested check before deploying services; cleanup still removes the account.

```sh
# Use the IAM flag only with authorization for the temporary account policy.
node scripts/gcp-cloud-probe.cjs --deploy-temporary --catalog \
  --verify-auth-renewal --grant-owned-token-creator \
  --project=YOUR_PROJECT --region=asia-northeast3
```

Each mode creates one Secret Manager SDK client and one `Impersonated` auth
client. The fixture requests a 60-second credential through
[IAM Credentials](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken),
using the new service account's immutable UID. It issues an initial `GetSecret`,
a cached call, waits until the returned expiration plus 250 milliseconds, then
issues a renewed and another cached call. It never edits the clock or overwrites
the SDK's credentials to force expiry. A one-second eager-refresh threshold makes
cache reuse observable; the normal library default is unsuitable for this short
test token. Unexpected lifetime, extra mints or automatic request retries fail
the check.

All four RPCs must return `PERMISSION_DENIED`, because this account receives no
data-service grants. In each Worker, the fixture compares the bearer in the
actual adapter Fetch with the latest minted credential. The native control
observes auth-client request headers; its receipt labels this narrower boundary.
The required sequence is two mints and four RPC authorizations with generations
`[1, 1, 2, 2]`. Each mode is bounded to two minutes; all three run concurrently.

`authRenewal` and `authRenewalSourceHashes` in the main receipt record this
separate result. Strict validation checks the complete timing sequence, expected
status and counts, real expiration wait and SDK close. Unknown fields or invalid
remote bodies are rejected without being copied into the report. Tokens, token
hashes, headers, payloads and target identifiers are excluded from renewal receipts.
The source is a short-lived user access token; no refresh token or service-account
key is uploaded. This check does not prove source-credential renewal, federation,
successful data access after renewal, or long-term reliability.

The ordinary local `test-gcp-probe.cjs` gate runs the exact deployable bundle in
workerd with real SDK/auth code and a controlled IAM/data peer. Both modes wait
through actual 60-second expiry. Initial mint failures, invalid lifetimes,
incorrect gRPC status, renewal denial and reused tokens are negative controls.
Route, opt-in and target guards must make no outbound requests. Synthetic peer
tokens are checked for leaks in returned receipts. CI runs this local gate without
Google credentials or external calls; it does not establish that a real IAM
service accepted the requested lifetime, nor prove request-disconnect propagation.

The [source-credential regressions](../test/gcp-auth-renewal-sources.test.cjs)
also attach OAuth refresh-token, external-account STS and signed service-account
JWT sources to the same pinned `Impersonated` client. Each source exchanges twice
before two target mints, reuses cached credentials, and propagates a later source
failure without minting or reusing an expired target token. Fetch and Node HTTP
requests are blocked by the test; endpoint responses are synthetic and expiration
is forced locally. This covers the source/target refresh interaction for CI.

### Live renewal and permission results: 2026-10-05 (KST)

Run `wga-probe-20261004-433e2bc6` tested source
[`c110c6c`](https://github.com/seo-rii/workers-grpc-adapter/commit/c110c6cf21498b19d7aa1af72f5634319b3b54d4)
with the explicitly approved caller TokenCreator grant on its newly created
service account. Policy write and readback confirmed one role and one member;
no service-account key or project IAM change was made. The initial restricted
token became available on the ninth mint attempt after 80.6 seconds, within the
bounded policy-propagation wait. Only token reads were retried.

Actual IAM Credentials accepted the requested 60-second lifetime. All three
paths reused the same SDK/auth client pair through initial, cached, renewed and
recached calls. Each issued exactly two credentials and four `GetSecret` RPCs,
with authorization generations `[1, 1, 2, 2]`. Each second mint began after the
first credential's real expiration plus 250 milliseconds. Native, gateway and
automatic-mode runs completed in 60.859, 60.852 and 60.715 seconds respectively.

All twelve RPCs returned the expected `PERMISSION_DENIED (7)`: the temporary
account received no data-service role grants. Workers compared the minted bearer
at the actual transport Fetch boundary; native Node observed auth-client request
headers. The separate restricted-principal catalog case also passed with native
grpc-js and both deployed modes, removing that earlier token-availability blocker.
These results do not establish source user-token renewal, federation, service-account
JWT exchange, successful data access after renewal, or a complete production IAM
policy matrix.

The same run passed the finite SDK/catalog suites and all 600 requests in its
ten-minute repetition window. Each Worker mode completed 250 client-recovery
batches and 50 SDK reads, with no failed or skipped observations. Renewal receipts,
source hashes and the retained deployment bundle were checked independently of
the repetition result.

After those checks, the runner retained `INTENTIONAL_CATALOG_E2E_FAILURE` and
exited `1`, as required by the cleanup negative test. All nine owned resources
were deleted with acknowledged delete responses and final `404` lookups; both
database deletion operations completed. The temporary secret-upload file was
absent. Existing inventory was unchanged: 81 Cloud Run services, three databases,
34 secrets, 31 service accounts and six artifact repositories. The service-account
deletion also removed the temporary caller grant's target.

The earlier attempt `wga-probe-20261004-c2955ef1` stopped in IAM preparation with
`OWNED_IAM_API_FAILED`. Its sole created service account was deleted and existing
inventory remained unchanged. That original error did not retain a request stage
or HTTP status, so its cause is unconfirmed. The follow-up records fixed IAM
stages, HTTP statuses and whether a write was attempted, without raw API bodies,
principal identifiers or tokens; it does not retry policy writes.

The run used an isolated namespace in an existing project, so the original
dedicated-project requirement remains unmet. Backend generator cleanup and
long-running reliability also remain separate checks. The receipt therefore
keeps `releaseEligible: false` and `certificationPassed: false`, while recording
the successful behavior and verified deletion separately.

## nadd-al deployment and burst result: 2026-10-05 (KST)

Run `wga-probe-20261005-585517a2` used the approved existing `nadd-al` project
and source [`fba4b8a`](https://github.com/seo-rii/workers-grpc-adapter/commit/fba4b8a7fddcc38840dab240d07adbb79e78c80c).
Before deployment, the missing Cloud Run, Datastore, Secret Manager, IAM,
IAM Credentials, Artifact Registry and Service Usage APIs were enabled. Those
prerequisites remain enabled. The runner then recorded existing resources and
created two Cloud Run services, two named databases, two secrets, one service
account and two Workers with random run names.

Native and both Worker modes passed the finite SDK/catalog suites, including
CRUD, typed cursor queries, aggregation, transactions/rollback, real query errors,
restricted-principal denial and Secret Manager payload/list operations. Actual
60-second impersonated-token renewal also passed in all three modes: two mints,
four authorizations, generations `[1, 1, 2, 2]` and four expected status-7 RPCs
per mode. Workers checked the bearer at transport Fetch; native checked auth-client
request headers. This does not establish renewal of the source user credential or
successful data access after renewal.

The ten-minute `--soak-burst=4` check completed every planned request, but failed
its strict success gate:

| Mode | Completed | Passed | Failed | Recovery passed | SDK read passed |
| --- | ---: | ---: | ---: | ---: | ---: |
| grpc-web gateway | 300 | 297 | 3 | 248 | 49 |
| Cloudflare automatic conversion | 300 | 296 | 4 | 247 | 49 |
| Total | 600 | 593 | 7 | 495 | 98 |

All seven failures were caller Fetch `TypeError / ECONNRESET`, before any HTTP
status was received, in 5.37–38.99 milliseconds. They occurred at zero-based slots
60, 465–467, 564–565 and 567. There were no missed slots, request timeouts,
interruptions or pending requests. The orchestrator observed four pending requests
at once; its final in-flight and timeout counters were zero. This counter does
not establish concurrent execution inside a Worker or backend. Across all 600
attempts, latency was p50 235.56 ms, p95 370.68 ms, p99 849.75 ms and maximum
1713.49 ms, including failed attempts.

Basic network access, DNS resolution, a fresh authenticated GCP read and Node
connectivity to the Cloudflare API succeeded during cleanup. These checks do not
identify the source of the resets; local transport, edge and backend attribution
remain unresolved. No retry was added to mask the failed observations. The
primary error was `DEPLOYED_SOAK_FAILED`, exit `1`. The requested intentional
failure injection was not reached, so `CLOUD-009` remains unexecuted in this run.

Cleanup still completed: all nine resources had acknowledged `DELETE 200`
responses and final `404` lookups, with both database deletion operations settled.
The owned service-account deletion removed the temporary caller TokenCreator
grant's target. GCP inventory matched exactly before and after: zero Cloud Run
services, one existing database, zero secrets, one existing service account and
zero artifact repositories. A separate supervisor compared the existing
Cloudflare Worker metadata inventory: 15 before, 15 after, exact equality.

The source hashes for catalog, renewal and repetition each matched the same
18-file manifest. The retained bundle SHA-256 is
`fd8ded8f81d7a1adf47edc3f4d659a568319f42e47f70ca563cc9379e2f38be6`.
The live receipt retains eight passed live catalog behaviors and one passed local
environment-policy check; failure injection is blocked. Existing-project use and
the failed repetition check keep this separate from release certification.

## Fresh HTTPS caller rerun: 2026-10-05 (KST)

Run `wga-probe-20261005-5ba39f15` repeated the same approved existing-project
catalog, natural credential renewal, 600-second burst and failure injection
with source [`8725b42`](https://github.com/seo-rii/workers-grpc-adapter/commit/8725b4297535269c87962228265c0ce5c238fe73)
and `--worker-http=fresh`. The Node `v24.1.0` caller used a new HTTPS/TLS
connection per POST, with no failed-POST retry or transport fallback. Worker
adapter Fetch behavior was unchanged. The [caller reset diagnosis](caller-connection-resets.md)
records the separate controlled comparison and its attribution limits.

Native and both deployed modes passed the finite SDK/catalog suites. The strict
repetition validator also passed the complete ten-minute window:

| Mode | Completed | Passed | Failed | Recovery passed | SDK read passed |
| --- | ---: | ---: | ---: | ---: | ---: |
| grpc-web gateway | 300 | 300 | 0 | 250 | 50 |
| Cloudflare automatic conversion | 300 | 300 | 0 | 250 | 50 |
| Total | 600 | 600 | 0 | 500 | 100 |

Missed, interrupted, pending and timed-out requests were zero. The orchestrator
observed four pending requests and drained to zero calls and timeout handles.
Its counter includes admission before HTTP transmission and does not prove
Worker/backend concurrency or overlap in every burst. Caller latency was p50
233.23 ms, p95 515.89 ms, p99 813.12 ms and maximum 1005.48 ms. These measurements
include fresh TLS connections and are not a pooled-transport performance comparison.

Actual 60-second target-token expiry and renewal passed in all three paths:
two mints and four expected permission-denied RPCs per reused SDK/auth client,
with authorization generations `[1, 1, 2, 2]`. Native, gateway and automatic
checks took 60.636, 61.925 and 62.408 seconds respectively. This still does not
establish source-credential renewal or successful data access after renewal.

The requested failure injection was reached. The primary error remained
`INTENTIONAL_CATALOG_E2E_FAILURE`, and the runner exited `1` after cleanup in
1363.51 seconds. This is the expected negative-test outcome, rather than an
all-success process exit. All nine resources had acknowledged `DELETE 200`
responses and verified absence; both database deletion operations settled.
Eight deletion rows recorded final `404`. The service-account row retained an
earlier `lookupStatus: 200` when its later polling branch verified absence;
a separate read-only lookup by immutable UID returned `404`. The account's
temporary TokenCreator policy target was removed.

Existing GCP inventory matched exactly: zero Cloud Run services, one existing
database, zero secrets, one existing service account and zero artifact repositories.
The supervisor's independent Cloudflare comparison also matched exactly: 15
existing Workers before and after. No project or billing change was made in
this rerun. Required APIs enabled for the earlier run remain enabled.

Catalog, renewal and repetition source hashes matched the same 19-file manifest,
including the new caller helper. The retained bundle SHA-256 is
`ddda9f995b7b5b68e9df82c2c7f96e2e336ee68624f7c1b12872e460110bf72f`.
All ten catalog behaviors passed, including the local environment-policy check
and live failure cleanup. Existing-project use still leaves the original
dedicated-project condition unmet. The receipt therefore retains
`releaseEligible: false` and `certificationPassed: false`.

This finite fresh-caller result does not erase the earlier seven failures,
confirm each one's cause, or establish default pooled Fetch or long-term
production reliability.

## Bounded deployed repetition and client recovery

Add `--soak-seconds=600` to the temporary deployment command to exercise both
Workers for a ten-minute observation window. The optional value accepts only
whole seconds from 60 through 600; malformed or duplicate values fail before
credentials are read or infrastructure is created. This reuses the same isolated
services and adds no resources or IAM grants itself. With `--catalog
--inject-catalog-failure`, the intentional cleanup test runs after this window.

The default scheduler starts at most one HTTP request per second, with at most
two in flight globally and at most 600 dispatch slots. Add
`--soak-burst=4` with `--soak-seconds=60` through `600` to dispatch four requests
at the start of each four-second window, two for each mode. A separate receipt
schema requires four simultaneously pending orchestrator requests; a capacity
miss fails the run. This counter includes dispatch before Fetch starts and does
not prove concurrent execution inside a Worker or backend, or overlap in every
four-request group.
This keeps the same total request count and does not add resources or IAM grants.
Both patterns alternate the two transport modes. Every sixth request for each mode runs the real Secret Manager SDK's
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
same client after application errors and caller cancellation. The burst option
also checks simultaneous deployed requests through both modes. It does not measure
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

The next run, `wga-probe-20261004-dc290208` at source `a24fe55`, passed all
600 requests: each mode completed 250 recovery batches and 50 SDK reads. No
slots were skipped. The intentional failure injection then exited `1`; all nine
owned resources were deleted, both database deletion operations completed, and
the existing inventory was unchanged. This is a successful finite campaign at
that recorded source, not an explanation or correction of the three earlier
HTTP failures. Neither historical run exercised the optional renewal check.

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
