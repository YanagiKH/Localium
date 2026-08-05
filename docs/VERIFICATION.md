# Verification Record

Localium's initial implementation is verified through GitHub Actions before release or merge.

## Required checks

- Repository lint rules
- TypeScript checks for renderer, shared, preload, server, and Electron main-process code
- Cryptography, invitation, persistence, approval, messaging, and privilege-escalation regression tests
- Production renderer and desktop-process builds
- Production dependency audit at high-severity threshold
- CodeQL JavaScript and TypeScript analysis
- Unpacked Electron packaging on Windows, macOS, and Linux

## Security interpretation

A green verification run confirms that the checked source compiled, passed the included automated tests, passed the configured dependency threshold, and produced unpacked desktop applications on the supported build runners. It is not a claim that any software is free of every defect or vulnerability. Operators must also follow `SECURITY.md` and `docs/SECURITY_MANUAL.md`, protect host systems, restrict network exposure, maintain backups, and apply updates.
