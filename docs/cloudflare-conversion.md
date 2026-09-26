# Cloudflare automatic conversion diagnosis

Two separate problems explained the initial failures: the deployment did not enable outgoing conversion, and the adapter's `+proto` content type was incompatible with the tested Google endpoints. The account successfully converted requests to the controlled native gRPC server once explicitly enabled. Missing account entitlement is therefore not an explanation for that original failure.

## Conversion must be enabled

The original deployment used only `nodejs_compat`. Its adapter configuration selected the native origin, but the Fetch call did not ask Cloudflare to convert the request.

Cloudflare's [runtime flag definition](https://github.com/cloudflare/workerd/blob/f4ebbae6562718e53afbc3bba0f882266bd89529/src/workerd/io/compatibility-date.capnp) defines `auto_grpc_convert` without a default enablement date. The same source marks it as a Cloudflare edge proxy feature, with no conversion effect in standalone workerd. Cloudflare also exposes [per-request `cf.grpcWeb`](https://github.com/cloudflare/workerd/blob/f4ebbae6562718e53afbc3bba0f882266bd89529/types/defines/cf.d.ts), accepting `convert` or `passthrough`. The [change removing the experimental flag restriction](https://github.com/cloudflare/workerd/pull/7284) was merged on 2026-09-09. These source definitions qualify the less detailed [launch blog example](https://blog.cloudflare.com/grpc-workers/).

The adapter now sets `cf.grpcWeb` per request: `convert` for `cloudflare`, `passthrough` for `grpc-web`. A Worker-wide `auto_grpc_convert` flag is not required. The historical comparison below used the previous adapter without those options. Adding that flag alone did **not** resolve its Google content-type problem.

Run `wga-probe-20260926-228b222e` deployed the same bundle to separate Workers with the flag off and on, then read the actual compatibility settings back from Cloudflare. Native grpc-js passed unary echo, a ten-message stream, and an exact status-3 error with Unicode details. Direct HTTP/2 gRPC-Web to the same private Cloud Run origin returned HTTP 502/plain text.

| Worker flag | Request `cf.grpcWeb` | Controlled native origin |
|---|---|---|
| Omitted | Omitted | HTTP 502; adapter reports `WGA_NOT_GRPC_WEB` |
| Omitted | `convert` | HTTP 200; matching echo and status-0 trailer |
| Enabled | Omitted | Unary, ten-message stream and exact error all pass |
| Enabled | `convert` | HTTP 200; matching echo and status-0 trailer |
| Enabled | `passthrough` | HTTP 502 again |

This establishes both the missing opt-in and the request override behavior on the tested account. Google SDK suites still failed with code 12 in the flag-enabled Worker, while native and explicit Envoy fallback suites passed. That required a separate wire-level comparison.

## Google content-type incompatibility

Run `wga-wire-20260926-6bf341ec021fae44` removed the SDK and adapter from the request path. It sent the same encoded Secret Manager `GetSecret` request and short-lived OAuth credential to a deliberately nonexistent secret name. A successful protocol exchange therefore returns gRPC `NOT_FOUND` (5); it does not return a secret payload.

| Path | Request content type | Result |
|---|---|---|
| Native HTTP/2 directly to Google | `application/grpc` | HTTP 200, gRPC 5 |
| Native HTTP/2 directly to Google | `application/grpc+proto` | HTTP 404, HTML, no gRPC status |
| Native HTTP/2 directly to Google | Both gRPC-Web forms | HTTP 404, HTML |
| Worker conversion enabled | `application/grpc-web+proto` | HTTP 404, HTML, no gRPC frames |
| Worker conversion enabled | `application/grpc-web` | HTTP 200, valid gRPC-Web trailer with status 5 and the expected missing-secret reason |
| Worker `passthrough` override | `application/grpc-web` | HTTP 404, HTML again |

The failing native `+proto` response and failing Worker `+proto` response had identical body SHA-256 values. Changing only the Worker request's content type to bare `application/grpc-web` made the authenticated Google call reach the gRPC service. Both flag-default and explicit `cf.grpcWeb: "convert"` behaved this way.

