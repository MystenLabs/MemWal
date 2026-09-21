/**
 * Rewriting the `[mcp_servers.memwal]` block in ~/.codex/config.toml (WALM-640).
 *
 * The first version of the WALM-640 fix only changed what a *fresh* installation
 * writes. `ensureMcpRegistered()` returned early on `content.includes(...)`, so every
 * user who had already run the installer kept
 *
 *   [mcp_servers.memwal]
 *   command = "npx"
 *   args = ["-y", "@mysten-incubation/memwal-mcp@<pin>"]
 *
 * for ever, while re-running the installer printed "already present" — which reads
 * as success. Those users are exactly the population the ticket was filed for: Codex
 * kept resolving the package name against the project directory.
 *
 * So the installer migrates the block instead of skipping it. The rewrite is
 * deliberately line-based rather than a parse-and-reserialize: config.toml is the
 * user's file, and comments, key order and unrelated keys (`env`, timeouts, an
 * `enabled` flag, whatever a future Codex adds) have to survive untouched. Only
 * `command` and `args` are replaced.
 *
 * Pure string in, string out: no fs, no process state, so the installer's behaviour
 * is testable without a home directory.
 */

export const MEMWAL_SECTION = "mcp_servers.memwal";
const SECTION_HEADER = `[${MEMWAL_SECTION}]`;

/** Strip string literals so bracket counting is not fooled by values. */
function withoutStrings(line) {
    return line
        .replace(/'''[\s\S]*?'''/g, "''")
        .replace(/"""[\s\S]*?"""/g, '""')
        .replace(/'[^']*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function stripComment(line) {
    const bare = withoutStrings(line);
    const hash = bare.indexOf("#");
    return hash === -1 ? line : line.slice(0, hash);
}

function bracketDelta(line) {
    const bare = stripComment(line);
    let delta = 0;
    for (const char of bare) {
        if (char === "[" || char === "{") delta += 1;
        if (char === "]" || char === "}") delta -= 1;
    }
    return delta;
}

function isSectionHeader(line) {
    const trimmed = stripComment(line).trim();
    return /^\[[^\]]+\]$/.test(trimmed) || /^\[\[[^\]]+\]\]$/.test(trimmed);
}

function sectionName(line) {
    const trimmed = stripComment(line).trim();
    const match = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    return match ? match[1].trim() : null;
}

const KEY_PATTERN = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/;

function keyOf(line) {
    const match = KEY_PATTERN.exec(stripComment(line));
    if (!match) return null;
    return match[1].replace(/^["']|["']$/g, "");
}

/**
 * Split the block that starts at `headerIndex` into entries. An entry is one
 * key/value pair (possibly spanning lines, for a multi-line array or table) or a
 * run of comment/blank lines carried along verbatim.
 */
function readEntries(lines, headerIndex) {
    const entries = [];
    let index = headerIndex + 1;
    while (index < lines.length) {
        if (isSectionHeader(lines[index])) break;
        const key = keyOf(lines[index]);
        if (key === null) {
            entries.push({ key: null, lines: [lines[index]] });
            index += 1;
            continue;
        }
        const collected = [lines[index]];
        let depth = bracketDelta(lines[index]);
        index += 1;
        while (depth > 0 && index < lines.length) {
            collected.push(lines[index]);
            depth += bracketDelta(lines[index]);
            index += 1;
        }
        entries.push({ key, lines: collected });
    }
    return { entries, end: index };
}

function rawValue(entry) {
    const joined = entry.lines.join("\n");
    const equals = joined.indexOf("=");
    return equals === -1 ? "" : joined.slice(equals + 1).trim();
}

/** TOML's basic strings and arrays of them are JSON; anything else we treat as "not ours". */
function asJson(value) {
    try {
        return JSON.parse(value.replace(/,(\s*[\]}])/g, "$1"));
    } catch {
        return undefined;
    }
}

function desiredLines(launcher) {
    return {
        command: 'command = "node"',
        args: `args = [${JSON.stringify(launcher)}]`,
    };
}

/**
 * Work out what ~/.codex/config.toml should contain.
 *
 * Returns `{ content, action, previous, preserved }` where action is one of:
 *   - "added":     no `[mcp_servers.memwal]` block existed; one was appended.
 *   - "migrated":  a block existed and did not launch our launcher; command/args
 *                  were rewritten and every other key in the block kept.
 *   - "unchanged": the block already runs `node <launcher>`.
 */
export function planMcpRegistration(content, launcher) {
    const text = String(content ?? "");
    const lines = text.split("\n");
    const headerIndex = lines.findIndex((line) => sectionName(line) === MEMWAL_SECTION);
    const desired = desiredLines(launcher);

    if (headerIndex === -1) {
        const block = `\n${SECTION_HEADER}\n${desired.command}\n${desired.args}\n`;
        return {
            content: (text.trimEnd() + "\n" + block).trimStart(),
            action: "added",
            previous: null,
            preserved: [],
        };
    }

    const { entries, end } = readEntries(lines, headerIndex);
    const commandEntry = entries.find((entry) => entry.key === "command");
    const argsEntry = entries.find((entry) => entry.key === "args");
    const previous = {
        command: commandEntry ? rawValue(commandEntry) : null,
        args: argsEntry ? rawValue(argsEntry) : null,
    };

    const currentCommand = commandEntry ? asJson(rawValue(commandEntry)) : undefined;
    const currentArgs = argsEntry ? asJson(rawValue(argsEntry)) : undefined;
    const alreadyCorrect =
        currentCommand === "node" &&
        Array.isArray(currentArgs) &&
        currentArgs.length === 1 &&
        currentArgs[0] === launcher;
    if (alreadyCorrect) {
        return { content: text, action: "unchanged", previous, preserved: [] };
    }

    const rebuilt = [];
    let wroteCommand = false;
    let wroteArgs = false;
    for (const entry of entries) {
        if (entry.key === "command") {
            rebuilt.push(desired.command);
            wroteCommand = true;
            continue;
        }
        if (entry.key === "args") {
            rebuilt.push(desired.args);
            wroteArgs = true;
            continue;
        }
        rebuilt.push(...entry.lines);
    }
    // A block that never had command/args (or had only one of them) still has to end
    // up launching the launcher; put the missing keys first, where a reader expects.
    const missing = [];
    if (!wroteArgs) missing.unshift(desired.args);
    if (!wroteCommand) missing.unshift(desired.command);

    const preserved = entries
        .filter((entry) => entry.key !== null && entry.key !== "command" && entry.key !== "args")
        .map((entry) => entry.key);

    const next = [
        ...lines.slice(0, headerIndex + 1),
        ...missing,
        ...rebuilt,
        ...lines.slice(end),
    ];
    return { content: next.join("\n"), action: "migrated", previous, preserved };
}
