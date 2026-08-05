# Installation and Deployment

## Supported targets

- Windows 10/11 x64
- Current macOS releases supported by the selected Electron version
- Mainstream x64 Linux desktop distributions with an available system keyring

Node.js 22.12 or newer and npm 10 are required only for source builds.

## Release installation

1. Open the repository Releases page.
2. Download the artifact matching the operating system.
3. Verify that the file came from `YanagiKH/Localium`.
4. Verify checksums when provided by the release.
5. Install or extract the application.
6. Review local firewall prompts before allowing access.

Unsigned builds may display operating-system warnings. Production organizations should configure platform signing in their controlled release pipeline.

## Source development

```bash
git clone https://github.com/YanagiKH/Localium.git
cd Localium
npm install
npm run dev
```

The development command starts Vite, the TypeScript main/preload compiler, and Electron together.

## Build and package

```bash
npm run verify
npm run package
```

`npm run package` creates an unpacked application for the current operating system.

```bash
npm run dist
```

`npm run dist` creates configured installers for the current operating system.

## Managed organization deployment

1. Build on trusted, isolated runners.
2. Pin the release commit or signed tag.
3. Run lint, typecheck, tests, build, production dependency audit, and CodeQL.
4. Sign Windows and macOS artifacts with organization credentials.
5. Publish checksums with the release.
6. Distribute through the organization's normal software-management platform.
7. Apply firewall policy centrally.
8. Document the designated Localium server owners and recovery contacts.

## Firewall

The default port is TCP `9473`. A host may choose another unprivileged TCP port. Set `LOCALIUM_ADVERTISED_HOST` before launch when invitations must advertise a stable VPN hostname or private DNS name instead of the automatically selected LAN address.

Recommended rule:

- Direction: inbound
- Protocol: TCP
- Local port: configured Localium port
- Remote scope: trusted LAN or VPN subnet only
- Program scope: Localium executable where supported
- Public profile: blocked

## Remote connectivity

Do not expose Localium directly to the public internet. Use a private network under organization control, such as a managed VPN. The invitation endpoint must resolve to the host from the joining device.

## Backup

Stop the application before taking a consistent server backup. Back up the complete server directory and protect it with full-volume or archive encryption. A server backup alone cannot decrypt chat content; an approved client vault is also required.

## Upgrade

1. Back up the hosted server directories.
2. Record the current version and server certificate fingerprints.
3. Install the new version.
4. Start each hosted server.
5. Confirm the fingerprint remains unchanged.
6. Run a test message and encrypted-file transfer.
7. Review pending memberships and active invitations.

Never overwrite the `tls/` directory unless intentionally replacing the server identity and redistributing fresh invitations.

## Linux keyring requirement

Localium will not store the client vault when Electron selects the `basic_text` password backend. Install and unlock GNOME Keyring, KWallet, or another supported Secret Service implementation before launching the application. This refusal is intentional and must not be bypassed for production use.


## Android client

Android 10 or later can install the APK produced by CI or a tagged release. Android is join-only: create and host operations are not included. Distribute APKs through an organization-controlled channel, verify their SHA-256 checksum, and use Android application signing before broad production distribution.

For a local build:

```bash
npm install
npm run build:renderer
gradle -p android assembleDebug
```
