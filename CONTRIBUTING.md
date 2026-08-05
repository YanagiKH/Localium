# Contributing to Localium

## Development setup

```bash
git clone https://github.com/YanagiKH/Localium.git
cd Localium
npm install
npm run dev
```

## Required checks

Every change must pass:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Changes affecting Electron packaging should also run `npm run package` on the affected operating system.

## Security-sensitive changes

Changes to `src/shared/crypto.ts`, `src/main/security.ts`, invitation parsing, authentication, authorization, session handling, asset access, preload IPC, or BrowserWindow settings require:

- A clear security rationale
- Negative tests
- No silent fallback to plaintext storage or unpinned certificates
- No logging of secrets or plaintext content
- Updated security documentation

Do not introduce external telemetry or cloud content processing without explicit project approval and an opt-in design.

## Code and documentation language

Source identifiers, comments, commits, pull requests, issues, and the primary README should use English. `README_ZH.md` and `README_JP.md` should preserve the same structure and technical meaning as `README.md`.

## Pull requests

Keep changes focused, describe the threat or user problem, list validation commands, and identify any deployment or compatibility impact. Do not claim a security guarantee that the implementation or tests do not establish.
