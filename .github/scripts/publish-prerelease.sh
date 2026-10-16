#!/usr/bin/env bash
# Publish the next ${base}-${channel}.N build.
# A previous run can stage a version before `npm view` lists it. Retrying the
# same number then fails with "Cannot publish over previously staged version".
set -euo pipefail

dir="${1:?package dir}"
name="${2:?npm package name}"
channel="${3:?dev or rc}"

base="$(node -p "require('./${dir}/package.json').version")"
latest="$(
  npm view "$name" versions --json 2>/dev/null \
    | node -e '
        const fs = require("fs");
        const raw = fs.readFileSync(0, "utf8").trim();
        const versions = raw ? JSON.parse(raw) : [];
        const list = Array.isArray(versions) ? versions : [versions];
        const prefix = process.argv[1] + "-" + process.argv[2] + ".";
        const nums = list
          .filter((v) => typeof v === "string" && v.startsWith(prefix))
          .map((v) => Number(v.slice(prefix.length)))
          .filter((n) => Number.isInteger(n));
        console.log(nums.length ? Math.max(...nums) : -1);
      ' "$base" "$channel" \
    || echo -1
)"
next=$((latest + 1))

cd "$dir"
for _ in 1 2 3 4 5 6; do
  version="${base}-${channel}.${next}"
  echo "Publishing ${name}@${version}"
  node -e '
    const fs = require("fs");
    const pkg = require("./package.json");
    pkg.version = process.argv[1];
    fs.writeFileSync("./package.json", JSON.stringify(pkg, null, 4) + "\n");
  ' "$version"
  set +e
  output="$(pnpm publish --tag "$channel" --provenance --access public --no-git-checks 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if printf '%s\n' "$output" | grep -q 'E409\|previously staged version'; then
    next=$((next + 1))
    continue
  fi
  exit "$status"
done

echo "gave up after staged-version collisions for ${name}" >&2
exit 1
