/**
 * LIVE check for the credential-replacement warning (GH #628 / WALM-361).
 *
 * Opt-in, excluded from `npm test` by the `.live.mjs` suffix.
 *
 * The unit tests cover `formatReplacementNotice` and `saveCreds` in isolation.
 * What they cannot show is that the shipped binary actually prints the notice:
 * the wiring in `login.ts` is only reached by a real login. This drives the
 * real `memwal-mcp login` process end to end — its own localhost listener, its
 * own preflight validation, its own callback parsing, its own `saveCreds` — and
 * asserts on what the process really wrote to the terminal.
 *
 * The browser half is driven programmatically (the same POSTs the web app
 * makes), so no wallet approval and no on-chain delegate registration. The
 * credentials being *replaced* are seeded locally with a different accountId,
 * which is all the notice keys off.
 *
 * Usage:
 *   node test/live/credential-replacement.live.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    rmSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../dist/bin/memwal-mcp.js");

const OUTGOING_ACCOUNT = "0x" + "a".repeat(64);
const INCOMING_ACCOUNT = "0x" + "b".repeat(64);
const WALLET = "0x" + "7".repeat(64);
const PACKAGE = "0x" + "8".repeat(64);

const home = realpathSync(mkdtempSync(join(tmpdir(), "memwal-replace-live-")));
const credsPath = join(home, ".memwal", "credentials.json");
mkdirSync(dirname(credsPath), { recursive: true });
writeFileSync(
    credsPath,
    JSON.stringify({
        delegatePrivateKey: "c".repeat(64),
        delegatePublicKeyHex: "d".repeat(64),
        delegateAddress: "0x" + "e".repeat(64),
        walletAddress: WALLET,
        accountId: OUTGOING_ACCOUNT,
        packageId: PACKAGE,
        relayerUrl: "https://relayer.dev.memwal.ai",
        label: "Outgoing account",
        createdAt: new Date(0).toISOString(),
        version: 1,
    }),
    { mode: 0o600 },
);

console.log(`sandbox HOME: ${home}`);
console.log(`outgoing:     ${OUTGOING_ACCOUNT}`);
console.log(`incoming:     ${INCOMING_ACCOUNT}\n`);

// `script` allocates a pty: without a TTY the CLI serves MCP stdio mode instead
// of running the interactive login.
const child = spawn(
    "script",
    ["-q", "/dev/null", process.execPath, BIN, "login", "--dev", "--label", "Replacement Live"],
    {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        // stdin inherited, not piped: `script` needs a real terminal to
        // allocate a pty ("tcgetattr/ioctl: Operation not supported on socket"
        // otherwise), and the CLI only runs the interactive login when
        // `process.stdin.isTTY`.
        stdio: ["inherit", "pipe", "pipe"],
    },
);

let out = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (out += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForConnectUrl(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const m = out.match(/https:\/\/dev\.memwal\.ai\/connect\/mcp\?[^\s]+/);
        if (m) return m[0].replace(/\r/g, "");
        await sleep(200);
    }
    throw new Error(`no connect URL\n--- output ---\n${out}`);
}

let failures = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`  PASS  ${label}`);
    } catch (err) {
        failures += 1;
        console.log(`  FAIL  ${label}\n        ${err.message}`);
    }
}

try {
    const connectUrl = await waitForConnectUrl();
    const url = new URL(connectUrl);
    const base = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const headers = { origin: url.origin, "content-type": "application/json" };

    const preflight = await fetch(`${base}/preflight`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            state: url.searchParams.get("connectState"),
            publicKey: url.searchParams.get("publicKey"),
            relayer: url.searchParams.get("relayer"),
        }),
    });
    check("the real listener accepts a valid preflight", () =>
        assert.equal(preflight.status, 200),
    );

    const callback = await fetch(`${base}/callback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            state: url.searchParams.get("connectState"),
            accountId: INCOMING_ACCOUNT,
            walletAddress: WALLET,
            packageId: PACKAGE,
        }),
    });
    const successPage = await callback.text();
    check("the callback is accepted", () => assert.equal(callback.status, 200));

    // The bug this guards: the page used to hardcode ~/.memwal/credentials.json.
    check("the success page names the file actually written", () =>
        assert.ok(
            successPage.includes(credsPath),
            `page did not mention ${credsPath}`,
        ),
    );

    await sleep(1500);

    check("the process warned that a DIFFERENT account was replaced", () =>
        assert.match(out, /Replaced credentials for a DIFFERENT account/),
    );
    check("the warning names the outgoing account", () =>
        assert.ok(out.includes(OUTGOING_ACCOUNT), "outgoing account id missing from output"),
    );
    check("the warning names the incoming account", () =>
        assert.ok(out.includes(INCOMING_ACCOUNT), "incoming account id missing from output"),
    );

    const dir = join(home, ".memwal");
    const backups = readdirSync(dir).filter((f) => f.startsWith("credentials.backup"));
    check("a backup of the replaced credentials exists on disk", () =>
        assert.equal(backups.length, 1, `saw: ${backups.join(", ") || "none"}`),
    );
    check("the backup holds the OUTGOING account", () =>
        assert.equal(
            JSON.parse(readFileSync(join(dir, backups[0]), "utf8")).accountId,
            OUTGOING_ACCOUNT,
        ),
    );
    check("the live file now holds the INCOMING account", () =>
        assert.equal(JSON.parse(readFileSync(credsPath, "utf8")).accountId, INCOMING_ACCOUNT),
    );
    check("the warning points at the backup that exists", () =>
        assert.ok(out.includes(backups[0]), `output did not name ${backups[0]}`),
    );
} finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nLIVE CHECK PASSED" : `\nLIVE CHECK FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
