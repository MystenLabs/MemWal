---
title: Import Your Existing Memory
description: >-
  Copy durable facts from your current session, standing context, and local agent memory
  into Walrus Memory in batches, then keep using them from Claude Code, Codex, Cursor, or Antigravity.
keywords:
  - import memory
  - existing memory
  - local memory
  - session
  - CLAUDE.md
  - AGENTS.md
  - rememberBulk
  - analyze
  - onboarding
  - Walrus Memory
goal:
  description: Extract durable facts from a coding agent's local memory, standing context, and session transcripts, then batch-upload them into the same Walrus Memory namespace the agent will recall from.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I import my existing Claude, Codex, Cursor, or Antigravity memory into Walrus Memory?
  - How do I batch upload local memories and session history to Walrus Memory?
  - Where do Claude Code, Codex, Cursor, and Antigravity store local memory on disk?
answer: >-
  Read the durable facts already on disk — local memory files, standing context such as
  CLAUDE.md, AGENTS.md, or GEMINI.md, and recent session transcripts — then write them
  into the same namespace your agent recalls from. Use memwal_analyze or analyze for a
  Claude memory file and for a transcript. Use memwal_remember_bulk or rememberBulk only for
  facts that are already one statement each.
  After recall returns one of those facts, new sessions keep writing to Walrus Memory
  through the plugin.
---

You already have memory on this machine: facts an agent saved locally, standing instructions it reads every session, and the transcript of the session you are in. Walrus Memory starts empty until those facts are written through it. This page copies the durable ones across, in batches, so the next session recalls what you already had.

Connect Walrus Memory in the client first, and sign in, so the upload and the later recall use the same account. See [MCP](/mcp/overview) for Claude Code, Codex, Cursor, and Antigravity.

## What to copy

Treat the three sources differently. Recall works best on short, self-contained facts.

| Source | What it holds | What to upload |
| --- | --- | --- |
| Local memory | Facts the agent already decided to keep | Each fact, as its own memory |
| Standing context | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor rules | Durable preferences, decisions, and identity details pulled out of the file |
| Session transcript | The current chat and recent chats | Facts extracted from the transcript. The SDK can stamp the session time onto those facts |

Leave repository instructions, tool routing, and one-off task notes in the original files. A whole `CLAUDE.md` or a raw transcript stored as one memory comes back as a blob recall cannot match cleanly.

Write into the namespace your client already uses. With no `MEMWAL_NAMESPACE` and no `--namespace`, that is `default`. A fact imported into another namespace stays invisible to the agent that recalls `default`.

<Warning>
The MCP tools strip obvious credentials before a write. Treat that as a safety net, not a guarantee. The SDK stores the string you pass, and `analyze` sends that string to the relayer's model. Read each passage before an SDK upload, and leave out passwords, API keys, tokens, private keys, and seed phrases.
</Warning>

## Where the files are

Paths below are the ones these clients write on a developer machine. The project directory is encoded by turning `/` into `-`. Claude Code turns the leading `/` into a leading `-`, so `/Users/me/app` becomes `-Users-me-app`. Cursor drops the leading slash, so the same path becomes `Users-me-app`. A folder named `empty-window` is a Cursor window with no project open. Transcripts for a project stay under its encoded path.

### Claude Code

Local memory for one project lives in `~/.claude/projects/<encoded-cwd>/memory/`.

- `MEMORY.md` is an index of links. Skip it, or you store the index on top of the facts.
- Every other `*.md` file is one memory. YAML frontmatter carries `name` and `description`. The body under the frontmatter often has **Why:**, **How to apply:**, and `[[links]]`. Send that body through `analyze`. Uploading the whole body as one memory comes back as a blob recall cannot match cleanly.

Session transcripts are `~/.claude/projects/<encoded-cwd>/*.jsonl`. A turn has `type` of `user` or `assistant`, and a `timestamp`. The words are in `message.content`: a string, or blocks whose `type` is `text`. Skip `tool_use`, `tool_result`, and `thinking` blocks.

### Codex

Standing context is `~/.codex/AGENTS.md` plus `AGENTS.md` in the repo.