A separate native HTTP/2 comparison confirmed the same behavior for Firestore `GetDocument`, Datastore `Lookup` and Secret Manager `GetSecret`. Each pair used the same connection, OAuth token and protobuf body, targeting only freshly generated nonexistent resource names: `application/grpc` returned HTTP 200/gRPC 5, while `application/grpc+proto` returned HTTP 404/HTML. See `verification/google-content-type-controls.json`. No database or secret was created or modified for these controls.

The observed behavior is consistent with conversion retaining the `+proto` suffix, producing a Google-incompatible `application/grpc+proto` request. The provider's internal header rewrite was not directly captured; this is an inference supported by the independent native and deployed comparisons. The client-side content-type incompatibility itself was reproduced directly.

The previous `src/wire.ts` sent `application/grpc-web+proto` in both modes. `src/status.ts` maps an HTTP 404 without a gRPC status to code 12 (`UNIMPLEMENTED`). Thus the observed code 12 was not evidence that Secret Manager lacked `GetSecret`, nor an OAuth permission failure. The raw response was Google's HTTP 404 page before a valid gRPC exchange.

## Implemented transport behavior

Each call uses the mode captured by its transport configuration:

| Mode | Fetch option | Content-Type and Accept |
|---|---|---|
| `cloudflare` | `cf.grpcWeb: "convert"` | `application/grpc-web` |
| `grpc-web` | `cf.grpcWeb: "passthrough"` | `application/grpc-web+proto` |

Both modes retain binary protobuf framing and accept either binary gRPC-Web response content type. Call metadata and credentials cannot override these reserved negotiation headers. Regression tests exercise simultaneous unary and streaming calls, authentication isolation and default-mode calls. Local workerd tests inspect the final SDK requests; actual edge conversion requires the separate deployed test.

Run `wga-probe-20260926-6c3b0f09` then passed all five real Google SDK suites in both modes and the native baseline. Both Workers used only `nodejs_compat`; automatic-mode unary echo, ten-message streaming and exact error details all passed. The raw control without a conversion option still returned HTTP 502 from the native origin. See the [corrected deployment results](gcp-cloud-probe.md#corrected-results-2026-09-26) for the bundle hash, controls and cleanup evidence.

The project remains experimental. The finite transport checks do not certify credential refresh, sustained load, recovery or full grpc-js compatibility. Subsequent local regressions verify mixed-mode SDK clients in one isolate and bundled SDK imports during requests, removing the earlier cache and initialization constraints; see [limitations](limitations.md).

## Reproduction and evidence

Both commands require explicit temporary deployment authorization and `CF_TOKEN` or `CLOUDFLARE_API_TOKEN` in the environment. Credentials are kept out of reports. Run them with a restricted background log as described in the [GCP probe guide](gcp-cloud-probe.md).

```sh
# Native controls, fallback, and automatic conversion with the current adapter.
node scripts/gcp-cloud-probe.cjs --deploy-temporary \
  --project=YOUR_PROJECT --region=asia-northeast3

# One temporary Worker; no GCP resource creation and only a missing-secret read.
node scripts/gcp-conversion-wire.cjs --deploy-temporary --project=YOUR_PROJECT
```

The first command writes `verification/gcp-cloud-probe.json`; the second writes `verification/gcp-conversion-wire.json`. Per-run receipts are retained under `.wga-build/gcp-cloud-probe/` and `.wga-build/conversion-wire/`. These generated paths are ignored by Git. The wire probe waits for an authenticated JSON response from the deployed Worker before collecting results; an edge 404 during deployment propagation is not an upstream observation. The earlier `wga-wire-20260926-46a7782f9790c130` run lacked that readiness check, so its Worker 404s are excluded from the result tables; its Worker was also deleted.

Adding `--compare-auto-grpc-convert` deploys a third Worker with that compatibility flag. With the fixed adapter, both automatic-mode Workers explicitly request conversion; the raw diagnostic routes still allow testing the omitted and explicit Fetch options independently.

All nine resources from the successful flag comparison were deleted, both database delete operations completed, and the original inventory matched: 82 Cloud Run services, three databases, 34 secrets, 31 service accounts and six artifact repositories. Each wire-probe Worker was deleted and its final lookup returned 404. An earlier setup attempt created only one service account; its immutable-ID deletion and converged inventory are recorded in that attempt's `cleanup-recovery.json`.
