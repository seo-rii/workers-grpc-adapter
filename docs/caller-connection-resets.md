# Caller connection resets

The Node caller can encounter an HTTP connection reset before a deployed Worker
returns response headers. A controlled Cloudflare comparison reproduced this
with reused caller sockets while fresh HTTPS connections completed every request
in the same finite comparison. This identifies a caller connection failure mode;
the original seven SDK-campaign failures lack individual socket records, so their
causes remain unconfirmed.

The caller is the Node probe process sending POSTs to a Worker. The adapter runs
inside the Worker and uses Fetch for its backend RPC. These are separate network
paths. See the [original nadd-al result](gcp-cloud-probe.md#nadd-al-deployment-and-burst-result-2026-10-05-kst)
for the SDK campaign and its cleanup receipts.

## Local mechanism comparison

The local experiments used Node `v24.1.0`, built-in Undici `7.8.0`, a localhost
HTTPS server and a temporary trusted certificate. Each iteration consumed one
POST response, closed its idle server connection, then issued a second POST.
Each transport used 200 iterations per condition. There was no explicit retry.

| Server action before the second POST | Built-in Fetch failures | HTTPS with keep-alive failures | HTTPS with a fresh connection failures |
| --- | --- | --- | --- |
| Close idle connections, dispatch in the same turn | 200/200, `UND_ERR_SOCKET` | 200/200, `ECONNRESET` | 0/200 |
| Close idle connections, wait 5ms, then dispatch | 4/200, `UND_ERR_SOCKET` | 1/200, `ECONNRESET` | 0/200 |
| Explicit TCP `resetAndDestroy()`, dispatch in the same turn | 200/200, cause `ECONNRESET` | 200/200, `ECONNRESET` | 0/200 |

The server did not receive the failed second POSTs in these controlled local
cases. Fresh HTTPS observed 400 POSTs and 400 TLS connections in each condition.
Those observations apply to the local server; a failed real caller POST is not
proof that a Worker did not receive or execute it. The 5ms delay was an elapsed
wait, not confirmation that the client had processed a socket-close event.
It did not eliminate the race.

The experiment records are `local-reset-1791209133900833277` and
`local-rst-1791209233012210653`. Both experimental processes exited `0`; their
reported failures are deliberately induced comparison outcomes. Node's
[reused-socket documentation](https://nodejs.org/download/release/v24.1.0/docs/api/http.html#requestreusedsocket)
describes the same connection-close timing hazard for keep-alive HTTP clients.

## Cloudflare caller comparison

Run `wga-fetch-diag-c832bc84f055` used one temporary synthetic Worker, without a
gRPC or Google SDK workload. It compared 300 caller Fetch POSTs and 300 fresh
HTTPS POSTs, dispatched in bursts on a four-second schedule, using Node
`v24.1.0` and built-in Undici `7.8.0`.

| Caller transport | Completed | Passed | Failed | Requests using a reused socket | Failures on reused sockets |
| --- | --- | --- | --- | --- | --- |
| Built-in Fetch | 300 | 298 | 2 | 297 | 2 |
| Fresh HTTPS | 300 | 300 | 0 | 0 | 0 |

Both Fetch failures were `TypeError` with cause `ECONNRESET`, before response
headers. Each recorded one HTTP send event on an already-used socket. The
recorded socket had been idle for about 3.99s or 3.96s; the requests failed after
about 34ms or 6ms. Socket error and close events were recorded for both. This
supports reused caller connections as a failure mechanism in this diagnostic.
It does not identify whether the remote endpoint or an intervening network
component initiated the resets, or establish a universal four-second timeout.

The diagnostic's owned Worker was deleted with HTTP `200`, then its absence
was confirmed with `404`. An existing Worker's metadata changed between the
account inventory snapshots. The diagnostic therefore exited `1` with
`existingInventoryUnchanged: false` and `releaseEligible: false`. The finite
transport comparison remains useful evidence, but the full run did not pass its
inventory gate. The metadata change was not attributed to this experiment; only the owned
Worker's deletion and absence were verified.

The earlier SDK run `wga-probe-20261005-585517a2` passed 593 of 600 caller requests
and reported seven Fetch `ECONNRESET` failures before headers. That receipt did
not record socket reuse or socket lifecycle for each request. Similar error
codes and timing make the mechanism a candidate explanation, not confirmation
that all seven failures share it. Neither comparison proves long-term service
reliability or production connection-pool behavior.

## Optional caller control

The existing-project probe accepts `--worker-http=fresh` alongside its normal
explicit deployment options. It uses `scripts/gcp-worker-http.cjs` to issue each
caller POST with Node HTTPS and `agent: false`. Node documents
[one-use agents](https://nodejs.org/download/release/v24.1.0/docs/api/http.html#class-httpagent)
for this option. The default remains `--worker-http=fetch`.

The fresh control does not retry POSTs, follow redirects, change SDK retry
policies or replace the adapter's Worker-to-backend Fetch transport. It preserves
caller cancellation and timeout composition, distinguishes failures before
headers from response-body failures, and limits response bodies to 256 KiB.
The receipt records the caller transport and Node version; the Fetch choice also
records the built-in Undici version. Provider management API requests still use
Fetch. Creating a connection per call adds TLS cost, so caller latency cannot be
compared as though the transport were unchanged.

A finite successful fresh run would isolate one caller variable. It would not
retroactively turn an earlier failed run into a pass or establish that production
clients should disable connection reuse. A reset before response headers also
cannot safely justify an automatic retry of an arbitrary write operation.

## Reproduce the maintained checks

Run `node --test test/gcp-worker-http.test.cjs` to exercise the 13 local HTTPS and
option-parsing regressions. They cover separate connections per POST, headers
before body completion, resets before and after headers, delayed body consumption,
cancellation and socket cleanup, UTF-8 byte limits, redirect handling, invalid
status cleanup, URL rejection and duplicate or malformed transport flags.
The tests create and remove a temporary local certificate with `openssl`; they
require no cloud credentials or external network.

Run `node scripts/test-gcp-readiness.cjs` for the 14 isolated runner checks. They
verify readiness polling and the actual caller selection function, default Fetch
behavior, fresh HTTPS authorization and cancellation, failure-stage and HTTP-status
preservation, response redaction, and absence of hidden retry or fallback. These
checks perform no network requests or credential reads.

Live comparison requires separate deployment permission and the prerequisites
in the [temporary deployment guide](gcp-cloud-probe.md). Use identical approved
project, SDK workload, duration and burst settings, select the caller transport
explicitly, preserve both receipts, and wait for cleanup. A live command creates
billable temporary services; normal local verification and CI never invoke it.
