# Nautilus TEE reference template

This directory contains MemWal-specific starting files for running the relayer
inside a Nautilus TEE. The canonical operator guide is
`docs/relayer/nautilus-tee.md`.

Files:

- `nautilus.toml.example` - reference manifest values to adapt for your Nautilus version.
- `runtime.env.example` - runtime variables and secrets used by the existing relayer.

Deployment checklist:

1. Build the relayer image from `services/server/Dockerfile`.
2. Copy `nautilus.toml.example` to your Nautilus manifest and replace object IDs.
3. Copy `runtime.env.example` into your secret store, fill real values, and inject it at runtime.
4. Allow outbound access only to the exact PostgreSQL, Redis, Sui, Walrus, SEAL, and AI endpoints you configure.
5. Pin and publish the Nautilus image measurement produced by your build.
6. Run `/health` plus the remember/recall smoke test from the docs.

Do not commit filled runtime env files or private keys.
