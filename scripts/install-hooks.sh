#!/usr/bin/env bash
# install-hooks.sh
#
# Points this repo's git at .githooks/ so local commits pass through the
# Commit Guard (no Claude/Anthropic/AI bot signatures in messages).
#
# Run once after cloning:
#   ./scripts/install-hooks.sh
#
# Re-run any time .githooks/ changes or you want to verify the wiring.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ ! -d .githooks ]; then
  echo "✖ .githooks/ directory not found at $repo_root" >&2
  exit 1
fi

chmod +x .githooks/*

current="$(git config --get core.hooksPath || true)"
if [ "$current" = ".githooks" ]; then
  echo "✓ core.hooksPath already set to .githooks"
else
  git config core.hooksPath .githooks
  echo "✓ core.hooksPath set to .githooks"
fi

echo "✓ Installed hooks: $(ls .githooks | tr '\n' ' ')"
