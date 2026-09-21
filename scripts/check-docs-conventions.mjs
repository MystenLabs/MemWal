#!/usr/bin/env node

// Docs conventions check.
//
// Catches the three classes of review comment that the prose style checks miss:
//
//   1. A concept that the docs have a canonical page or spec for, mentioned in
//      prose but never linked anywhere on the page.
//   2. A page whose procedure or troubleshooting formatting disagrees with
//      itself or with its sibling pages in the same directory.
//   3. A pull request that changes a click-through UI procedure without saying
//      whether anyone ran it. That one is a disclosure, not a fix: the check
//      asks the author to state it so a reviewer does not have to.
//
// Usage:
//   node scripts/check-docs-conventions.mjs                 # docs changed vs BASE_REF
//   node scripts/check-docs-conventions.mjs FILE [FILE...]  # specific files
//   node scripts/check-docs-conventions.mjs --all           # every page under docs/
//
// Exit 0 = clean. Exit 1 = violations. Exit 2 = the config itself is stale.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const DOCS_DIR = "docs";
const CONFIG_PATH = "scripts/docs-conventions.json";

function read(relPath) {
    return fs.readFileSync(path.join(root, relPath), "utf8");
}

function git(args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function isPage(relPath) {
    return /^docs\/.+\.mdx?$/.test(relPath) && !relPath.startsWith("docs/src/");
}

// ---------------------------------------------------------------- config

function docsJsonPages() {
    const pages = new Set();
    const walk = (node) => {
        if (typeof node === "string") {
            pages.add(node);
        } else if (Array.isArray(node)) {
            node.forEach(walk);
        } else if (node && typeof node === "object") {
            for (const [key, value] of Object.entries(node)) {
                if (["navigation", "tabs", "anchors", "groups", "pages"].includes(key)) {
                    walk(value);
                }
            }
        }
    };
    walk(JSON.parse(read(`${DOCS_DIR}/docs.json`)).navigation);
    return pages;
}

function loadConfig() {
    const config = JSON.parse(read(CONFIG_PATH));
    const pages = docsJsonPages();
    const stale = config.linkTerms
        .filter((entry) => entry.target.startsWith("/"))
        .filter((entry) => !pages.has(entry.target.replace(/^\//, "").split("#")[0]));
    if (stale.length > 0) {
        const names = stale.map((entry) => `${entry.term} -> ${entry.target}`).join(", ");
        throw new Error(
            `${CONFIG_PATH} points at routes that are not in ${DOCS_DIR}/docs.json: ${names}`,
        );
    }
    return config;
}

// ---------------------------------------------------------------- parsing

// Strip frontmatter but keep the body's original line numbers, so every
// reported line matches what the author sees in their editor.
function bodyLines(text) {
    const lines = text.split("\n");
    if (lines[0] !== "---") {
        return lines;
    }
    const close = lines.indexOf("---", 1);
    if (close === -1) {
        return lines;
    }
    return lines.map((line, index) => (index <= close ? "" : line));
}

// Blank fenced code and pad inline code with spaces. Columns survive, so a
// term inside backticks can never trip a prose rule.
function maskCode(lines) {
    let fenced = false;
    return lines.map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            return "";
        }
        if (fenced) {
            return "";
        }
        return line.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
    });
}

function linkSpans(line) {
    const spans = [];
    const re = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
        spans.push({ start: match.index, end: match.index + match[0].length, target: match[1] });
    }
    return spans;
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A `<Steps>` block, or an ordered list item, is a procedure. Everything else
// is prose, and the procedure checks leave it alone.
function procedureLineFlags(lines) {
    let inSteps = false;
    return lines.map((line) => {
        if (/^\s*<Steps>/.test(line)) {
            inSteps = true;
            return { inSteps: true, ordered: false };
        }
        if (/^\s*<\/Steps>/.test(line)) {
            inSteps = false;
            return { inSteps: true, ordered: false };
        }
        return { inSteps, ordered: /^\s{0,3}\d+\.\s/.test(line) };
    });
}

function sectionAt(lines, index) {
    for (let i = index; i >= 0; i -= 1) {
        const match = lines[i].match(/^##\s+(.*)$/);
        if (match) {
            return match[1].trim();
        }
    }
    return null;
}

// ---------------------------------------------------------------- check 1

function checkLinkTerms(relPath, lines, config) {
    const findings = [];
    const pageTargets = new Set();
    lines.forEach((line) => linkSpans(line).forEach((span) => pageTargets.add(span.target)));

    // An internal route also counts as linked when the author wrote it as an
    // absolute URL into the published site.
    const linked = (target) =>
        [...pageTargets].some((found) => {
            const bare = found.split("#")[0].replace(/\/$/, "");
            return bare === target || (target.startsWith("/") && bare.endsWith(target));
        });

    // A page is its own canonical explanation of the term it covers, so never
    // ask it to link to itself.
    const ownRoute = `/${relPath.replace(/^docs\//, "").replace(/\.mdx?$/, "")}`;

    for (const entry of config.linkTerms) {
        if (entry.target === ownRoute || linked(entry.target)) {
            continue;
        }
        const re = new RegExp(`\\b${escapeRegex(entry.term)}s?\\b`, "i");
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (/^\s*#/.test(line)) {
                continue;
            }
            const match = line.match(re);
            if (!match) {
                continue;
            }
            const at = match.index;
            const insideLink = linkSpans(line).some((span) => at >= span.start && at < span.end);
            if (insideLink) {
                continue;
            }
            findings.push({
                file: relPath,
                line: i + 1,
                rule: "link-term",
                message: `"${entry.term}" is never linked on this page. Link the first mention to ${entry.target}.`,
            });
            break;
        }
    }
    return findings;
}

// ---------------------------------------------------------------- check 2

function checkProcedureFormat(relPath, lines) {
    const findings = [];
    const usesSteps = lines.some((line) => /^\s*<Steps>/.test(line));
    if (!usesSteps) {
        return findings;
    }

    const flags = procedureLineFlags(lines);
    const reported = new Set();

    for (let i = 0; i < lines.length; i += 1) {
        if (flags[i].inSteps || !flags[i].ordered) {
            continue;
        }
        // Walk the whole ordered list, then decide once for the list.
        const items = [];
        const first = i;
        let j = i;
        while (j < lines.length && !flags[j].inSteps) {
            if (flags[j].ordered) {
                items.push(lines[j]);
            } else if (lines[j].trim() === "" || /^\s{2,}\S/.test(lines[j])) {
                // Blank lines and indented continuations stay inside the list.
            } else {
                break;
            }
            j += 1;
        }
        i = j - 1;

        const bolded = items.filter((item) => /^\s{0,3}\d+\.\s+\*\*/.test(item));
        if (items.length >= 2 && bolded.length === items.length) {
            const section = sectionAt(lines, first);
            if (!reported.has(section)) {
                reported.add(section);
                findings.push({
                    file: relPath,
                    line: first + 1,
                    rule: "procedure-format",
                    message: `"${section ?? "This section"}" writes a procedure as a bolded numbered list while the page uses <Steps> elsewhere. Use one or the other.`,
                });
            }
        }
    }
    return findings;
}

const TROUBLESHOOTING_FORMATS = [
    { name: "bulleted", test: (line) => /^-\s+\*\*/.test(line) },
    { name: "numbered", test: (line) => /^\d+\.\s+\*\*/.test(line) },
    { name: "bold-heading", test: (line) => /^\*\*.+\*\*\.?\s*$/.test(line) },
];

function troubleshootingFormat(lines) {
    let inSection = false;
    for (const line of lines) {
        if (/^##\s/.test(line)) {
            inSection = /^##\s+Troubleshooting\s*$/i.test(line);
            continue;
        }
        if (!inSection) {
            continue;
        }
        const match = TROUBLESHOOTING_FORMATS.find((format) => format.test(line));
        if (match) {
            return match.name;
        }
    }
    return null;
}

function checkTroubleshootingFormat(relPath, lines) {
    const format = troubleshootingFormat(lines);
    if (!format) {
        return [];
    }

    const dir = path.dirname(relPath);
    const siblings = fs
        .readdirSync(path.join(root, dir))
        .filter((name) => /\.mdx?$/.test(name))
        .map((name) => `${dir}/${name}`)
        .filter((sibling) => sibling !== relPath);

    const counts = new Map();
    for (const sibling of siblings) {
        const siblingFormat = troubleshootingFormat(maskCode(bodyLines(read(sibling))));
        if (siblingFormat) {
            counts.set(siblingFormat, (counts.get(siblingFormat) ?? 0) + 1);
        }
    }
    if (counts.size === 0) {
        return [];
    }

    const [house, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (votes < 2 || house === format) {
        return [];
    }

    const line = lines.findIndex((entry) => /^##\s+Troubleshooting\s*$/i.test(entry)) + 1;
    return [
        {
            file: relPath,
            line,
            rule: "troubleshooting-format",
            message: `Troubleshooting is ${format} here but ${house} on ${votes} other pages in ${dir}/. Match the sibling pages.`,
        },
    ];
}

// ---------------------------------------------------------------- check 3

function uiProcedureLines(lines, config) {
    const flags = procedureLineFlags(lines);
    const verbs = new RegExp(`\\b(${config.uiVerbs.map(escapeRegex).join("|")})\\b`, "i");
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!flags[i].inSteps && !flags[i].ordered) {
            continue;
        }
        if (verbs.test(lines[i]) && /\*\*[^*]+\*\*/.test(lines[i])) {
            hits.push(i + 1);
        }
    }
    return hits;
}

function pullRequestBody() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) {
        return null;
    }
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    return event.pull_request ? (event.pull_request.body ?? "") : null;
}

