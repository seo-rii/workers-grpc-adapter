# Security

This project is an experimental open-source prototype. There is no supported stable release or security maintenance schedule. Security fixes are evaluated against the current development version; production suitability has not been established.

## Reporting a vulnerability

Do not put vulnerability details, credentials, tokens, or customer data in an ordinary issue or pull request.

Use GitHub's [**Report a vulnerability**](https://github.com/seo-rii/workers-grpc-adapter/security/advisories/new) option in the repository's Security tab. Private vulnerability reporting is enabled; the setting was verified on 2026-10-07. This verification did not submit a report or test delivery or monitoring.

If that channel is unavailable, contact the maintainer through a private contact method listed on [their GitHub profile](https://github.com/seo-rii). If no private method is available, open an issue containing only a request for a private security contact, without reproduction steps or sensitive details.

Once a private channel is established, include:

- The affected commit or package version and runtime.
- A minimal reproduction using synthetic data and credentials.
- The expected security boundary and observed impact.
- Any relevant logs with secrets and identifying data removed.

There is no guaranteed response time. Please allow the maintainer to assess the report and coordinate a fix before disclosing exploit details.

## Security boundaries

Gateway configuration determines where RPC payloads and authentication metadata are sent. Use trusted HTTPS gateways and review endpoint mappings before supplying credentials. The adapter's plaintext loopback option exists for local tests; it is not a production transport setting.

The default local verification suite uses synthetic data and loopback services. It does not require or validate production credentials, Google IAM policies, or a deployed Cloudflare security configuration. Do not include real secrets in fixtures or CI artifacts. See [Limitations](docs/limitations.md) and the [API reference](docs/api.md) for supported credentials, transport constraints, and configuration behavior.
