# Executable documentation checks

Documentation checks run in the same local verification and CI pipeline as the
installed package, SDK, workerd and emulator tests. Each generated receipt names
its source inputs. A documentation check passing means its stated comparison
passed; it does not turn an unexecuted example or a partial compatibility case
into supported behavior.

## Examples

The example inventory covers fenced blocks throughout the maintained Markdown,
including the historical design specification. The two README configuration
alternatives are compared byte for byte with consumer fixtures and run in
separate workerd instances using the installed package. Controlled RPCs check
the selected route, wire format, returned bytes and cleanup.

Every other fenced block is explicitly classified as an expected example that
was not executed. The generated `verification/doc-examples.md` lists each block,
its document and line, classification and reason. Shell setup, live deployment
commands, JSON configuration and design diagrams are not silently counted as
successful runtime tests. Changed or newly added blocks require an inventory
review.

## Support tables

`verification/documentation-support.md` is generated from the exact SDK profile
manifests, executed export contract and individual runtime catalog references.
Its JSON counterpart records the input and output hashes. The table includes
SDK versions, profile identity, native export grades and per-case coverage and
execution status. The five documentation cases are excluded from the runtime
support table so the generator cannot certify itself.

Covered, partial and planned coverage remain separate from passed, failed,
blocked, skipped and not-run execution. A passing subset never promotes a
partial case. Historical deployed checks do not become current local cloud
certification. Performance certification stays blocked while its thresholds
are unset. Find these generated files in the private CI run's verification
artifact or in the local verification directory.

## Checked compatibility boundaries

The [export policy](../compatibility/export-policy.json) and the
[declaration guide](exports.md) enumerate every unsupported native root name,
type-only export and import-only placeholder. The checker requires the complete
documented absent-name list and grade counts to match the executed contract.
It also compares reviewed statements in the README and API/limitations guides
with named passing tests and fresh installed-package observations in both modes.

Authentication generator failures expose `WGA_AUTH_METADATA` and omit the
generator's private error message. Missing or nonnumeric error codes become
`UNKNOWN`; invalid numeric/control-plane codes become `INTERNAL`; allowed
gRPC error codes are retained. Failure does not trigger an anonymous Fetch.

`getPeer()` identifies the logical service URL even when a gateway is selected.
`getAuthContext()` returns null. Fetch TLS does not expose a peer certificate
through these calls. Native server constructors, native readiness and inline
certificate options retain their explicit failure behavior.

The default transport send and receive ceilings are each 32 MiB per message.
Setting a channel message limit to `-1` keeps the transport ceiling in force.
The policy check uses small explicit ceilings to exercise send rejection,
receive rejection and successful client reuse without allocating 32 MiB.

The checked statements are an explicit review manifest, not a general natural
language proof of every sentence. Changes to the named statements, export
inventory, test results or observed contracts fail the gate and require review.

## References and release provenance

Local documentation links, heading anchors, npm and Node commands, example
paths, diagnostic codes and test/requirement IDs are checked against their
actual repository definitions. Historical and proposed references have exact
contextual exceptions; those exceptions do not certify an implementation.
External links are inventoried without making verification depend on websites.

Vendor verification checks the pinned upstream archive, registry provenance,
LICENSE, NOTICE policy, pristine sources and reproducible patches. Setup fetches
and verifies the pinned artifacts; verification itself is offline and fails
when a required pin, archive or notice is missing or inconsistent. The package
remains private and these checks do not make it eligible for production release.
