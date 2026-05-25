# TEE reference template

This directory contains Walrus Memory-specific starting files for running the relayer
with a TEE deployment pattern. The canonical operator guide is
`docs/relayer/nautilus-tee.md`.

This is not a complete Sui Nautilus application by itself. It provides the
relayer image wrapper, runtime env template, and manifest values that an
operator can adapt to their Nautilus toolchain. A complete Nautilus deployment
must also verify the enclave measurement or attestation identity through the
client, gateway, or Sui/Move verification path used by that deployment.

Files:

- `Containerfile` - TEE wrapper image that adds the runtime entrypoint.
- `Makefile` - local build, run, and health-smoke helpers.
- `run.sh` - enclave/container entrypoint with required-env validation.
- `host-forwarder.sh` - optional host-side VSOCK bridge helper for Nitro-style deployments.
- `nautilus.toml.example` - reference manifest values to adapt for your Nautilus version.
- `runtime.env.example` - runtime variables and secrets used by the existing relayer.

Local image build:

```bash
make -C services/server/deploy/nautilus build
```

Local container smoke run, using a filled env file:

```bash
make -C services/server/deploy/nautilus run-local ENV_FILE=.env.nautilus
make -C services/server/deploy/nautilus smoke RELAYER_URL=http://127.0.0.1:8000
```

Deployment checklist:

1. Copy `runtime.env.example` to a private env file, fill real values, and store it in Nautilus/CI secrets.
2. Generate a strong `SIDECAR_AUTH_TOKEN`; both the Rust relayer and sidecar read the same env var.
3. Build the wrapper image with `make -C services/server/deploy/nautilus build`.
4. Copy `nautilus.toml.example` to your Nautilus manifest and replace package/object IDs.
5. Allow outbound access only to the exact PostgreSQL, Redis, Sui, Walrus, SEAL, and AI endpoints you configure.
6. Keep `BENCHMARK_MODE=false`; benchmark mode bypasses SEAL/Walrus persistence.
7. Use your Nautilus toolchain/provider to build and deploy the enclave artifact.
8. Pin and publish the Nautilus image measurement or attestation identity produced by that build.
9. Require clients, gateway policy, or Move-side verification to check the expected identity before treating the endpoint as TEE-backed.
10. Run `/health` plus the remember/recall smoke test from the docs.

Local Docker smoke tests prove the image and relayer entrypoint boot. They do
not prove TEE execution or produce a Nautilus attestation.

Do not commit filled runtime env files or private keys.
