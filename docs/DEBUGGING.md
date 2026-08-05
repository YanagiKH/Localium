# Localium Debugging Manual

This manual covers development logs, common startup failures, network diagnosis, safe diagnostic collection, and CI reproduction.

## 1. Enable debug mode

Linux and macOS:

```bash
LOCALIUM_DEBUG=1 npm run dev
```

PowerShell:

```powershell
$env:LOCALIUM_DEBUG = "1"
npm run dev
```

Command Prompt:

```bat
set LOCALIUM_DEBUG=1
npm run dev
```

Debug mode adds informational JSON-line server events. Warning and error events are logged regardless of debug mode.

## 2. Log locations

| Platform | Typical log path |
| --- | --- |
| Windows | `%APPDATA%\Localium\servers\<server-id>\logs\localium.log` |
| macOS | `~/Library/Application Support/Localium/servers/<server-id>/logs/localium.log` |
| Linux | `~/.config/Localium/servers/<server-id>/logs/localium.log` |

The **Debug log** button opens the current hosted server log inside the application.

Logs exclude:

- Private keys
- Room keys
- Invitation secrets
- Session tokens
- Plaintext messages
- Plaintext file names
- Plaintext file content

Do not attach the full application data directory to a public issue.

## 3. Validation commands

Run the same sequence used by CI:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run package
npm audit --omit=dev --audit-level=high
```

To run one test file:

```bash
npx vitest run tests/server.test.ts
```

## 4. Application does not start

### `npm install` fails

- Confirm Node.js is version 22 or newer: `node --version`.
- Confirm npm is version 10 or newer: `npm --version`.
- Remove a partially installed `node_modules` directory and run `npm install` again.
- Check proxy and private-registry configuration.
- Do not disable TLS verification to work around registry errors.

### Blank Electron window

- Run with `LOCALIUM_DEBUG=1 npm run dev`.
- Check the terminal for Vite or preload compilation errors.
- Run `npm run build` to verify both renderer and main-process output.
- Confirm `dist/main/index.js`, `dist/preload/index.js`, and `dist/renderer/index.html` exist after the build.

### OS secure storage unavailable

Localium refuses to persist private keys when Electron `safeStorage` is unavailable.

- Unlock the OS keychain.
- On Linux, ensure a supported secret-service/keyring implementation is running. If Electron selects `basic_text`, Localium refuses to save or load the client vault.
- Avoid launching the desktop app under a different user or a stripped-down service account without a keyring.
- Do not replace this protection with plaintext vault storage.

## 5. Server creation fails

### Port already in use

Symptoms include `EADDRINUSE` or immediate server startup failure.

- Select another port in the Create Server form.
- Check the current listener:
  - Windows: `netstat -ano | findstr :9473`
  - Linux: `ss -ltnp | grep 9473`
  - macOS: `lsof -nP -iTCP:9473 -sTCP:LISTEN`
- Stop the conflicting process only after identifying it.

### Permission denied

Ports below 1024 may require elevated privileges on Unix-like systems. Use an unprivileged port such as `9473`. Do not run Localium as root solely to bind a low port.

### Server starts but other devices cannot connect

- Confirm the invitation contains the correct LAN address. For VPN or private DNS deployments, set `LOCALIUM_ADVERTISED_HOST` before starting the server and create a new invitation.
- Confirm both devices are on the same trusted network or VPN.
- Allow inbound TCP traffic for the selected port.
- Restrict the firewall rule to the trusted subnet.
- Confirm client isolation is not enabled on the Wi-Fi network.
- Confirm the host has not changed networks after creating the invitation.

## 6. Certificate mismatch

A mismatch is a security failure, not a routine warning.

- Stop and verify the invitation fingerprint with the server owner.
- Confirm the IP and port identify the intended host.
- If the server was reinstalled or the `tls/` directory was replaced, create a new invitation from the trusted host.
- Never add a global certificate bypass.

## 7. Join request stays pending

- Keep the joining Localium window open.
- Confirm an online owner or authorized administrator has `approve_members`.
- Open Administration and inspect **Pending approvals**.
- If the requester was offline during approval, entering the same invitation again causes the server to return the already-approved sealed room key after device-signature verification.
- If the request was rejected, submit a new request only after confirming the reason with an administrator.

## 8. Message cannot be decrypted

Possible causes:

- The saved room key belongs to another server.
- The client vault was restored under an incompatible OS account.
- The encrypted record is damaged.
- The server state and client vault were restored from different backup points.

Do not delete the server state before preserving a backup. Record the server ID, message ID, client OS, and relevant non-secret log lines.

## 9. File transfer failure

- The plaintext file limit is 25 MiB.
- Confirm the role has `send_files`.
- Check free disk space on the host and receiving device.
- Confirm the session has not expired.
- Reconnect to obtain a new session token.
- Verify the firewall or reverse proxy is not enforcing a smaller request limit.

The server stores an encrypted binary blob. File names are inside the encrypted message payload and therefore absent from server logs.

## 10. Packaging issues

### Windows

- Run packaging on Windows for NSIS and portable targets.
- Unsigned builds may trigger SmartScreen.
- Configure an organization code-signing certificate for trusted production distribution.

### macOS

- Run packaging on macOS for DMG and ZIP targets.
- Unsigned/unnotarized builds may be blocked by Gatekeeper.
- Configure Apple signing and notarization credentials in the release environment.

### Linux

- AppImage and `tar.gz` builds run on Linux.
- An unpacked `--dir` build does not require FUSE.
- Distribution-specific sandbox policies may require additional packaging review.

## 11. Safe issue report

Include:

- Localium version or commit SHA
- Operating system and version
- Node.js and npm versions for source builds
- Exact command that failed
- Sanitized error message
- Whether the device hosted or joined the server
- Whether the failure reproduces with a new test server

Exclude:

- Invitation codes
- Server room keys
- `client-vault.bin`
- TLS private keys
- Session tokens
- Private documents
- Full `server-state.json`
