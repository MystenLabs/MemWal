/**
 * Shared I/O + throttle helpers for MemWal Claude Code / Codex hooks.
 *
 * Pure Node, no dependencies, no network. Every hook reads one JSON object
 * from stdin, optionally emits a `hookSpecificOutput` directive on stdout,
 * and always exits 0 — a hook must never block the session.
 */
import {
    readFileSync,
    mkdirSync,
    chmodSync,
    lstatSync,
    fstatSync,
    openSync,
    readSync,
    writeSync,
    ftruncateSync,
    closeSync,
    constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Read + parse the hook input JSON from stdin. Returns {} on any error. */
export function readStdin() {
    try {
        const raw = readFileSync(0, "utf8");
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Emit a hook directive. No-op when `additionalContext` is empty. */
export function emitContext(hookEventName, additionalContext) {
    if (!additionalContext) return;
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: { hookEventName, additionalContext },
        })
    );
}

// Hook state is throttle bookkeeping, not data — but it lives in a temp dir
// that may be shared, so it is handled as hostile ground (WALM-644): the
// directory is private and verified before use, and every marker is created
// exclusively and without following symlinks. Checking a path and then writing
// to it is exactly the pattern a planted symlink turns into a write elsewhere.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// Undefined on Windows, where the flag does not exist; 0 leaves the mask alone.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Used when no trustworthy directory exists or the filesystem refuses us.
// Hooks are one-shot processes, so this only spans the current invocation —
// the point is to degrade quietly rather than throw or write somewhere unsafe.
const memoryState = new Map();

/**
 * Absolute path of the private hook-state directory, or null when no safe
 * directory could be established. Resolved per call rather than frozen at
 * import, so a changed TMPDIR is honoured.
 */
export function stateDir() {
    const base = join(process.env.TMPDIR || tmpdir(), "memwal-hooks");
    try {
        mkdirSync(base, { recursive: true, mode: DIR_MODE });
    } catch {
        // Already there, most likely; the checks below decide if it is usable.
    }
    try {
        // lstat, not stat: a symlink parked here must be rejected, not walked.
        const st = lstatSync(base);
        if (!st.isDirectory()) return null;
        if (typeof process.getuid === "function") {
            if (st.uid !== process.getuid()) return null; // someone else's dir
            if (st.mode & 0o077) chmodSync(base, DIR_MODE); // shared temp dir
        }
        return base;
    } catch {
        return null;
    }
}

function safe(s) {
    return String(s || "default")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 64);
}

/**
 * Returns true the FIRST time it is called for a (name, session) pair, then
 * false thereafter — used to inject a rubric or banner only once per session.
 */
export function firstTime(name, sessionId) {
    const key = `${safe(name)}_${safe(sessionId)}`;
    const dir = stateDir();
    if (!dir) return memoryFirstTime(key);

    let fd;
    try {
        // O_CREAT|O_EXCL fails with EEXIST when anything already occupies the
        // path — a dangling symlink included — so the marker is either a fresh
        // file inside the private dir or nothing at all. Success is itself the
        // "first time" answer; there is no separate existence check to race.
        fd = openSync(
            join(dir, key),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
            FILE_MODE
        );
    } catch (err) {
        // Path taken => seen before. Anything else, fall back to memory.
        if (err?.code === "EEXIST" || err?.code === "ELOOP") return false;
        return memoryFirstTime(key);
    }

    try {
        writeSync(fd, "1");
    } catch {
        /* best effort: the marker existing is what matters, not its contents */
    } finally {
        closeQuietly(fd);
    }
    return true;
}

/** Increment and return a per-(name, session) counter. */
export function bumpCounter(name, sessionId) {
    const key = `count_${safe(name)}_${safe(sessionId)}`;
    const dir = stateDir();
    if (!dir) return memoryBump(key);
    const f = join(dir, key);

    // Refuse anything that is not a plain file: a symlink here would redirect
    // both the read and the write.
    try {
        if (!lstatSync(f).isFile()) return memoryBump(key);
    } catch (err) {
        if (err?.code !== "ENOENT") return memoryBump(key);
    }

    let fd;
    let created = false;
    try {
        fd = openSync(
            f,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | O_NOFOLLOW,
            FILE_MODE
        );
        created = true;
    } catch (err) {
        if (err?.code !== "EEXIST") return memoryBump(key);
        try {
            // No O_CREAT: with O_NOFOLLOW this fails on a symlink instead of
            // opening whatever it points at.
            fd = openSync(f, constants.O_RDWR | O_NOFOLLOW);
        } catch {
            return memoryBump(key);
        }
    }

    try {
        let n = 0;
        if (!created) {
            // The open above already refused symlinks; confirm on the fd that
            // we are not talking to a device or a fifo that would block.
            if (!fstatSync(fd).isFile()) return memoryBump(key);
            n = parseInt(readAll(fd), 10) || 0;
        }
        n += 1;
        try {
            const buf = Buffer.from(String(n));
            ftruncateSync(fd, 0);
            writeSync(fd, buf, 0, buf.length, 0);
        } catch {
            /* best effort: the caller still gets a monotonic-enough count */
        }
        return n;
    } catch {
        return memoryBump(key);
    } finally {
        closeQuietly(fd);
    }
}

function readAll(fd) {
    const chunks = [];
    const buf = Buffer.alloc(64);
    let bytes;
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
        chunks.push(Buffer.from(buf.subarray(0, bytes)));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function closeQuietly(fd) {
    try {
        closeSync(fd);
    } catch {
        /* best effort */
    }
}

function memoryFirstTime(key) {
    const k = `once:${key}`;
    if (memoryState.has(k)) return false;
    memoryState.set(k, 1);
    return true;
}

function memoryBump(key) {
    const k = `count:${key}`;
    const n = (memoryState.get(k) || 0) + 1;
    memoryState.set(k, n);
    return n;
}
