# Localium Security Manual

This document defines the security model for Localium `0.1.0`, the assumptions required for safe deployment, and the operational controls expected from schools, companies, laboratories, and other organizations.

## 1. Security goals

Localium is designed to provide the following properties:

1. **Content confidentiality in transit and at rest on the server.** Message bodies, file names, file bytes, sticker selections, and background assets are encrypted before they leave an approved client.
2. **Authenticated devices.** Every device owns an Ed25519 signing key and must sign a fresh server challenge.
3. **Explicit membership approval.** An invitation never grants immediate access. An authorized administrator must approve the request and encrypt the room key to the joining device.
4. **Server identity pinning.** Invitation codes include the server certificate's SHA-256 fingerprint. The desktop client only bypasses the expected self-signed certificate warning when the fingerprint matches a trusted invitation or a server hosted by the same Localium installation.
5. **Least-privilege administration.** Server permissions are assigned through roles rather than a single unrestricted administrator flag.
6. **No required third-party content service.** Localium does not send chat content to analytics platforms, hosted databases, push providers, or external moderation services.

Localium does **not** claim absolute security. A compromised endpoint, malicious approved administrator, unsafe backup, publicly exposed port, or vulnerable operating system can defeat the intended protections.

## 2. Cryptographic design

### 2.1 Device identity

Each Localium installation creates two independent key pairs:

- **Ed25519 signing key pair** for challenge-response device authentication.
- **X25519 encryption key pair** for receiving a sealed copy of the server room key.

The device identifier is derived from a generic hash of the Ed25519 public key. Private keys are stored in the client vault, which is encrypted with Electron `safeStorage` and therefore delegated to the operating system's secure credential mechanism. On Linux, Localium rejects Electron's `basic_text` backend rather than silently storing a vault under a hardcoded fallback password.

### 2.2 Room-key delivery

The server room key is generated on the owner's client. The server stores only a sealed room-key record for each approved member. When a new device is approved, the approving client encrypts the room key with `crypto_box_seal` to the pending device's X25519 public key.

The server process handles the sealed ciphertext but does not receive the plaintext room key through its protocol or persisted state.

### 2.3 Message encryption

Message payloads use:

- XChaCha20-Poly1305-IETF
- A random 192-bit nonce per message
- A 256-bit room key
- Associated data containing the exact message identifier context; the server and clients reject mismatched bindings

The authenticated encryption tag detects modification, truncation, wrong-key use, and associated-data mismatch.

### 2.4 File and image encryption

Files, custom stickers, and server backgrounds are encrypted as binary XChaCha20-Poly1305 payloads before upload. The server assigns an opaque asset identifier and stores only ciphertext.

Operational limits:

- Plaintext file limit: 25 MiB
- Ciphertext overhead allowance: 128 bytes
- Message ciphertext limit: 256 KiB

### 2.5 TLS

Each hosted server creates a local self-signed certificate with a 3072-bit RSA key and SHA-256 signature. The certificate and private key are stored with restrictive filesystem permissions where the platform supports them.

TLS protects:

- WebSocket authentication and control traffic
- Session tokens
- Encrypted message envelopes
- Encrypted asset uploads and downloads
- Membership and role metadata in transit

TLS certificate fingerprint pinning prevents a generic self-signed certificate from being silently accepted.

### 2.6 Sessions

After successful device-signature authentication, the server creates a random 256-bit bearer token:

- Stored only in server memory
- Returned only over pinned TLS
- Expires after 12 hours
- Invalidated when the process exits
- Rejected when the associated member is revoked

### 2.7 Invitation protection

Invitation codes contain the connection endpoint, server identity, server certificate fingerprint, invitation identifier, random secret, and expiry. The persisted server state stores only the SHA-256 hash of the complete invitation secret.

Temporary codes expire after 15 minutes. Permanent invitations remain active until revoked. Both still require administrator approval.

## 3. Authorization model

Built-in roles:

- **Owner:** all permissions; cannot be removed.
- **Administrator:** all current permissions; can be removed or reassigned by an authorized member.
- **Member:** send messages and files.

Available permissions:

- `manage_server`
- `manage_invites`
- `approve_members`
- `manage_members`
- `manage_roles`
- `manage_stickers`
- `send_messages`
- `send_files`
- `view_audit`

Custom roles can combine any subset. Server-side permission checks are authoritative; hiding a button in the UI is not treated as an authorization control.

## 4. Threat model

### Protected against

- Passive network observers reading message or file content
- An unapproved device attempting to use an invitation directly
- A generic man-in-the-middle certificate substituted for the invited server
- Modification of encrypted message and file payloads
- Reuse of a device identifier without the matching Ed25519 private key
- Database or asset-directory disclosure without an approved client key
- Accidental privilege use when a role lacks the server-side permission
- Simple socket flooding beyond the configured per-minute action rate

### Not fully protected against

