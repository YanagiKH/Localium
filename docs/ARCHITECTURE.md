# Localium Architecture

## Process model

```text
Electron main process
  ├─ BrowserWindow security policy
  ├─ OS safeStorage vault operations
  ├─ Native file dialogs
  ├─ Local HTTPS/WSS server lifecycle
  └─ Certificate fingerprint trust set

Sandboxed preload
  └─ Narrow IPC bridge exposed as window.localium

React renderer
  ├─ Device identity and room-key operations through libsodium
  ├─ Invitation parsing and certificate trust request
  ├─ WebSocket protocol client
  ├─ Message/file/sticker encryption and decryption
  └─ Chat and administration UI

Local HTTPS/WSS server
  ├─ TLS endpoint and certificate identity
  ├─ Challenge-response authentication
  ├─ Invitation and approval state machine
  ├─ Role-based authorization
  ├─ Encrypted message persistence
  ├─ Encrypted asset storage
  ├─ In-memory HTTP sessions
  └─ Audit metadata
```

## Repository layout

```text
src/
  main/
    index.ts        Electron lifecycle and IPC
    server.ts       HTTPS/WSS protocol and authorization
    store.ts        Atomic JSON persistence
    security.ts     TLS material and secret hashing
  preload/
    index.ts        Context-isolated desktop bridge
  renderer/
    App.tsx         User interface and client-side crypto flow
    lib/client.ts   WebSocket and encrypted asset client
    styles.css      Responsive desktop interface
  shared/
    constants.ts    Limits and permission names
    crypto.ts       Ed25519, X25519, and XChaCha20 helpers
    desktop-api.ts  IPC bridge contracts
    invite.ts       Versioned invitation codec
    types.ts        Persisted and protocol types
tests/
  crypto.test.ts
  invite.test.ts
  store.test.ts
  server.test.ts
docs/
  images/
  ARCHITECTURE.md
  DEBUGGING.md
  INSTALLATION.md
  SECURITY_MANUAL.md
```

## Persistence

`server-state.json` is written through a serialized transaction queue. Every mutation operates on a cloned draft, writes a temporary file, and atomically renames it over the previous state. Message history is capped at 500 records and audit history at 2,000 records.

Assets are stored as opaque `<uuid>.bin` ciphertext files. Metadata records contain the asset owner, ciphertext byte length, type, and creation time.

## Protocol lifecycle

### Existing member

1. Server sends a random challenge.
2. Client signs the challenge with Ed25519.
3. Server verifies the signature against the approved member public key.
4. Server issues an in-memory bearer token.
5. Server returns membership, role, sticker, message, and sealed room-key state according to permissions.

### New member

1. Client validates and decodes the invitation.
2. Desktop trusts only the invitation certificate fingerprint.
3. Client signs the connection challenge.
4. Server validates the invitation hash, expiry, usage limit, and device identifier.
5. Server creates a pending record.
6. Authorized administrator reviews the request.
7. Administrator client seals the room key to the pending X25519 public key.
8. Server stores the approved member and sealed key.
9. Joining client opens the sealed key and saves it in the OS-protected vault.
10. Client reconnects through normal member authentication.

## Trust boundaries

- The renderer is responsible for plaintext content and cryptographic keys.
- The main process is trusted for OS vault and certificate decisions.
- The server is trusted for availability, authorization, and metadata integrity, but should not be trusted with plaintext content.
- The host operating system remains a critical trust dependency.