Current Codex builds keep consolidated memory in `~/.codex/memories_1.sqlite`, table `stage1_outputs`, column `raw_memory`. When that table has rows, each `raw_memory` value is one thread's summary.

Session transcripts are `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each line has `timestamp` and `payload`. User text is a line whose `type` is `response_item` and whose `payload.role` is `user`; the words are in `payload.content` blocks of type `input_text`. Assistant text is the same line with `payload.role` of `assistant` and blocks of type `output_text`. Skip every other line.

### Cursor

Project rules live in `.cursor/rules/`. User rules live in Cursor Settings.

Transcripts live in `~/.cursor/projects/<encoded-path>/agent-transcripts/<id>/<id>.jsonl`. Each line has `role` and `message`. The words are in `message.content` blocks of type `text`.

### Antigravity

Standing context is `GEMINI.md` and `AGENTS.md` in the project. Install the plugin with:

```bash
npx degit MystenLabs/MemWal/packages/mcp/plugin ~/.gemini/config/plugins/memwal
```

See [Antigravity](/mcp/antigravity).

## Ask the agent to upload

Once `memwal_remember_bulk` and `memwal_analyze` are available, paste this into the client that already holds the session. The agent can see the current conversation, and it can read the files above.

```text
Import my existing memory into Walrus Memory. Use the namespace this client already recalls from.

