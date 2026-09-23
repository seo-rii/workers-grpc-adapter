# Security

This project is an unpublished prototype. There is no supported stable release or security maintenance schedule. Security fixes are evaluated against the current development version; production suitability has not been established.

## Reporting a vulnerability

Do not put vulnerability details, credentials, tokens, or customer data in an ordinary issue or pull request.

Contact the maintainer through a private contact method listed on [their GitHub profile](https://github.com/seo-rii). If no private method is available, open an issue containing only a request for a private security contact, without reproduction steps or sensitive details. If private vulnerability reporting is enabled in the future, GitHub's **Report a vulnerability** option in the Security tab can also be used.

Once a private channel is established, include:

- The affected commit or package version and runtime.
- A minimal reproduction using synthetic data and credentials.
- The expected security boundary and observed impact.
- Any relevant logs with secrets and identifying data removed.

There is no guaranteed response time. Please allow the maintainer to assess the report and coordinate a fix before disclosing exploit details.

## Security boundaries

Gateway configuration determines where RPC payloads and authentication metadata are sent. Use trusted HTTPS gateways and review endpoint mappings before supplying credentials. The adapter's plaintext loopback option exists for local tests; it is not a production transport setting.

The default local verification suite uses synthetic data and loopback services. It does not require or validate production credentials, Google IAM policies, or a deployed Cloudflare security configuration. Do not include real secrets in fixtures or CI artifacts. See [Limitations](docs/limitations.md) and the [API reference](docs/api.md) for supported credentials, transport constraints, and configuration behavior.
