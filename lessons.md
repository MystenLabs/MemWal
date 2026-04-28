# Lessons Learned — optimization/v1

Issues encountered during the optimization branch and how they were resolved.

---

## 1. Rust: Arc moved before clone

**Error:** `error[E0382]: borrow of moved value: state`

**Cause:** `Arc<AppState>` was passed to `.with_state(state)` which consumes the value. A `.clone()` was attempted after the move.

**Fix:** Clone the Arc *before* the move: `let state_for_shutdown = state.clone();` placed before `.with_state(state)`.

**Lesson:** In Rust, `Arc::clone()` must happen before any function that takes ownership. Plan the clone order at design time, not after the compiler complains.

---

## 2. Rust: Clippy warnings treated as errors in CI

**Errors:**
- `dead_code` — structs/functions added for future use but not yet called
- `clippy::needless_as_bytes` — `text.as_bytes().len()` vs `text.len()`
- `clippy::type_complexity` — tuple with 6 elements used as function parameter
- `clippy::too_many_arguments` — function with 9 parameters
- `clippy::useless_conversion` — `.into_iter()` on a value already implementing `IntoIterator`

**Fix:** Applied targeted `#[allow(...)]` annotations where the code is intentional (dead_code for prepared APIs, too_many_arguments for existing signatures). Fixed the actual code issues (`.as_bytes().len()` → `.len()`, removed redundant `.into_iter()`).

**Lesson:** Run `cargo clippy -- -D warnings` locally before pushing. Add it to a pre-commit hook or local dev script. Clippy catches real bugs alongside style issues.

---

## 3. CI: GitHub Actions Node.js 20 deprecation

**Error:** `Node.js 20 actions are deprecated... Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026.`

**Fix:** Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at the workflow env level. Bumped the project `node-version` from 20 to 22 (current LTS).

**Lesson:** GitHub Actions deprecation warnings should be addressed proactively. Pin to LTS versions and set the Node.js 24 opt-in flag now to avoid future breakage.

---

## 4. CI: pnpm version conflict with packageManager field

**Error:** `Multiple versions of pnpm specified: version 9 in the GitHub Action config and pnpm@9.12.3 in package.json packageManager`

**Fix:** Removed the explicit `version: 9` from `pnpm/action-setup@v4`. The action auto-detects the version from `"packageManager": "pnpm@9.12.3"` in package.json.

**Lesson:** When using `pnpm/action-setup@v4` with a monorepo that has `packageManager` in package.json, do not also specify `version` in the action config. Let the action read from the source of truth.

---

## 5. CI: Turborepo builds all packages instead of just the target

**Error:** `Tasks: 4 successful, 6 total` — chatbot, noter, researcher built alongside SDK.

**Cause:** `pnpm --filter @mysten-incubation/memwal build` was intercepted by turbo's daemon. Turbo resolved the `build` task's `"dependsOn": ["^build"]` across the entire workspace graph, not just the filtered package.

**Fix:** Changed from `pnpm --filter ... build` to `turbo run build --filter=@mysten-incubation/memwal`. Turbo's own `--filter` flag properly scopes task execution to only the target package and its actual dependencies.

**Lesson:** In a Turborepo monorepo, always use `turbo run <task> --filter=<pkg>` instead of `pnpm --filter <pkg> <task>`. The pnpm filter passes through to turbo which then ignores the pnpm-level filter and runs the full dependency graph.

---

## 6. CI: Apps requiring database at build time

**Error:** chatbot/noter/researcher builds failed because their `build` scripts run `tsx lib/db/migrate` which requires `DATABASE_URL`.

**Fix:** Scoped CI to only build the SDK (no database required). Apps are deployed through separate workflows with proper environment variables.

**Lesson:** Build scripts that run database migrations should not be part of a general CI build. Either separate the migration step or use `turbo --filter` to exclude apps that need runtime services.

---

## 7. TypeScript: @types/react version mismatch

**Error:** `Module '"react"' has no exported member 'useActionState'.`

**Cause:** `apps/chatbot` had `react: 19.0.1` (runtime) but `@types/react: ^18` (type definitions). `useActionState` was introduced in React 19 and doesn't exist in the React 18 type definitions.

**Fix:** Upgraded `@types/react` from `^18` to `^19` and `@types/react-dom` from `^18` to `^19` to match the installed runtime.

**Lesson:** When upgrading React, always upgrade `@types/react` and `@types/react-dom` to the same major version. Type definition mismatches cause phantom errors that look like missing exports but are really just outdated type packages.