- Malware, remote-control software, keyloggers, screen capture, or memory scraping on an approved endpoint
- A malicious approved member taking screenshots or exporting decrypted files
- A malicious administrator approving an unauthorized device
- The host deleting, withholding, replaying, or reordering ciphertext
- Traffic analysis based on timestamps, IP addresses, device identifiers, ciphertext sizes, and membership activity
- Denial-of-service attacks against the host or network
- Compromise of the host's TLS private key combined with an approved client compromise
- Old content retained by a member before removal

## 5. Key-rotation and forward-secrecy limitation

Version `0.1.0` uses one shared room key per server. Removing a member prevents future authenticated downloads and message delivery, but it cannot erase data already copied to that member's device. Automatic versioned room-key rotation, sender-key ratchets, and forward-secret message chains are not included.

For high-sensitivity deployments, administrators should create a new server and migrate approved members after a suspected room-key compromise.

## 6. Metadata visible to the server

The server can observe and store:

- Device identifiers and public keys
- Display names
- Roles and permissions
- Join, approval, removal, and invite events
- Timestamps
- Ciphertext sizes
- Asset types (`attachment`, `sticker`, or `background`)
- Network source addresses available to the host operating system

The encrypted message payload contains the plaintext message kind, text, original file name, MIME hint, file size, and sticker identifier, so those fields are not stored in server-readable form.

## 7. Production deployment checklist

### Host

- Use a supported, fully patched operating system.
- Use a dedicated non-administrator OS account for routine Localium hosting.
- Enable full-disk encryption.
- Protect the OS login with a strong password and MFA where supported.
- Disable sleep while the server must remain available.
- Restrict physical access to the host.
- Back up the Localium data directory only to encrypted organization-controlled storage.

### Network

- Restrict the selected TCP port to the trusted subnet.
- Do not forward the port directly from a public router.
- Use an organization-controlled VPN for remote access.
- Segment sensitive departments when possible.
- Monitor repeated rejected connections at the firewall.

### Membership

- Verify joining users through a second channel before approval.
- Use temporary invitations unless a permanent code is operationally required.
- Revoke permanent codes after the onboarding period.
- Assign the minimum required role.
- Review the audit panel regularly.
- Remove lost, replaced, or decommissioned devices immediately.

### Endpoint

- Keep the OS and Localium updated.
- Use endpoint protection appropriate for the organization.
- Do not install untrusted Electron extensions or debugging tools on production endpoints.
- Lock the screen when unattended.
- Do not copy the Localium vault between users.

## 8. Backup and restoration

A complete hosted-server backup includes:

- `server-state.json`
- `assets/`
- `tls/`
- `host-config.json`

The server backup does not contain the plaintext room key. At least one approved client vault is required to decrypt messages and files after restoration.

Protect client-vault backups carefully. A client vault contains device private keys and room keys, although the vault file is encrypted using OS secure storage and may not be portable to another OS account or machine.

Recommended procedure:

1. Stop the Localium server.
2. Copy the server directory to encrypted backup storage.
3. Record the server identifier and expected certificate fingerprint.
4. Restore only to a trusted host.
5. Verify permissions on restored files.
6. Start the server and verify the pinned fingerprint before approving new devices.

## 9. Incident response

### Suspected lost or stolen client

1. Remove the member/device from Administration.
2. Revoke active invitations.
3. Review recent audit events.
4. Assume content already decrypted on that device may be exposed.
5. For high-impact exposure, create a replacement server and migrate only verified devices.

### Suspected host compromise

1. Disconnect the host from the network.
2. Preserve logs and system evidence according to organization policy.
3. Treat TLS keys, metadata, ciphertext, invitation hashes, and server configuration as exposed.
4. Create a new server on a clean host.
5. Distribute a new invitation through an authenticated channel.
6. Do not reuse the old TLS directory.

### Certificate mismatch

Never bypass the mismatch manually. Confirm the invitation through a second channel and compare the fingerprint with the host. A changed fingerprint can indicate a rebuilt server, restored TLS directory problem, wrong IP address, or active interception.

## 10. Security validation

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

The repository also includes CodeQL analysis and cryptographic/server integration tests. These controls reduce risk but are not a substitute for an independent security audit before high-risk deployment.


## Android client controls

Android private device material is encrypted with AES-256-GCM under a non-exportable Android Keystore key. The Android application disables cleartext traffic and accepts a self-signed Localium endpoint only when its SHA-256 certificate fingerprint matches a fingerprint trusted from an invitation. Android clients cannot create or run a Localium server.

The Android build uses a bundled renderer rather than loading application code from a remote website. The JavaScript bridge is exposed only to that bundled interface, and navigation away from the application origin is blocked.

## Server mod controls

Localium mods are declarative JSON, not executable JavaScript, native libraries, or shell commands. Files are size-limited; module ids, command names, templates, and permissions are validated; duplicate commands reject the reload atomically. This design intentionally does not provide arbitrary plugin code execution.

Slash command names and arguments are sent through the pinned TLS channel to the self-hosted server so it can enforce permissions and render the configured response. The response is then end-to-end encrypted by the client before posting. Administrators must document this metadata boundary and must not instruct users to place secrets in command arguments.
