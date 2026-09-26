# Temporary Cloudflare probe

This opt-in harness creates one uniquely named `wga-probe-*` Worker on an existing account's `workers.dev` subdomain, tests it, and deletes it in `finally`. It does not configure custom domains, DNS, routes, storage or existing Workers. Google API and write opt-ins remain disabled.

## Run

Prepare the pinned fixtures using [the local testing guide](testing.md). Supply `CF_TOKEN` or `CLOUDFLARE_API_TOKEN` through the process environment. For a token with access to multiple accounts, also set `CLOUDFLARE_ACCOUNT_ID`. The account must already have a Workers subdomain and permit Worker deployment/deletion. Then explicitly opt into creating the temporary service:

```sh
node scripts/cloud-probe.cjs --deploy-temporary
```

The command does not load dotenv files. Run it with stdout/stderr redirected to a restricted log. It normally takes a few minutes; individual RPCs have deadlines and size limits. Public test services can be unavailable or change behavior.

The generated bearer key is uploaded as a Worker secret. Its temporary file has mode `0600` inside a `0700` directory and is removed during cleanup. Requests cannot supply an arbitrary outbound destination or RPC body. The key is never forwarded to RPC targets.

## What runs

1. Build the actual Google live entry and the protected protocol probe with the pinned SDK preset, then Wrangler.
2. Execute that final bundle in local workerd with outbound access denied: authentication guard, Google-disabled guard, SDK constructors and protobuf roundtrip.
3. Collect independent public-server controls with native grpc-js, direct gRPC-Web over HTTP/2, and gRPC-Web over Fetch.
4. Confirm the generated Worker name does not exist, then deploy the exact preflighted bundle with `--no-bundle` and its secret.
5. Invoke SDK bootstrap twice, unary and server-streaming fallback, automatic-mode unary/stream/error cases, a raw response diagnostic, and the authorization/Google-disabled guards.
6. Delete only the generated Worker and verify the API returns `404`. Remove the local secret file.

`SIGINT`/`SIGTERM` request bounded shutdown and cleanup. A hard kill or API outage can prevent cleanup: use the saved `name` and `accountId` in the report to inspect and delete that exact temporary Worker. A cleanup failure exits nonzero.

## Controls and interpretation

| Target | Purpose |
|---|---|
| `grpcb.in:443` | Native gRPC echo, ten-message stream and explicit status `3` error |
| `demo.connectrpc.com` | Existing gRPC-Web service for explicit fallback unary and stream |

Contracts come from the maintainers' [grpcbin endpoint documentation](https://github.com/moul/grpcbin), [grpcbin proto](https://github.com/moul/pb/blob/master/grpcbin/grpcbin.proto), and [Eliza proto](https://github.com/connectrpc/examples-go/blob/main/proto/connectrpc/eliza/v1/eliza.proto). The same fixed harmless payloads are used by the Node controls and deployed Worker. Cloudflare's [gRPC announcement](https://blog.cloudflare.com/grpc-workers/) describes the platform conversion path; account entitlement is established by behavior, not assumed from an ordinary API token.

Fallback success proves deployed adapter operation against an existing gRPC-Web endpoint. Automatic conversion requires successful native controls, an actual response demonstrating that direct HTTP/2 gRPC-Web does not work at that origin, and correct deployed messages/statuses. A network failure alone is inconclusive. Eliza success cannot establish automatic conversion because Eliza already supports gRPC-Web.

Results, artifact/source hashes and the cleanup receipt are written to ignored `verification/cloud-probe.json`. `cloudflareModePassed` records the three deployed RPC outcomes; inspect the controls before attributing success to platform translation. `deployedCloudflareExecuted` records deployment and invocation, not beta entitlement. No result from this probe certifies authenticated Google APIs, Google OAuth/IAM, sustained load or general grpc-js compatibility. `releaseEligible` remains `false`.

## Observed deployment: 2026-09-24

The temporary Worker completed its run and was deleted; the deletion API returned `200`, followed by `404` on lookup. Its exact deployed bundle SHA-256 was `284969adc27b55ec2b0316fad0555406d1db3f48534e6b0d1f73b2d3244221a9` (16,471,792 bytes; 1,611,588 bytes gzip), with compatibility date `2026-09-21` and `nodejs_compat`.

| Check | Observation |
|---|---|
| Deployed SDK bootstrap, twice | Passed: three Google SDK constructors, OAuth2Client, static protobuf roundtrip |
| Deployed fallback unary / server stream | Passed: status `0`, one / four messages |
| Native grpcbin control | Passed: unary echo, ten-message stream, exact status `3` and Unicode error reason |
| Direct HTTP/2 gRPC-Web to grpcbin | HTTP `500`, plain text; no valid gRPC-Web response |
| Deployed automatic-mode unary / stream | Status `2`, `WGA_NOT_GRPC_WEB`, zero messages |
| Deployed automatic-mode error case | Status `4`, `WGA_DEADLINE` after 25 seconds |
| Raw Worker fetch to grpcbin | HTTP `520`, plain text; no gRPC status header |
| Unauthorized / Google-disabled gates | HTTP `404` / `403`, as expected |

This establishes deployed fallback operation and SDK bootstrap. It does **not** establish working automatic conversion on the tested account. The data do not distinguish missing beta entitlement/configuration from a Cloudflare-to-origin problem; checking the account's private-beta configuration and repeating against a controlled native gRPC origin are the next steps. No authenticated Google API was called because test credentials were not configured.

The runner exited `0` after collecting all observations and completing cleanup, with report status `completed-with-cloudflare-mode-failure`. That exit code is not a claim that both modes passed. A subsequent interruption check only changes the runner's pre-deployment shutdown behavior; the deployed Worker and control payloads above are unchanged.
