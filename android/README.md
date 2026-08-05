# Localium Android client

The Android target reuses the same React renderer, cryptographic code, invitation format, approval flow, messages, files, stickers, avatars, backgrounds, administration permissions, and slash commands as the desktop client.

Android is intentionally join-only. The native bridge rejects server creation and never starts the Localium host process.

## Build

```bash
npm install
npm run build:renderer
gradle -p android assembleDebug
```

The APK is generated under `android/app/build/outputs/apk/`. Android 10 or later is required. The device vault is encrypted with an AES-256-GCM key held by Android Keystore. Downloads are written to `Downloads/Localium`.
