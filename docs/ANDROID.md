# Android client

Localium Android provides the same join, approval, encrypted messaging, files, stickers, avatars, backgrounds, administration, roles, invitations, audit view, and slash commands as the desktop client. Android devices cannot create or host servers.

## Security

- The device identity, private keys, and saved room keys are encrypted with AES-256-GCM using a non-exportable Android Keystore key.
- Invitation certificate fingerprints are normalized and stored locally. The WebView accepts a self-signed server certificate only after its SHA-256 fingerprint has been trusted from the invitation.
- Cleartext network traffic is disabled.
- The application contains no analytics, cloud chat backend, or remote content service.
- Files are decrypted only on the device and saved under `Downloads/Localium`.

## Build and test

```bash
npm install
npm run build:renderer
gradle -p android assembleDebug
```

CI builds the APK and launches it on an API 35 x86_64 emulator. Android 10 (API 29) or later is required.


## Distribution signing

CI produces an installable debug APK for emulator and managed-device testing plus an unsigned release APK artifact. Before public or managed production distribution, sign the release APK with an organization-controlled Android signing key and keep that key stable for future updates. Never commit a private signing key or its password to this repository.