function checkUiDisclosure(pages, config) {
    const body = pullRequestBody();
    if (body === null) {
        return { findings: [], skipped: true };
    }

    const withUi = pages.filter((page) => page.uiLines.length > 0);
    if (withUi.length === 0) {
        return { findings: [], skipped: false };
    }
    if (body.toLowerCase().includes(config.prBodyMarker.toLowerCase())) {
        return { findings: [], skipped: false };
    }

    return {
        findings: withUi.map((page) => ({
            file: page.relPath,
            line: page.uiLines[0],
            rule: "ui-disclosure",
            message:
                `This page documents a click-through UI procedure. Add a "${config.prBodyMarker}" ` +
                "line to the pull request body saying who ran it and against which environment, " +
                "or say plainly that nobody has.",
        })),
        skipped: false,
    };
}

// ---------------------------------------------------------------- driver

function targetFiles(argv) {
    if (argv.includes("--all")) {
        const found = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                const next = `${dir}/${entry.name}`;
                if (entry.isDirectory()) {
                    walk(next);
                } else if (isPage(next)) {
                    found.push(next);
                }
            }
        };
        walk(DOCS_DIR);
        return found;
    }

    const explicit = argv.filter((arg) => !arg.startsWith("-"));
    if (explicit.length > 0) {
        return explicit;
    }

    const base = process.env.BASE_REF || "origin/dev";
    const changed = new Set();
    for (const range of [`${base}...HEAD`, "HEAD"]) {
        try {
            git(["diff", "--name-only", range, "--", DOCS_DIR])
                .split("\n")
                .filter(Boolean)
                .forEach((file) => changed.add(file));
        } catch {
            // A missing base ref in a shallow checkout is not a reason to fail
            // the build; the working-tree range still runs.
        }
    }
    return [...changed].filter(isPage).filter((file) => fs.existsSync(path.join(root, file)));
}