1. Local memory. Read the memory files for this project (Claude: ~/.claude/projects/<encoded-cwd>/memory/*.md except MEMORY.md; Codex: raw_memory rows in ~/.codex/memories_1.sqlite; Cursor: .cursor/rules and user rules). Send each Claude memory file body through memwal_analyze, one call per chunk of at most 64 KiB. A Codex raw_memory value, or a Cursor rule you have already reduced to one statement, goes through memwal_remember_bulk, at most 20 per call. Wait for that call to finish before the next.
2. Standing context. Read CLAUDE.md, AGENTS.md, GEMINI.md, and Cursor rules. Extract only durable preferences, decisions, constraints, and identity details. Upload those with memwal_remember_bulk, one statement per entry. Leave tool instructions and repo conventions in the files.
3. This session and other recent sessions I name. Keep only the user and assistant text. Claude: message.content text, not tool_use, tool_result, or thinking. Codex: input_text and output_text. Cursor: message.content blocks of type text. Extract durable facts from that text with memwal_analyze, one call per chunk of at most 64 KiB. This tool has no session-time parameter, so include the date in the fact when it matters. Skip one-off tasks, the current bug, and small talk.
4. Skip anything that looks like a secret.
5. If a tool replies ACCEPTED, NOT YET SAVED, call memwal_remember_status with those job_ids and wait until they are saved. If that wait times out, call memwal_remember_status again with the same job_ids. Do not upload those facts again. On HTTP 429, wait for Retry-After, then continue. Then call memwal_recall with a fact you just imported and show me the match.
6. Do not run this import a second time. memwal_remember_bulk has no idempotency key, so a second run stores each fact again. memwal_analyze collapses onto a stored fact only when the new sentence is identical.
```

`memwal_remember_bulk` takes 1 to 20 strings. `memwal_analyze` takes one passage of at most 64 KiB and saves each extracted fact as its own memory. It does not accept a session time. See [MCP Reference](/mcp/reference) for the parameters.

## Batch upload with the SDK

Use the SDK when you want to run the copy yourself. `analyze` is for a Claude memory file and for a transcript: the relayer extracts facts, then stores each one. `rememberBulk` is only for text you have already reduced to one statement per item, at most 20 items per call. `analyze` accepts at most 64 KiB and returns at most 20 facts per call, so walk a long passage in chunks of about 60 KB. A dense chunk can still drop facts past that cap of 20.

On the hosted mainnet relayer the account budget is the service setting: `RATE_LIMIT_REQUESTS_PER_MINUTE=120`, `RATE_LIMIT_REQUESTS_PER_HOUR=1000`, and `RATE_LIMIT_DELEGATE_KEY_PER_MINUTE=60`. A bulk call costs 10, and each status poll of that batch costs 1. An analyze call costs 5 plus 1 for each fact it extracts. Send one chunk, wait until it settles, then send the next. On HTTP 429, wait for the `Retry-After` header before retrying the call that was refused. The hourly refusal asks for 300 seconds. The 1000-per-hour account cap is what stops a long import. A self-hosted relayer with those three variables unset uses the code defaults: 60 per minute, 500 per hour, and 30 per minute per key.

`rememberBulk` and `memwal_remember_bulk` send no idempotency key. Running the script a second time stores each bulk fact again. `analyze` collapses onto the copy already stored only when the extracted fact text is the same for that owner and namespace. A reworded sentence is stored again.

Pass `occurredAt` as the session time for a transcript. Leave it unset for a memory file. The extractor writes that date into the fact text, which is how "yesterday" in an old transcript stays attached to the day it was said. Walrus Memory does not keep a separate event-time field you can filter on.

```ts
import { readFile, readdir } from "node:fs/promises";
import { MemWal } from "@mysten-incubation/memwal";

// MEMWAL_PRIVATE_KEY, MEMWAL_ACCOUNT_ID
// CLAUDE_MEMORY_DIR: directory of Claude memory *.md files
// SESSION_FILE: a session .jsonl, or conversation text you already reduced
// SESSION_TIME: optional RFC 3339 time of that session, e.g. 2026-10-01T09:00:00Z

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: process.env.MEMWAL_NAMESPACE ?? "default",
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Hourly refusals send Retry-After: 300, which is longer than the 120s wait.
function retryAfterMs(err: unknown): number {
  const header = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
  if (typeof header === "number" && header > 0) return header * 1000;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "string") {
    try {
      const seconds = Number(JSON.parse(cause).retry_after_seconds);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } catch {
      // body was not the rate-limit JSON
    }
  }
  return 300_000;
}

function isRateLimited(err: unknown): boolean {
  return (
    (err as { status?: number }).status === 429 ||
    (err as { name?: string }).name === "MemWalRateLimited"
  );
}

// A 429 here means the call was not accepted. Retry that same call.
async function accept<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!isRateLimited(err)) throw err;
      const wait = retryAfterMs(err);
      console.log(`429; waiting ${Math.round(wait / 1000)}s, then retrying this call`);
      await sleep(wait);
    }
  }
}

// Job ids already returned. Poll again. Do not send the text again.
async function confirm(jobIds: string[]) {
  let pending = jobIds;
  const deadline = Date.now() + 26 * 60 * 1000;
  while (pending.length > 0 && Date.now() < deadline) {
    try {
      const result = await memwal.waitForRememberJobs(pending);
      const still = result.results
        .filter((item) => item.status === "timeout")
        .map((item) => item.id);
      console.log(`saved ${result.succeeded}/${result.total}`);
      if (still.length === 0) return;
      console.log("still running; polling these job ids again");
      pending = still;
    } catch (err) {
      if (!isRateLimited(err)) throw err;
      const ids = (err as { jobIds?: string[] }).jobIds;
      if (ids && ids.length > 0) pending = ids;
      const wait = retryAfterMs(err);
      console.log(
        `429 while confirming; waiting ${Math.round(wait / 1000)}s, then polling the same job ids`,
      );
      await sleep(wait);
    }
  }
  if (pending.length > 0) {
    console.log("still running; poll these job ids later, do not send them again");
    console.log(pending.join("\n"));
  }
}

function factFromMemoryFile(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: string; text?: string };
    if (rec.type !== "text" && rec.type !== "input_text" && rec.type !== "output_text") continue;
    if (typeof rec.text === "string" && rec.text.trim()) parts.push(rec.text.trim());
  }
  return parts.join("\n");
}

// Keep user and assistant words. Drop tool output. Plain text passes through.
function dialogueText(raw: string): string {
  const kept: string[] = [];
  let jsonLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: {
      type?: string;
      role?: string;
      message?: { content?: unknown };
      payload?: { role?: string; content?: unknown };
    };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    jsonLines += 1;
    let text = "";
    if (row.type === "user" || row.type === "assistant") {
      text = textFromContent(row.message?.content);
    } else if (
      row.type === "response_item" &&
      (row.payload?.role === "user" || row.payload?.role === "assistant")
    ) {
      text = textFromContent(row.payload?.content);
    } else if (row.role === "user" || row.role === "assistant") {
      text = textFromContent(row.message?.content);
    }
    if (text) kept.push(text);
  }
  if (jsonLines === 0) return raw.trim();
  return kept.join("\n\n");
}

function transcriptChunks(text: string): string[] {
  const buf = Buffer.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(offset + 60_000, buf.length);
    while (end > offset && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    if (end === offset) end = Math.min(offset + 60_000, buf.length);
    const chunk = buf.subarray(offset, end).toString("utf8").trim();
    if (chunk) chunks.push(chunk);
    offset = end;
  }
  return chunks;
}

// One statement per string. A Claude memory file does not belong here.
async function uploadFacts(facts: string[]) {
  for (let i = 0; i < facts.length; i += 20) {
    const batch = facts.slice(i, i + 20).map((text) => ({ text }));
    const accepted = await accept(() => memwal.rememberBulk(batch));
    await confirm(accepted.job_ids);
  }
}

async function analyzePassage(text: string, occurredAt?: string) {
  const accepted = await accept(() =>
    memwal.analyze(text, occurredAt ? { occurredAt } : undefined),
  );
  console.log(`extracted ${accepted.facts.length}`);
  if (accepted.job_ids.length > 0) await confirm(accepted.job_ids);
}

// Claude Code local memory for one project. Skip the MEMORY.md index.
const memoryDir = process.env.CLAUDE_MEMORY_DIR!;
const files = (await readdir(memoryDir)).filter(
  (name) => name.endsWith(".md") && name !== "MEMORY.md",
);
for (const name of files) {
  const body = factFromMemoryFile(await readFile(`${memoryDir}/${name}`, "utf8"));
  for (const chunk of transcriptChunks(body)) await analyzePassage(chunk);
}

// The server rejects analyze text over 64 KiB (65536 bytes). Each call keeps at most 20 facts.
const dialogue = dialogueText(await readFile(process.env.SESSION_FILE!, "utf8"));
if (!dialogue) {
  console.log("no user or assistant text in the session file");
} else {
  for (const chunk of transcriptChunks(dialogue)) {
    await analyzePassage(chunk, process.env.SESSION_TIME);
  }
}
```

The sample splits the accept from the wait. `rememberBulk` and `analyze` throw on HTTP 429, and that call was not stored, so the sample sleeps for `Retry-After` and retries the same call. A 429 after job ids have come back, or a `timeout` while a congested upload is still running (about 25 minutes), polls those ids again. Sending them again pays for a second blob. `waitForRememberJobs` itself stops after 120 seconds, which is shorter than the hourly `Retry-After` of 300 seconds, so the sample sleeps that long on its own.

The Python SDK has the same split: `remember_bulk` or `analyze`, then `wait_for_remember_jobs`. Wrapping `remember_bulk_and_wait` or `analyze_and_wait` in a retry resubmits the batch when the 429 came after the relayer had already accepted it. `occurred_at` is the session time. See the [Python API reference](/python-sdk/api-reference).

Codex `raw_memory` text and a Cursor rule you have already reduced to one statement per item go through `uploadFacts`. A Codex or Cursor transcript goes through `dialogueText`, then `analyzePassage`.

<Tip>
Confirm one fact before you copy a large history. `recall({ query: "<a fact you recognize>", limit: 3 })` should return that fact. The local files stay on disk; this copy does not remove them.
</Tip>

## Keep using what you imported

Install the plugin for the client you work in, so later sessions write to Walrus Memory as you go:

- [Claude Code](/mcp/claude-code)
- [Codex](/mcp/codex)
- [Cursor](/mcp/cursor)
- [Antigravity](/mcp/antigravity)

On Claude Code, merge the Walrus Memory block into `~/.claude/CLAUDE.md` and turn off built-in memory, or the agent keeps writing `MEMORY.md` beside Walrus Memory. That step is in the Claude Code page.

Open a new session and ask for something only the imported fact would answer. When recall returns it, the account is carrying the memory you already had.
