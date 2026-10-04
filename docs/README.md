# Documentation

Start with the project [README](../README.md), then use these guides for the current implementation:

| Guide | Contents |
|---|---|
| [API reference](api.md) | Client surface, configuration, credentials and build-time SDK support |
| [Limitations](limitations.md) | Supported scope and remaining compatibility gates |
| [Architecture](architecture.md) | Request flow, module boundaries and call lifecycle |
| [Resource limits](resources.md) | Shared admission, queue and buffer limits, readable queues and usage counts |
| [Observability](observability.md) | Logical-call and attempt events, durations, traffic counters and privacy boundaries |
| [Retries](retries.md) | Explicit replay policy and shared endpoint throttling |
| [Fetch server](server.md) | All four RPC shapes, typed handlers and service-binding lifecycle |
| [Structured status details](status-details.md) | Optional bounded error envelopes and isolated detail decoders |
| [SDK profiles](profiles.md) | Declarative pins, diagnostics and transformer-aware generation identity |
| [SDK performance](sdk-performance.md) | Actual SDK Worker bundle, startup, latency and sampled heap baselines |
| [Call and stream lifetime](call-lifecycle.md) | Cancellation, destruction, iterator exit and pending writes |
| [Interceptors](interceptors.md) | Asynchronous ordering, transformations and logical completion |
| [Testing](testing.md) | Local setup, test layers, generated evidence and CI artifacts |
| [Executable documentation](documentation.md) | Example execution, generated support tables, policy comparisons and reference/provenance checks |
| [Public client contracts](local-contracts.md) | Original API, configuration and type cases with native and workerd evidence |
| [Google SDK tests](google-tests.md) | Pinned fixtures, emulators, adding scenarios and live opt-in |
| [Design decisions](decisions.md) | Reasons for the implementation boundaries |
| [Sources and provenance](sources.md) | Official references, pinned artifacts and source verification |

The [v0.3 specification](spec/v0.3.md) is a historical design document in Korean. It records the broader intended design, not a claim that every requirement is implemented. The [original test catalog](../compatibility/test-catalog.json) preserves its 189 planned cases. Current behavior and limitations are described by the guides above.

Builds, tarballs and verification reports are generated locally or by GitHub Actions; they are not checked into Git. Output paths in these guides refer to those generated files. Inspect the corresponding workflow run's artifacts for executed evidence.
