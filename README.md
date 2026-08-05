<p align="center">
  <img src="docs/images/localium-logo.svg" alt="Localium" width="920">
</p>

<p align="center">
  <a href="https://github.com/YanagiKH/Localium/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YanagiKH/Localium/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/YanagiKH/Localium/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/YanagiKH/Localium/actions/workflows/codeql.yml/badge.svg"></a>
  <a href="https://github.com/YanagiKH/Localium/releases"><img alt="Release" src="https://img.shields.io/github/v/release/YanagiKH/Localium?include_prereleases"></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-7aa7ff">
</p>

**Localium** is a self-hosted desktop chat system for schools, companies, laboratories, and organizations that need to exchange private messages and files on infrastructure they control. The desktop application can create a local server or join another Localium server with an invitation code. Every new device requires explicit approval from an owner or authorized administrator.

The server stores encrypted message and file payloads. Message content, file names, sticker selections, and file data are encrypted on the client before transmission. Localium does not require an OpenAI API key, cloud account, analytics service, or third-party chat backend.

> [!IMPORTANT]
> No software can guarantee absolute security. Localium provides a reviewed security-oriented architecture and strong modern cryptographic primitives, but deployment security still depends on endpoint safety, operating-system updates, firewall configuration, trusted administrators, and correct backups. Read the [Security Manual](docs/SECURITY_MANUAL.md) before production use.

## Interface

<p align="center"><img src="docs/images/overview.svg" alt="Localium server selection" width="100%"></p>
<p align="center"><img src="docs/images/chat.svg" alt="Localium encrypted chat" width="100%"></p>
<p align="center"><img src="docs/images/administration.svg" alt="Localium administration" width="100%"></p>

## Features

| Area | Included behavior |
| --- | --- |
| Server ownership | Create and run a private HTTPS/WSS server directly from the desktop application. Server state and encrypted assets remain in the host device's Localium data directory. |
| Invitations | Temporary invitation codes expire after 15 minutes by default. Permanent invitations and optional usage limits are supported. Invitations can be revoked immediately. |
| Approval gate | A valid invitation only creates a pending request. An owner or member with `approve_members` permission must approve the device and encrypt the room key to that device. |
| End-to-end encryption | XChaCha20-Poly1305 protects messages and file payloads. X25519 sealed boxes deliver the room key. Ed25519 signatures authenticate devices. |
| Transport protection | Every server generates a local TLS certificate. Invitation codes include its SHA-256 fingerprint, and the desktop client accepts the certificate only after fingerprint pinning. |
| Private files | Any file type up to 25 MiB can be encrypted locally, uploaded as opaque ciphertext, downloaded, decrypted, and saved through the native file dialog. |
| Stickers | Six built-in stickers are available. Authorized members can add and remove encrypted image stickers. |
| Administration | Manage pending devices, invitations, members, server appearance, encrypted backgrounds, stickers, audit events, and custom roles. |
| Custom permissions | Roles can combine `manage_server`, `manage_invites`, `approve_members`, `manage_members`, `manage_roles`, `manage_stickers`, `send_messages`, `send_files`, and `view_audit`. |
| Local key protection | Device private keys and saved room keys are encrypted through Electron `safeStorage`, backed by the operating system's credential protection. |
| Debugging | Optional JSON-line server logs, an in-app log viewer, deterministic validation commands, and a dedicated [Debugging Manual](docs/DEBUGGING.md). |

## Security architecture

```text
Approved device
  ├─ Ed25519 signing key ── signs the server challenge
  ├─ X25519 key pair ───── opens the sealed room key
  └─ Room key ──────────── encrypts messages/files with XChaCha20-Poly1305
               │
               ▼ pinned TLS (WSS/HTTPS)
Localium server
  ├─ validates signatures, roles, invitations, approval, limits, and sessions
  ├─ stores encrypted message envelopes and encrypted asset blobs
  └─ cannot derive the room key from stored sealed-key records
```

Important properties:

- Server authentication uses a pinned SHA-256 certificate fingerprint carried inside the invitation.
- Device authentication uses signed, single-connection challenges.
- Session tokens are random 256-bit values, kept in memory, and expire after 12 hours.
- Invitation secrets are stored as SHA-256 hashes rather than reusable plaintext.
- WebSocket compression is disabled to reduce compression side-channel exposure.
- Message payloads are capped, file payloads are capped, and socket actions are rate-limited.
- Renderer code has no Node.js access. Electron runs with `contextIsolation`, disabled `nodeIntegration`, a restrictive Content Security Policy, denied permission requests, and a narrow preload bridge.

