# Open-source publication review

Review and source publication date: 2026-10-07. The owner authorized publishing
the source repository as an experimental project at revision `6d84489`.
GitHub visibility is now public; no npm package or stable release was published,
and source publication does not establish production certification.

## Assessment

The source tree has the foundations for an experimental open-source release:
an explicit license, reproducible vendored sources, contribution and security
guidance, pinned dependency profiles, a credential-free local verification
workflow, and documented compatibility boundaries. The publication checks below
record the verified preparation and owner-authorized source visibility change.
Benchmark uploads now carry the complete license and notice
assets and a prominent notice identifying the modified grpc-js client code. Source publication
does not establish a stable release, a security maintenance commitment, or
production certification.

`private: true` remains intentional. It prevents npm publication; it does not
prevent distributing a source checkout under its existing licenses. A public
source repository can continue using local tarballs and exact SDK profiles.
The supported behavior and remaining platform constraints are described in
[Limitations](limitations.md), [Profiles](profiles.md), and [Testing](testing.md).

## Dependency migration

The 2026-10-07 post-migration npm audit completed successfully for all six
installed graphs: root, static adapter, static native control, Worker tooling,
modern adapter, and modern native control. Each reported zero advisory findings.
The static profile now pins Datastore 10.1.1 and protobufjs 7.6.6 at revision 5;
native controls use grpc-js 1.14.5. Worker development tooling was also updated.
The Miniflare pin is an alpha version, so the tooling integration remains part
of the final regression checks.

An audit is a dated registry-advisory snapshot. It does not inspect the adapter's
own source or its copied grpc-js subset, establish absence of vulnerabilities,
or extend support to arbitrary dependency graphs. The vendored pristine source
retains its original version and reproducible patch provenance; it is reviewed
separately from the native npm package. Packaging, native comparisons, SDK,
workerd, emulator, and CI checks must validate the changed pins together.

## Real transaction verification

The final 2026-10-07 campaign at source revision `c115240` passed all 12 transaction
results: four native grpc-js controls, four deployed Worker fallback cases,
and four deployed Cloudflare conversion cases. Both newly created databases
confirmed `OPTIMISTIC` concurrency. Datastore and Firestore returned real
`ABORTED` (10) statuses for conflicting snapshots, and independent reads verified
the winner and recovery with the same client.

The accepted-Commit cases discarded an observed successful response and exposed
`UNAVAILABLE` (14) to the caller. Each case verified one Commit attempt, no
automatic resend, the applied mutation through an independent read, and deletion
of its synthetic record. This checks reconciliation after a controlled loss of
the success result; it does not simulate every uncontrolled network failure.
The injection boundaries and retry limits are documented in
[Live transactions](live-transactions.md).

Campaign completion also requires the final infrastructure cleanup receipt and
existing-resource inventory comparison. Those receipts stay private and are
summarized in the verification handoff. Shared-project execution does not satisfy
the separate dedicated-project certification gate.

## License and package contents

