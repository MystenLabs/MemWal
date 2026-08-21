#!/usr/bin/env node
/**
 * Imports code from the workspace into the docs.
 *
 * Mintlify cannot import code from repository files at build time, so every
 * snippet in docs/ has been a hand-made copy. `check-docs-code-sync.mjs`
 * validates the parts of a copy that can be derived from package metadata —
 * package names, entry points, MCP config blocks — but it cannot tell whether
 * the body of a snippet still matches the declaration it came from.
 *
 * This script closes that gap. A docs page marks a fenced block as imported:
 *
 *     {/* memwal:import packages/sdk/src/types.ts#RememberResult *\/}
 *     ```ts
 *     ...body written by this script...
 *     ```
 *     {/* /memwal:import *\/}
 *
 * (the closing delimiters are escaped as *\/ above only so this block comment
 * does not end early; drop the backslash in a real docs page)
 *
 * and the body is replaced with the real declaration, doc comments included.
 * The result stays committed, so Mintlify renders it with no build step, it
 * reads correctly on GitHub, and nothing breaks if this script never runs.
 * The script only keeps it honest.
 *
 * Two selectors:
 *   path#SymbolName   the named top-level declaration, plus its doc comment.
 *                     Needs no markers in the source, so importing a symbol
 *                     costs the source file nothing.
 *   path#region:name  the span between `#region docs:name` and its
 *                     `#endregion`, for a slice that is not one declaration.
 *
 * Both are anchored to a name rather than to line numbers, which rot silently
 * on the next refactor. A missing symbol or region fails loudly instead.
 *
 * Modes:
 *   (default)  rewrite every marked block from its source.
 *   --check    exit non-zero if any block differs from its source. CI runs
 *              this, so drift fails the pull request that caused it.
 *
 * Run: node scripts/sync-docs-code.mjs [--check]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DOCS_DIR = "docs";

// A docs page can only import from source that ships. Without this, a marker
// could inline a .env file or a keystore into a public page.
const ALLOWED_ROOTS = new Set(["packages", "apps", "services", "scripts", "contract"]);

// Info string for the generated fence, by source extension. An unlisted
// extension is not an error: the fence just gets no language.
const LANG_BY_EXT = new Map([
    [".ts", "ts"],
    [".tsx", "tsx"],
    [".mts", "ts"],
    [".cts", "ts"],
    [".js", "js"],
    [".jsx", "jsx"],
    [".mjs", "js"],
    [".cjs", "js"],
    [".py", "python"],
    [".rs", "rust"],
    [".move", "move"],
    [".go", "go"],
    [".sh", "bash"],
    [".json", "json"],
    [".toml", "toml"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
]);

// Declarations worth importing by name. `export` and `declare` are optional so
// a non-exported helper can still be imported deliberately.
const DECL_KEYWORDS = ["interface", "type", "class", "enum", "function", "const", "let", "var"];

const checkOnly = process.argv.slice(2).includes("--check");

// ── Reading source ─────────────────────────────────────────────────

/**
 * Scans forward from `start`, tracking nesting depth while skipping over
 * strings, template literals, and comments so that a brace inside `"{"` or a
 * `//` comment does not end the declaration early. Returns the index just
 * past the closing brace, or -1 if the source ends first.
 */
function matchBrace(text, start) {
    let depth = 0;
    let seenOpen = false;
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === "/" && next === "/") {
            const end = text.indexOf("\n", i);
            i = end === -1 ? text.length : end;
            continue;
        }
        if (char === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            const quote = char;
            i += 1;
            while (i < text.length) {
                if (text[i] === "\\") i += 2;
                else if (text[i] === quote) break;
                else i += 1;
            }
            continue;
        }
        if (char === "{") {
            depth += 1;
            seenOpen = true;
        } else if (char === "}") {
            depth -= 1;
            if (seenOpen && depth === 0) return i + 1;
        }
    }
    return -1;
}

/**
 * Walks backwards from a declaration to pick up the doc comment attached to
 * it — a `/** ... *\/` block or a run of `//` lines — but stops at a blank
 * line, so an unrelated comment further up is not swept in.
 */
function leadingComment(text, declStart) {
    const before = text.slice(0, declStart);
    const lines = before.split("\n");
    // The declaration's own line is the last (possibly partial) entry.
    lines.pop();

    const collected = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === "") break;
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            collected.unshift(line);
            if (trimmed.startsWith("/*")) break;
            continue;
        }
        break;
    }
    return collected;
}

/**
 * First `{` or `;` after `start` that is real code, skipping strings and
 * comments. A plain indexOf would find the brace in `const T = "{}";` and
 * then run the brace matcher off the end of the declaration.
 */
function firstDelimiter(text, start) {
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === "/" && next === "/") {
            const end = text.indexOf("\n", i);
            i = end === -1 ? text.length : end;
            continue;
        }
        if (char === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            const quote = char;
            i += 1;
            while (i < text.length) {
                if (text[i] === "\\") i += 2;
                else if (text[i] === quote) break;
                else i += 1;
            }
            continue;
        }
        if (char === "{") return { kind: "brace", index: i };
        if (char === ";") return { kind: "semicolon", index: i };
    }
    return null;
}

