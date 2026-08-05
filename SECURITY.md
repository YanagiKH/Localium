# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Older development snapshots | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving authentication, cryptography, certificate handling, key storage, authorization, file access, invitation bypass, or remote code execution.

Use GitHub's private vulnerability reporting feature for this repository when available. Include:

- Affected commit or release
- Operating system
- Reproduction steps
- Expected and observed security property
- Minimal proof of concept
- Impact assessment
- Suggested mitigation, if known

Do not include real private messages, files, invitation codes, room keys, private keys, TLS private keys, or client vaults.

## Response process

Maintainers will validate the report, assess affected versions, prepare a fix, add regression coverage, and publish an advisory when appropriate. Disclosure timing should allow users to update before full technical details are made public.

## Security design

Read [docs/SECURITY_MANUAL.md](docs/SECURITY_MANUAL.md) before deployment. The manual documents the threat model and known limitations, including the absence of automatic versioned room-key rotation and forward-secret sender chains in version `0.1.0`.
