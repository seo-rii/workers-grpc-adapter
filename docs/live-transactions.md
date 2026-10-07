# Live transaction verification

The opt-in cloud probe uses the pinned Google v1 clients against two newly
created named databases. It verifies transaction conflicts and one controlled
failure after a successful Commit. Native grpc-js and both deployed Worker modes
run identical shared business logic; transport setup remains separate.

```sh
node scripts/gcp-cloud-probe.cjs --deploy-temporary --project=YOUR_PROJECT \
  --region=asia-northeast3 --verify-transactions --worker-http=fresh
```

This command creates temporary Google and Cloudflare resources and synthetic
records. Supply authorized short-lived credentials and a project suitable for
temporary resources. Existing resources are inventoried, never reconfigured,
and checked after cleanup. Owned resource identities are checked before deletion.
The probe is disabled in ordinary CI; local tests exercise its logic and guards
without establishing production database behavior.

## Conflict scenario

Both temporary databases explicitly use `OPTIMISTIC` concurrency. The runner
requires the returned database configuration to confirm that mode. It does not
change an existing database's mode. Google documents database concurrency modes
for [Datastore](https://docs.cloud.google.com/datastore/docs/concepts/transactions)
and [Firestore](https://docs.cloud.google.com/firestore/native/docs/transaction-data-contention).

Two explicit read-write transactions read the same record and its initial value.
The first commits an update. The second attempts another update and must receive
the real Google `ABORTED` status (10). An independent read confirms the winner's
value; a fresh transaction using the same client confirms recovery. Cleanup
deletes the record and verifies absence. SDK and adapter retries are disabled
so a transaction helper cannot hide the conflict by retrying it.

This bounded sequence verifies an overlapping optimistic snapshot conflict.
It does not establish behavior for every production database mode, high-contention
workload, or high-level SDK transaction retry policy.

## Accepted Commit with hidden response

The mutation uses a stable record identity and marker. One Commit is sent and
allowed to succeed. Its successful result is then deliberately discarded:

| Execution | Injection boundary | Evidence required |
| --- | --- | --- |
| Native grpc-js | Completed Google SDK Commit result | One successful Commit result before injected `UNAVAILABLE` |
| Worker fallback | Adapter Fetch response | HTTP 200 and complete bounded unary frames ending in gRPC status 0 |
| Worker Cloudflare conversion | Adapter Fetch response | The same success and framing checks after conversion |

The caller receives `UNAVAILABLE` (14). Within the armed mutation window, the suite
must observe exactly one Commit attempt and one discarded successful response;
setup and delete-cleanup writes are separate operations. It does not resend Commit. An
independent read with the same client reconciles the applied mutation, and
cleanup verifies the record is gone.

This is an injected failure after observing success, not an uncontrolled network
outage. The native control uses a different observation boundary and does not
prove identical native transport cancellation behavior. A failed Commit response
does not imply rollback: applications need reconciliation or an idempotency
policy before retrying writes.

## Receipt and verification limits

The private cloud receipt contains four native results and eight deployed Worker
results, confirmed database modes, source hashes, bundle identity, cleanup, and
existing-resource inventory comparisons. The transaction summary rejects missing
or duplicate results, incorrect modes, unsuccessful HTTP responses, or missing
checks. No metadata, token, or record payload is copied into that summary.

The original dedicated-project certification gate remains separate. A successful
temporary campaign in a shared project does not satisfy that gate or establish
production IAM, quota, long-running authentication, or sustained-load reliability.

## Executed campaign

On 2026-10-07, campaign `wga-probe-20261007-e4171af0` ran from source revision
`5ecb406` in an authorized shared project in `asia-northeast3`. All twelve
transaction executions passed: four native controls, four gateway fallback
calls, and four Cloudflare conversion calls. Both returned database
configurations confirmed `OPTIMISTIC` mode. Every scenario included record
cleanup and a verified subsequent read; conflict scenarios also committed a
fresh recovery transaction.

The cloud runner retains its private source and bundle hashes, transport
receipts, resource identities, and final infrastructure cleanup result locally.
The runner exited successfully and verified all eight owned resources absent,
including both completed database deletion operations. The GCP inventories
matched. Cloudflare's existing script names also matched, but one pre-existing
Worker outside this run had a different `etag` and modification time. The probe
did not target that Worker; account-wide metadata immutability was not established.
The results establish the bounded scenarios above; they do not close the
dedicated-project certification gate or establish natural network-failure
frequency and write-retry safety for arbitrary applications.