function extractSymbol(text, file, name) {
    // `name` reaches here from a docs marker, so it is escaped before it
    // becomes part of a pattern.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keywords = DECL_KEYWORDS.join("|");
    const re = new RegExp(
        `^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:declare[ \\t]+)?(?:async[ \\t]+)?(?:${keywords})[ \\t]+${escaped}\\b`,
        "m",
    );
    const match = re.exec(text);
    if (!match) {
        throw new Error(
            `${file}: no declaration named '${name}'. ` +
                `Looked for ${DECL_KEYWORDS.join(", ")}.`,
        );
    }

    const declStart = match.index;
    const delimiter = firstDelimiter(text, declStart);

    let end;
    if (delimiter === null) {
        const lineEnd = text.indexOf("\n", declStart);
        end = lineEnd === -1 ? text.length : lineEnd;
    } else if (delimiter.kind === "brace") {
        end = matchBrace(text, delimiter.index);
        if (end === -1) {
            throw new Error(`${file}: declaration '${name}' has no closing brace.`);
        }
    } else {
        end = delimiter.index + 1;
    }

    const body = text.slice(declStart, end);
    return [...leadingComment(text, declStart), ...body.split("\n")].join("\n");
}

function extractRegion(text, file, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const start = new RegExp(`^[ \\t]*(?://|#|--)[ \\t]*#region[ \\t]+docs:${escaped}[ \\t]*$`, "m");
    const startMatch = start.exec(text);
    if (!startMatch) {
        throw new Error(`${file}: no '#region docs:${name}' marker.`);
    }
    const after = startMatch.index + startMatch[0].length;
    const end = new RegExp(
        `^[ \\t]*(?://|#|--)[ \\t]*#endregion(?:[ \\t]+docs:${escaped})?[ \\t]*$`,
        "m",
    );
    const endMatch = end.exec(text.slice(after));
    if (!endMatch) {
        throw new Error(`${file}: '#region docs:${name}' is never closed.`);
    }
    return dedent(text.slice(after, after + endMatch.index).replace(/^\n|\n$/g, ""));
}

function dedent(block) {
    const lines = block.split("\n");
    const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(cut)).join("\n");
}

const sourceCache = new Map();
function readSource(rel) {
    if (sourceCache.has(rel)) return sourceCache.get(rel);
    // Normalize first, so `packages/../.ssh/id_rsa` cannot pass the root check
    // by hiding the traversal behind an allowed prefix.
    const normalized = path.normalize(rel);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new Error(`'${rel}' resolves outside the repository.`);
    }
    const root = normalized.split(path.sep)[0];
    if (!ALLOWED_ROOTS.has(root)) {
        throw new Error(
            `'${rel}' is under '${root}/', which is not an importable root. ` +
                `Allowed: ${[...ALLOWED_ROOTS].join(", ")}.`,
        );
    }
    const text = readFileSync(normalized, "utf8").replace(/\r\n?/g, "\n");
    sourceCache.set(rel, text);
    return text;
}

// ── Reading docs ───────────────────────────────────────────────────

function markdownFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...markdownFiles(full));
        else if (/\.mdx?$/.test(entry.name)) found.push(full);
    }
    return found;
}

/**
 * Line numbers (1-based) that sit inside a fenced code block. The page that
 * documents this convention shows the marker syntax inside a fence, and
 * without this it would rewrite itself on every run.
 */
function fencedLines(lines) {
    const inside = new Set();
    let fence = null;
    lines.forEach((line, i) => {
        const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
        if (fence === null) {
            if (match) {
                fence = match[1];
                inside.add(i + 1);
            }
            return;
        }
        inside.add(i + 1);
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
            fence = null;
        }
    });
    return inside;
}

// Markers are MDX comments, not HTML comments. Both Mintlify and the Walrus
// Docusaurus site that republishes these pages parse .md as MDX, where
// `<!-- -->` is a hard parse error ("Unexpected character `!`"). `{/* */}`
// compiles to a real comment and renders as nothing in both.
const OPEN_RE = /^[ \t]*\{\/\*[ \t]*memwal:import[ \t]+(\S+?)(?:[ \t]+lang=(\S+?))?[ \t]*\*\/\}[ \t]*$/;
const CLOSE_RE = /^[ \t]*\{\/\*[ \t]*\/memwal:import[ \t]*\*\/\}[ \t]*$/;

// The HTML-comment form is invisible in CommonMark, so it looks right until the
// Docusaurus build fails days later in another repository. Catch it here.
const HTML_MARKER_RE = /^[ \t]*<!--[ \t]*\/?memwal:import\b/;

/**
 * Rebuilds one docs page with every marked block replaced by its source.
 * Returns the new text plus the blocks it touched.
 */