See [Security Manual](docs/SECURITY_MANUAL.md), [Architecture](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md) for the threat model, limitations, deployment checklist, and vulnerability reporting process.

## Installation

### Method 1: Release installer

Download the installer for the operating system from [GitHub Releases](https://github.com/YanagiKH/Localium/releases):

- Windows: NSIS installer or portable executable
- macOS: DMG or ZIP
- Linux: AppImage or `tar.gz`

Release files produced by this repository are not code-signed unless the release workflow is supplied with organization signing credentials. Verify the release checksum and repository origin before distribution.

### Method 2: Run from source

Requirements: Node.js 22.12 or newer, npm 10 or newer, and a supported desktop operating system.

```bash
git clone https://github.com/YanagiKH/Localium.git
cd Localium
npm install
npm run dev
```

### Method 3: Build a local unpacked application

```bash
npm install
npm run package
```

The unpacked application is written to `release/`. This is useful for internal testing and managed software deployment.

### Method 4: Build platform installers

```bash
npm install
npm run dist
```

Installer generation must run on the target operating system. The GitHub release workflow builds Windows, macOS, and Linux assets on native runners.

Detailed deployment information is available in [Installation and Deployment](docs/INSTALLATION.md).

## First server

1. Open Localium and select **Create server**.
2. Enter the server name, your display name, and a listening port. The default is `9473`.
3. Open **Administration** and create a 15-minute or permanent invitation.
4. Send the invitation through a trusted channel.
5. The joining device submits a signed pending request.
6. Review the device name and approve or reject it.
7. On approval, the administrator's client seals the room key to the joining device's X25519 public key.
8. The approved device reconnects, decrypts the room key locally, and can access encrypted content.

## Networking

Localium listens on `0.0.0.0` and advertises the first non-loopback IPv4 address. Set `LOCALIUM_ADVERTISED_HOST` before launch when clients must use a VPN hostname or a stable private DNS name. For a local school or office network:

- Allow inbound TCP traffic only for the selected Localium port.
- Restrict the firewall rule to the trusted subnet.
- Do not expose the port directly to the public internet.
- For remote access, use an organization-controlled VPN or private overlay network.
- Keep the host online while members need access.
- Treat invitation codes as secrets even though administrator approval is still required.

## Data locations

| Platform | Default application data root |
| --- | --- |
| Windows | `%APPDATA%\Localium` |
| macOS | `~/Library/Application Support/Localium` |
| Linux | `~/.config/Localium` |

Each hosted server has `servers/<server-id>/server-state.json`, `assets/`, `tls/`, and optional `logs/`. The client vault is stored as `client-vault.bin` and encrypted through the OS secure-storage facility. On Linux, Localium refuses to start when Electron reports the insecure `basic_text` backend; GNOME Keyring, KWallet, or another supported secret service must be available.

## Debug mode

Start the development application with informational server logging enabled:

```bash
LOCALIUM_DEBUG=1 npm run dev
```

PowerShell:

```powershell
$env:LOCALIUM_DEBUG = "1"
npm run dev
```

Use **Debug log** in the application to inspect the active server log. Logs deliberately exclude invitation secrets, room keys, private keys, session tokens, plaintext messages, and plaintext file names. See [Debugging Manual](docs/DEBUGGING.md).

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run package
npm audit --omit=dev --audit-level=high
```

GitHub Actions runs repository linting, TypeScript checks, cryptographic and server integration tests, renderer/main builds, production dependency auditing, cross-platform unpacked packaging, and CodeQL analysis.

## Current limitations

- Localium currently uses one shared room key per server. Removing a member blocks future server access but does not erase ciphertext or keys the member already possessed. Automatic versioned room-key rotation and forward-secret sender chains are not implemented in version `0.1.0`.
- A compromised approved endpoint can read content available to that endpoint.
- The server observes operational metadata including device identifiers, timestamps, ciphertext sizes, membership, roles, and network addresses.
- The built-in server is designed for small and medium private groups. It has not been load-tested for very large public communities.
- High-availability clustering and external database replication are not included.
- Release signing requires administrator-provided platform certificates.

## Documentation

- [Installation and Deployment](docs/INSTALLATION.md)
- [Security Manual](docs/SECURITY_MANUAL.md)
- [Debugging Manual](docs/DEBUGGING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Vulnerability Reporting](SECURITY.md)
- [Chinese README](README_ZH.md)
- [Japanese README](README_JP.md)

## License

Localium is released under the [MIT License](LICENSE).