function main() {
    let config;
    try {
        config = loadConfig();
    } catch (error) {
        console.error(`docs-conventions: ${error.message}`);
        return 2;
    }

    const files = targetFiles(process.argv.slice(2));
    if (files.length === 0) {
        console.log("docs-conventions: no docs pages changed.");
        return 0;
    }

    const findings = [];
    const pages = [];
    for (const relPath of files) {
        const lines = maskCode(bodyLines(read(relPath)));
        findings.push(...checkLinkTerms(relPath, lines, config));
        findings.push(...checkProcedureFormat(relPath, lines));
        findings.push(...checkTroubleshootingFormat(relPath, lines));
        pages.push({ relPath, uiLines: uiProcedureLines(lines, config) });
    }

    const disclosure = checkUiDisclosure(pages, config);
    findings.push(...disclosure.findings);

    if (findings.length === 0) {
        console.log(`docs-conventions: ${files.length} page(s) clean.`);
        if (disclosure.skipped) {
            console.log("docs-conventions: ui-disclosure skipped (no pull request payload).");
        }
        return 0;
    }

    console.error(`docs-conventions: ${findings.length} finding(s)\n`);
    for (const finding of findings) {
        console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
        console.error(`    ${finding.message}\n`);
    }
    return 1;
}

process.exit(main());