Original adapter code uses the root [MIT license](../LICENSE). The copied grpc-js
client core remains under [Apache-2.0](../vendor/LICENSE), with its copyright
headers, [attribution](../NOTICE), [vendor notice](../vendor/NOTICE), pristine
sources, pinned provenance, and reproducible patches retained. Modified upstream
files must also contain an explicit modification notice. Apache-2.0 section 4
requires preservation of the license and applicable notices, including notices
on modified files. See the [license text](https://www.apache.org/licenses/LICENSE-2.0.txt).

The package allowlist excludes credentials, installed dependencies, fixtures,
cloud receipts, logs, downloaded tools, and generated verification reports.
Standalone package tests check installed exports, declarations, build profiles,
and license/notice assets. The dependency graph includes optional LGPL-marked
development tools; these are not adapter runtime dependencies or contents of the
adapter tarball. Publishing separate SDK Worker bundles or tool binaries would
require reviewing the actual redistributed contents and their notices.

## Benchmark distribution preparation and historical artifacts

The transport benchmark now retains esbuild legal comments, adds a prominent
notice identifying the modified grpc-js 1.14.0 client code, and copies the complete
MIT `LICENSE`, adapter `NOTICE`, Apache-2.0 `vendor/LICENSE`, and `vendor/NOTICE`
from the actual installed adapter. The benchmark receipt binds each copy to
its installed source and to the lock-identified package tarball. Both the plain
and gzip bundles carry the same modification notice.

The CI collector includes all four notice assets alongside the bundles and
esbuild manifest. It rejects an incomplete bundle distribution before creating
an upload archive. Regression tests inspect the real collector's tar.gz output,
including byte identity, missing notices, and altered notices. This concerns
only the adapter client benchmark: its 24 inputs contain no Google SDK or GAX.
Separate SDK bundle distribution still requires its own notice review.

The retained historical snapshot contains 21 affected Actions artifacts,
representing three distinct bundle contents, created before this fix. Those
archives omit standalone adapter LICENSE/NOTICE assets and their bundle comments
were stripped. A cached pristine grpc-js archive supplies its original Apache
license, but not the adapter's MIT notice or the modified adapter's notices.
[MIT](https://opensource.org/license/mit) and
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) require preservation
of their applicable licenses and notices.

All 21 original artifact ZIPs have verified private backups whose sizes and
SHA-256 values match GitHub's artifact metadata. A private supplemental archive
contains the complete license/notice assets, upstream provenance, and the exact
artifact-to-bundle hash mapping. These private backups preserve the evidence;
they do not repair the existing hosted copies.

On 2026-10-07, the owner authorized removal of exactly these 21 backed-up
artifacts. All 21 were deleted; each artifact ID returned 404, and the
post-removal inventory confirmed their absence. Run logs, unrelated artifacts,
and the final notice-bearing CI artifact were retained. The verified original
ZIPs, supplemental license archive, exact IDs, and cleanup checks remain in the
private preparation receipt. The owner subsequently authorized public source
visibility. npm publication remains disabled and requires separate authorization.

## Credentials, history, and cloud identifiers

The initial reachable Git history screen covered 150 commits and 1,285 unique
blobs at `49a1796`, with no large blobs omitted. Selected patterns screened for
private-key PEM blocks, Google key JSON, common API/access-token formats, and
literal credential assignments. The assignment candidates were synthetic OAuth
test fixtures. No actual credentials were identified by this screen, and no
credential files or binary archives were tracked. This is bounded screening,
not a guarantee that every possible secret format has been detected.

A follow-up after the migration and transaction fixture commits, at `5ecb406`,
covered 153 commits and 1,389 unique blobs, plus 518 current files comprising
tracked files and the publication draft. It also screened Google OAuth token
formats. The new assignment candidate was another explicitly synthetic
transaction-test token;
no actual credentials or omitted large blobs were identified.

The retained Actions review covered all 88 artifacts and all 109 completed run
logs available at the 2026-10-07 metadata snapshot. It screened 13,778 archive
members, about 1.51 GB after expansion, with no download failures. A separate
nested-content review covered the 44 cached upstream archives and compressed
benchmark bundles: four distinct containers after hash deduplication, another
684 files, and about 2.78 MB. Neither review identified credential candidates.
Eight metadata findings contained the historical shared project name in generated
documentation/report manifests. These are identifiers, not access credentials.

Environment files, Wrangler state, build artifacts, and raw live receipts are
ignored by Git. Public tests use synthetic credentials and loopback services.
The normal CI workflow does not run cloud tests or upload raw cloud receipts;
generated documentation manifests can still repeat identifiers from tracked
documents. Historical documentation contains a shared test-project name and
temporary run identifiers. Their disclosure, along with Git author identities,
was included in the owner-authorized source publication. Editing the current
document alone would not remove them from Git history or retained Actions artifacts.

This review covers reachable local Git history and the retained Actions snapshot.
It does not cover deleted or expired artifacts, unreachable Git objects, private
external services, or every possible secret format. New source revisions and
Actions artifacts require their own review. The 2026-10-07 screen at `3a00c0c`
covered 166 commits, 1,422 unique blobs, 518 tracked
files, all 95 retained artifacts and 116 completed run logs, plus 53 nested
containers. It identified no actual credential candidates in the selected
patterns, with no skipped large blobs or failed downloads.

The final publication preflight at `6d84489` included the subsequent source,
artifact, and log deltas. It matched all 76 retained artifacts and 118 completed
runs to the reviewed records, with no new credential candidates or unreviewed
contents. CI run [37618362401](https://github.com/seo-rii/workers-grpc-adapter/actions/runs/37618362401)
passed all 867 unit tests and 68 verification commands; its separate cloud
certification preflight was intentionally blocked. This does not replace the
actual transaction evidence or establish production certification.

Read-only repository metadata also showed no issues or pull requests, issue
comments, review comments, releases, or deployment records. Wiki and Pages were
disabled. There were no additional contents in those surfaces to review at that
snapshot.

GitHub makes existing Actions history and logs visible when a private repository
becomes public. Review retained logs and artifacts as well as tracked files;
the source-file review alone is insufficient. See [GitHub's visibility guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).

## Contributors and public CI

[CONTRIBUTING.md](../CONTRIBUTING.md) describes the pinned setup, focused tests,
fixture updates, full verification, and generated files to exclude. The public
workflow uses read-only repository permissions, pinned Action commits, and
checkout without persisted credentials. Live Google execution and write opt-ins
are disabled; local emulator writes use synthetic projects. Fork contributions
must retain that separation.

[SECURITY.md](../SECURITY.md) describes private reporting and the current lack of
a stable maintenance commitment. [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
was enabled with source publication, and its enabled state was verified through
authenticated and anonymous API requests. Use the Security tab's **Report a
vulnerability** channel. No report was submitted to test delivery or monitoring;
the maintainer profile's private contact method remains a fallback.

## Completed source publication checks

These historical checks accompanied the owner-authorized public visibility
change on 2026-10-07; they do not establish a stable release:

1. Verified the notice-bearing benchmark archive in the final CI result and the
   private receipt confirming completed, authorized removal of all 21
   historical affected artifacts.
2. Verified the final migrated revision with vendoring, package, SDK, workerd,
   emulator, and CI checks. Retained historical vulnerable-version results as
   historical evidence rather than treating them as current results.
3. Retained the real transaction conflict and accepted-Commit evidence, including
   request counts, read-back decisions, retry boundaries, and completed cleanup.
4. Screened the final source revision and retained Actions logs/artifacts for
   credentials and classified findings without publishing credential values.
5. Included Git author identities and historical project metadata in the
   owner-authorized disclosure. Enabled and verified the private
   vulnerability-reporting channel during publication.
6. Kept the README's experimental status and supported-profile scope. Published
   only the source repository; npm package publication remains a separate action.

Real transaction coverage and a clean dependency audit strengthen the
experimental support claim. Long-running authentication, quotas, sustained
traffic, and deployment-specific platform behavior remain separate production
verification obligations; they do not prevent publishing honestly scoped
experimental source.
