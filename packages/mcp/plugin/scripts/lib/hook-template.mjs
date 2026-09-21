/**
 * Shell-safe placeholder substitution for hook templates.
 *
 * Hook templates ship a `${...}` placeholder for the plugin's install
 * directory. An installer must not paste that directory into the template
 * *text*: a path containing a double quote or a backslash rewrites the JSON
 * document, and a path containing `$(...)` or backticks becomes live shell
 * syntax in the command the host later executes (WALM-641).
 *
 * The rule here is: parse the JSON first, then substitute into the parsed
 * values, POSIX-quoting whatever lands in a shell command.
 */

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * POSIX single-quote escaping.
 *
 * Single quotes suppress every form of shell expansion, so `$(...)`, backticks,
 * double quotes and backslashes inside the value are passed through literally.
 * A literal `'` cannot appear inside single quotes, so it is emitted as `'\''`:
 * close the quote, escape one quote, reopen.
 */
export function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Substitute `placeholder` with `replacement` throughout an already-parsed hook
 * template.
 *
 * A string that is the direct value of a `command` key is treated as a shell
 * command: the replacement is POSIX-quoted into it, and the double quotes the
 * template wrapped around the placeholder are dropped in favour of ours (they
 * would not have stopped command substitution anyway).
 *
 * Every other value -- including an argv array under `command`, whose elements
 * reach execve rather than a shell -- gets the replacement substituted
 * literally.
 */
export function substituteHookPlaceholder(template, placeholder, replacement) {
    const pattern = escapeRegExp(placeholder);
    const inCommand = new RegExp(`"${pattern}([^"]*)"|${pattern}(\\S*)`, "g");
    const plain = new RegExp(pattern, "g");

    const walk = (value, isShellCommand) => {
        if (typeof value === "string") {
            return isShellCommand
                ? value.replace(inCommand, (_match, quoted, bare) =>
                      shellQuote(replacement + (quoted ?? bare ?? ""))
                  )
                : value.replace(plain, () => replacement);
        }
        if (Array.isArray(value)) return value.map((item) => walk(item, false));
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, walk(item, key === "command")])
            );
        }
        return value;
    };

    return walk(template, false);
}