function rewrite(file, text) {
    const lines = text.split("\n");
    const fenced = fencedLines(lines);
    const out = [];
    const blocks = [];

    for (let i = 0; i < lines.length; i += 1) {
        if (HTML_MARKER_RE.test(lines[i]) && !fenced.has(i + 1)) {
            throw new Error(
                `${file}:${i + 1}: import markers must be MDX comments, not HTML comments. ` +
                    "Use {/* memwal:import path#Symbol */} ... {/* /memwal:import */}. " +
                    "Mintlify and the Walrus Docusaurus site both parse .md as MDX, where " +
                    "<!-- --> fails to compile.",
            );
        }
        const open = OPEN_RE.exec(lines[i]);
        if (!open || fenced.has(i + 1)) {
            out.push(lines[i]);
            continue;
        }

        const openLine = i + 1;
        const [, target, langOverride] = open;
        const hash = target.indexOf("#");
        if (hash === -1) {
            throw new Error(
                `${file}:${openLine}: '${target}' has no selector. ` +
                    `Use path#SymbolName or path#region:name.`,
            );
        }
        const sourcePath = target.slice(0, hash);
        const selector = target.slice(hash + 1);

        // Find the close marker before doing any work, so a page missing one
        // fails with its own line number rather than swallowing the rest.
        let close = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
            // A close marker shown as an example inside a fence is not this
            // block's close, so the fence check applies here too.
            if (fenced.has(j + 1)) continue;
            if (CLOSE_RE.test(lines[j])) {
                close = j;
                break;
            }
            if (OPEN_RE.test(lines[j])) break;
        }
        if (close === -1) {
            throw new Error(`${file}:${openLine}: no closing <!-- /memwal:import --> marker.`);
        }

        const source = readSource(sourcePath);
        const body = selector.startsWith("region:")
            ? extractRegion(source, sourcePath, selector.slice("region:".length))
            : extractSymbol(source, sourcePath, selector);

        const lang =
            langOverride ?? LANG_BY_EXT.get(path.extname(sourcePath).toLowerCase()) ?? "";
        const replacement = ["```" + lang, ...body.split("\n"), "```"];

        const previous = lines.slice(i + 1, close);
        blocks.push({
            file,
            line: openLine,
            target,
            changed: previous.join("\n") !== replacement.join("\n"),
        });

        out.push(lines[i], ...replacement, lines[close]);
        i = close;
    }

    return { text: out.join("\n"), blocks };
}

// ── Run ────────────────────────────────────────────────────────────

let docsExists;
try {
    docsExists = statSync(DOCS_DIR).isDirectory();
} catch {
    docsExists = false;
}
if (!docsExists) {
    console.error(`No ${DOCS_DIR}/ directory. Run this from the repository root.`);
    process.exit(2);
}

const files = markdownFiles(DOCS_DIR);
const allBlocks = [];
const errors = [];
let written = 0;

for (const file of files) {
    const original = readFileSync(file, "utf8");
    // Markers are cheap to rule out, and most pages have none.
    if (!original.includes("memwal:import")) continue;

    let result;
    try {
        result = rewrite(file, original.replace(/\r\n?/g, "\n"));
    } catch (error) {
        errors.push(error.message);
        continue;
    }

    allBlocks.push(...result.blocks);
    if (result.text !== original && !checkOnly) {
        writeFileSync(file, result.text, "utf8");
        written += 1;
    }
}

if (errors.length > 0) {
    console.error(`\n${errors.length} import(s) could not be resolved:\n`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
        "\nA marker names a source path and a symbol or region. If the code moved or was " +
            "renamed, update the marker; if it was deleted, the docs page needs rewriting.",
    );
    process.exit(1);
}

const stale = allBlocks.filter((b) => b.changed);

console.log(
    `Scanned ${files.length} docs pages: ${allBlocks.length} imported block(s) ` +
        `across ${new Set(allBlocks.map((b) => b.file)).size} page(s).`,
);

// A check that finds nothing reports success forever. Once a page uses this,
// zero blocks means the search broke, not that the tree is clean. Same
// reasoning as the floor in check-docs-code-sync.mjs.
if (allBlocks.length === 0) {
    console.error(
        "\nFound no imported blocks at all. The docs are known to contain some, so either " +
            "they were removed deliberately or this script stopped finding them. Confirm " +
            "which before changing this floor.",
    );
    process.exit(2);
}

if (checkOnly) {
    if (stale.length > 0) {
        console.error(`\n${stale.length} imported block(s) drifted from their source:\n`);
        for (const block of stale) console.error(`  - ${block.file}:${block.line} (${block.target})`);
        console.error(
            "\nRun `node scripts/sync-docs-code.mjs` and commit the result. The source is " +
                "the authority here, so the docs page follows it.",
        );
        process.exit(1);
    }
    console.log("Every imported block matches its source.");
} else {
    console.log(
        written > 0
            ? `Updated ${written} page(s).`
            : "Every imported block already matched its source.",
    );
}
