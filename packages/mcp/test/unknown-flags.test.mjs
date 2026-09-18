import assert from "node:assert/strict";
import test from "node:test";

import { helpText, parseArgs } from "../dist/index.js";

// An unrecognised flag used to fall through parseArgs' default branch and
// vanish: a typo'd `--namesapce` still wrote to the relayer's "default"
// namespace with nothing on stderr to explain why. parseArgs now collects what
// it did not understand so main() can name it.

test("parseArgs collects a typo'd flag instead of dropping it", () => {
    const args = parseArgs(["--namesapce", "work"]);
    assert.deepEqual(args.unknown, ["--namesapce"]);
    // The typo must NOT have set the real namespace.
    assert.equal(args.namespace, undefined);
});

test("parseArgs reports every unknown flag, not just the first", () => {
    const args = parseArgs(["--nope", "--alsobad"]);
    assert.deepEqual(args.unknown, ["--nope", "--alsobad"]);
});

test("an unknown flag swallows its value rather than reporting it too", () => {
    // Warning once about `--namesapce` beats warning twice, the second time
    // naming the user's data. Also keeps a mistyped secret out of the logs.
    assert.deepEqual(parseArgs(["--tokenn", "hunter2"]).unknown, ["--tokenn"]);
});

test("an unknown flag does not swallow the flag that follows it", () => {
    const args = parseArgs(["--typo", "--prod"]);
    assert.deepEqual(args.unknown, ["--typo"]);
    assert.equal(args.relayerUrl, "https://relayer.memory.walrus.xyz");
});

test("a known flag after an unknown flag's value still applies", () => {
    const args = parseArgs(["--typo", "value", "--ns", "work"]);
    assert.deepEqual(args.unknown, ["--typo"]);
    assert.equal(args.namespace, "work");
});

test("an unknown flag does not swallow the `login` command", () => {
    // `login` is a command, not a value. Consuming it turned
    // `memwal-mcp --typo login` into a run that never logged in.
    const args = parseArgs(["--typo", "login"]);
    assert.deepEqual(args.unknown, ["--typo"]);
    assert.equal(args.forceLogin, true, "`login` was swallowed as a flag value");
});

test("an unknown `--key=value` flag reports the key and never the value", () => {
    // The warning goes to stderr, so a mistyped secret must not survive into it.
    const args = parseArgs(["--tokenn=hunter2"]);
    assert.deepEqual(args.unknown, ["--tokenn"]);
    assert.ok(
        !args.unknown.some((u) => u.includes("hunter2")),
        "the flag's value reached the warning",
    );
});

test("an unknown `--key=value` flag does not also swallow the next token", () => {
    // Its value is already attached, so the following token is someone else's.
    const args = parseArgs(["--tokenn=hunter2", "login"]);
    assert.deepEqual(args.unknown, ["--tokenn"]);
    assert.equal(args.forceLogin, true);
});

test("parseArgs treats no known flag as unknown", () => {
    const known = [
        "--help", "-h",
        "--logout",
        "--login", "login",
        "--prod", "--dev", "--staging", "--local",
        "--relayer", "https://r.example",
        "--relayer-url", "https://r.example",
        "--web-url", "https://w.example",
        "--web", "https://w.example",
        "--label", "my label",
        "--namespace", "ns",
        "--ns", "ns",
        "--relayer=https://r.example",
        "--web-url=https://w.example",
        "--label=my-label",
        "--namespace=ns",
        "--ns=ns",
    ];
    assert.deepEqual(parseArgs(known).unknown, []);
});

test("parseArgs does not mistake a flag's value for an unknown flag", () => {
    // `next()` consumes the value, so "MCP Client" must never be reported.
    const args = parseArgs(["--label", "MCP Client"]);
    assert.deepEqual(args.unknown, []);
    assert.equal(args.label, "MCP Client");
});

test("env presets still resolve both URLs (regression guard)", () => {
    const args = parseArgs(["--prod"]);
    assert.equal(args.relayerUrl, "https://relayer.memory.walrus.xyz");
    assert.equal(args.webUrl, "https://memory.walrus.xyz");
    assert.deepEqual(args.unknown, []);
});

// Help must list every preset the parser honours, and stay listing them as
// presets are added.

test("--help documents every network preset the parser accepts", () => {
    const help = helpText();
    for (const preset of ["--prod", "--dev", "--staging", "--local"]) {
        // Not merely mentioned somewhere — parseArgs must accept it too.
        assert.deepEqual(parseArgs([preset]).unknown, [], `${preset} not accepted`);
        assert.ok(help.includes(preset), `${preset} missing from --help`);
    }
    // The URLs a preset resolves to are what tell you which network you're on.
    assert.ok(help.includes("https://relayer.dev.memwal.ai"));
    assert.ok(help.includes("http://127.0.0.1:8000"));
});

test("--help does not promise that flag order decides a preset override", () => {
    // Preset application is `??=`, so an explicit URL wins from either side.
    // Help used to say the flag overrides "the preset it follows".
    const help = helpText();
    assert.ok(!help.includes("the preset it follows"), "help still implies order matters");
    const before = parseArgs(["--relayer", "https://custom.example", "--prod"]);
    const after = parseArgs(["--prod", "--relayer", "https://custom.example"]);
    assert.equal(before.relayerUrl, "https://custom.example");
    assert.equal(after.relayerUrl, "https://custom.example");
});

/* The project-credential trust commands.
 *
 * Both are bare words, so they share the hazard `login` already had: an unknown
 * flag ahead of one must not swallow it, or `memwal-mcp --typo trust-project`
 * silently becomes a run that adopts nothing. Both also take an OPTIONAL
 * directory, which is the new part — the parser has to tell a directory from
 * the next flag. */

test("trust-project parses as a command, with the current directory by default", () => {
    const args = parseArgs(["trust-project"]);
    assert.equal(args.trustProject, true);
    assert.equal(args.untrustProject, false);
    assert.equal(args.trustProjectDir, undefined, "no argument means cwd, decided in main()");
    assert.deepEqual(args.unknown, []);
});

test("trust-project takes an optional directory", () => {
    const args = parseArgs(["trust-project", "/home/u/code/app"]);
    assert.equal(args.trustProject, true);
    assert.equal(args.trustProjectDir, "/home/u/code/app");
});

test("untrust-project parses as its own command", () => {
    const args = parseArgs(["untrust-project", "/home/u/code/app"]);
    assert.equal(args.untrustProject, true);
    assert.equal(args.trustProject, false);
    assert.equal(args.trustProjectDir, "/home/u/code/app");
});

test("trust-project does not swallow the flag that follows it", () => {
    const args = parseArgs(["trust-project", "--dev"]);
    assert.equal(args.trustProject, true);
    assert.equal(args.trustProjectDir, undefined, "a flag is not a directory");
    assert.equal(args.relayerUrl, "https://relayer.dev.memwal.ai", "--dev must still apply");
});

test("an unknown flag does not swallow the trust-project command", () => {
    const args = parseArgs(["--typo", "trust-project"]);
    assert.deepEqual(args.unknown, ["--typo"]);
    assert.equal(args.trustProject, true, "adopting must not be silently skipped by a typo");
});

test("--help documents the trust commands", () => {
    const help = helpText();
    assert.match(help, /trust-project/, "an adoption step the user must run has to be discoverable");
    assert.match(help, /untrust-project/);
    assert.match(help, /MEMWAL_TRUST_PROJECT_CREDS/, "the CI escape hatch belongs in --help too");
});
