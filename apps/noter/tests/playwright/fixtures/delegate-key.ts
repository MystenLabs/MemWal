/**
 * Delegate-key auth helpers.
 *
 * `connectDelegateKey` now calls `assertDelegateAccountBinding` (see
 * package/feature/auth/lib/delegate-account.ts), which verifies the derived
 * public key is registered on the claimed account — on real chain data
 * outside tests, and against package/feature/auth/lib/delegate-account.mock.ts's
 * fixture pool when isTestEnvironment is set (playwright.config.ts passes
 * PLAYWRIGHT=True to the webServer). A random, never-registered key/account
 * pair is no longer enough to reach an authenticated session, so this pulls
 * from that same fixture pool instead of generating throwaway credentials.
 *
 * The pool (24 entries) exists because noter's specs authenticate a fresh
 * identity per test — with `workers: 2` and ~15 login call sites, two fixed
 * identities (researcher's pattern) would have tests colliding on each
 * other's notes. Generation must match delegate-account.mock.ts exactly:
 * index N → accountId byte `N` repeated, privateKey byte `N + 0x40`
 * repeated — keep both in sync.
 *
 * A fixture key is NOT enough to write to Walrus Memory: isTestEnvironment
 * is unconditionally true for every Playwright run, so the binding check
 * only ever consults the fixture pool — a real, on-chain-registered key
 * would fail at login before reaching the relayer. There's no live-write
 * path in this suite by design; see the note in e2e/memory.test.ts.
 */
import { test, type Page } from "@playwright/test";

export type DelegateCredentials = {
  privateKey: string;
  accountId: string;
};

const FIXTURE_COUNT = 24;

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function fixtureAt(i: number): DelegateCredentials {
  return {
    accountId: `0x${hex2(i).repeat(32)}`,
    privateKey: hex2(i + 0x40).repeat(32),
  };
}

// Module-scoped counter, one instance per Playwright worker PROCESS (workers:
// 2 spawns separate processes, not just separate async contexts — a plain
// counter alone would restart at 0 in each, so two workers' first calls would
// both claim fixture 0). Interleave by test.info().parallelIndex so worker 0
// claims 0, 2, 4, ... and worker 1 claims 1, 3, 5, ... — every call across
// every worker gets a distinct fixture, with no fixed per-worker range to
// exhaust. Wraps at FIXTURE_COUNT if a run needs more logins than the pool
// has — bump FIXTURE_COUNT (and the matching constant in
// delegate-account.mock.ts) if that ever fires for real.
let localCallCount = 0;

/** A never-yet-used fixture identity from the pool this test run owns exclusively. */
export function nextDelegateCredentials(): DelegateCredentials {
  const parallelIndex = test.info().parallelIndex;
  const workerCount = test.info().config.workers;
  const i = (localCallCount * workerCount + parallelIndex) % FIXTURE_COUNT;
  localCallCount += 1;
  return fixtureAt(i);
}

/** Open the collapsed "Sign in with delegate key" form on the landing page. */
export async function openDelegateKeyForm(page: Page): Promise<void> {
  await page.getByRole("button", { name: /sign in with delegate key/i }).click();
  await page.getByPlaceholder(/private key/i).waitFor({ state: "visible" });
}

/**
 * Drive the real login UI end to end and land on /note.
 * Returns the credentials used so the caller can reuse them.
 */
export async function signInWithDelegateKey(
  page: Page,
  credentials: DelegateCredentials = nextDelegateCredentials(),
): Promise<DelegateCredentials> {
  await page.goto("/");
  await openDelegateKeyForm(page);

  await page.getByPlaceholder(/account id/i).fill(credentials.accountId);
  await page.getByPlaceholder(/private key/i).fill(credentials.privateKey);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  // The form hard-navigates with window.location.href = "/note"; wait for that
  // full page load to land. If the sessionAtom-hydration regression (guarded
  // by auth.test.ts) ever comes back, this — and every test that depends on
  // it — fails loudly instead of silently working around the bounce.
  await page.waitForURL(/\/note(\/|$)/);
  return credentials;
}

/** Cold-load the notes route. Use instead of page.reload() when a test needs to be on /note afterwards. */
export async function gotoNotes(page: Page): Promise<void> {
  await page.goto("/note");
}

/**
 * Read the session id the app persists for tRPC's `x-session-id` header.
 * Jotai's atomWithStorage may wrap the payload under `value`.
 */
export async function readSessionId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem("zklogin:session:id");
    if (!raw) return null;
    try {
      const outer = JSON.parse(raw);
      return (outer?.value ?? outer)?.sessionId ?? null;
    } catch {
      return null;
    }
  });
}
