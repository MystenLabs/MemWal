#!/usr/bin/env node

/**
 * The version the plugin launcher installs must exist on npm.
 *
 * `pinnedVersion()` in packages/mcp/plugin/scripts/lib/mcp-launch.mjs reads
 * `mcpPackageVersion` out of plugin.json and installs exactly that. npm has no
 * such version, the install fails, and the launch fails with it — every fresh
 * plugin install, on every editor, until someone edits the manifest. That is not
 * hypothetical: on 2026-09-17 the launchers pinned `@0.0.14` while npm carried
 * only 0.0.13 and 0.0.14-dev.0, because plugin.json had been bumped for a release
 * that had not shipped.
 *
 * A unit test cannot catch this — whether a version exists is a fact about npm,
 * not about the repository — so it lives here.
 *
 * Two findings, deliberately unequal:
 *
 *   ERROR   the pin is not published. The launcher cannot install it. Blocking.
 *
 *   WARNING the pin is published but is not what the dist-tag for this branch
 *           points at. Not blocking, because it cannot be: pushing to `dev`
 *           publishes a NEW `dev.N` and never commits that number back, so the
 *           manifest is one behind by construction for most of its life. Failing
 *           on that would redden CI after every merge. It is still worth saying —
 *           0.0.14-dev.0 outlived the relayer change that made its own
 *           instructions wrong, and nothing anywhere said so.
 */

import fs from "node:fs";
import path from "node:path";

const PACKAGE = "@mysten-incubation/memwal-mcp";
const MANIFEST = "packages/mcp/plugin/plugin.json";
const REGISTRY = "https://registry.npmjs.org";

/** Which dist-tag this ref is supposed to be tracking. */
function expectedTag() {
    const override = process.argv
        .find((a) => a.startsWith("--tag="))
        ?.slice("--tag=".length);
    if (override) return override;

    // On a pull request GITHUB_REF_NAME is "<n>/merge", so the branch that
    // matters is the one being merged INTO.
    const branch = process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || "dev";
    if (branch === "main") return "latest";
    if (branch === "staging") return "rc";
    return "dev";
}

function annotate(level, message) {
    if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message}`);
    console.log(`${level.toUpperCase()}: ${message}`);
}

function summarise(lines) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) fs.appendFileSync(file, lines.join("\n") + "\n");
}

async function main() {
    const manifestPath = path.join(process.cwd(), MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // Mirror pinnedVersion(): mcpPackageVersion wins, version is the fallback.
    const pin = manifest.mcpPackageVersion ?? manifest.version;
    if (typeof pin !== "string" || pin.trim() === "") {
        annotate("error", `${MANIFEST} has no usable "mcpPackageVersion" or "version"`);
        process.exit(1);
    }

    let packument;
    try {
        const response = await fetch(`${REGISTRY}/${PACKAGE}`, {
            headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`);
        packument = await response.json();
    } catch (error) {
        // Failing open would make a green check mean nothing, so this is fatal —
        // but say plainly that it is the registry, not the pin, so nobody starts
        // editing plugin.json to chase a network blip.
        annotate("error", `could not read ${PACKAGE} from npm (${error.message}). Retry the job.`);
        process.exit(1);
    }

    const versions = Object.keys(packument.versions ?? {});
    const tags = packument["dist-tags"] ?? {};
    const tag = expectedTag();
    const tagged = tags[tag];

    const summary = [
        "### MCP launcher pin",
        "",
        `| | |`,
        `|---|---|`,
        `| \`mcpPackageVersion\` | \`${pin}\` |`,
        `| \`version\` | \`${manifest.version}\` |`,
        `| npm \`${tag}\` | \`${tagged ?? "(none)"}\` |`,
        "",
    ];

    if (!versions.includes(pin)) {
        annotate(
            "error",
            `${MANIFEST} pins ${PACKAGE}@${pin}, which is not published. ` +
                `The trusted launcher installs that exact version, so every plugin install ` +
                `would fail. Published dist-tags: ` +
                Object.entries(tags)
                    .map(([name, value]) => `${name}=${value}`)
                    .join(", "),
        );
        summary.push(`**Not published.** The launcher cannot install \`${pin}\`.`);
        summarise(summary);
        process.exit(1);
    }

    if (tagged && pin !== tagged) {
        annotate(
            "warning",
            `${MANIFEST} pins ${pin}, but npm "${tag}" is ${tagged}. The pin is published, ` +
                `so nothing breaks — but installs keep serving ${pin}. Bump ` +
                `mcpPackageVersion if that is not deliberate.`,
        );
        summary.push(
            `Published, but behind the \`${tag}\` tag. Installs serve \`${pin}\`, not \`${tagged}\`.`,
        );
        summarise(summary);
        return;
    }

    console.log(`OK: ${PACKAGE}@${pin} is published and matches the "${tag}" dist-tag.`);
    summary.push(`Published, and matches the \`${tag}\` tag.`);
    summarise(summary);
}

await main();
