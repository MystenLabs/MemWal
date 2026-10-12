---
title: Import Your Existing Memory
description: >-
  Copy durable facts from your current session, standing context, and local agent memory
  into Walrus Memory in batches, then keep using them from Claude Code, Codex, or Cursor.
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
  - How do I import my existing Claude, Codex, or Cursor memory into Walrus Memory?
  - How do I batch upload local memories and session history to Walrus Memory?
  - Where do Claude Code, Codex, and Cursor store local memory on disk?
answer: >-
  Read the durable facts already on disk — local memory files, standing context such as
  CLAUDE.md or AGENTS.md, and recent session transcripts — then write them into the same
  namespace your agent recalls from. Use memwal_remember_bulk or rememberBulk for facts
  that are already one statement each, and memwal_analyze or analyze for a transcript.
  After recall returns one of those facts, new sessions keep writing to Walrus Memory
  through the plugin.
---

You already have memory on this machine: facts an agent saved locally, standing instructions it reads every session, and the transcript of the session you are in. Walrus Memory starts empty until those facts are written through it. This page copies the durable ones across, in batches, so the next session recalls what you already had.

Connect Walrus Memory in the client first, and sign in, so the upload and the later recall use the same account. See [MCP](/mcp/overview) for Claude Code, Codex, and Cursor.

## What to copy

Treat the three sources differently. Recall works best on short, self-contained facts.

| Source | What it holds | What to upload |
| --- | --- | --- |
| Local memory | Facts the agent already decided to keep | Each fact, as its own memory |
| Standing context | `CLAUDE.md`, `AGENTS.md`, Cursor rules | Durable preferences, decisions, and identity details pulled out of the file |
| Session transcript | The current chat and recent chats | Facts extracted from the transcript. The SDK can stamp the session time onto those facts |

Leave repository instructions, tool routing, and one-off task notes in the original files. A whole `CLAUDE.md` or a raw transcript stored as one memory comes back as a blob recall cannot match cleanly.

Write into the namespace your client already uses. With no `MEMWAL_NAMESPACE` and no `--namespace`, that is `default`. A fact imported into another namespace stays invisible to the agent that recalls `default`.

<Warning>
The MCP tools strip credential-shaped text before a write. The SDK stores the string you pass. Read each fact before an SDK upload, and leave out passwords, API keys, tokens, private keys, and seed phrases.
</Warning>

## Where the files are

Paths below are the ones these clients write on a developer machine. The project directory is encoded by turning `/` into `-`. Claude Code turns the leading `/` into a leading `-`, so `/Users/me/app` becomes `-Users-me-app`. Cursor drops the leading slash, so the same path becomes `Users-me-app`.

### Claude Code

Local memory for one project lives in `~/.claude/projects/<encoded-cwd>/memory/`.

- `MEMORY.md` is an index of links. Skip it, or you store the index on top of the facts.
- Every other `*.md` file is one memory. YAML frontmatter carries `name` and `description`. The body under the frontmatter is the fact to upload.

Session transcripts are `~/.claude/projects/<encoded-cwd>/*.jsonl`. A turn has `type` of `user` or `assistant`, text in `message.content` (a string, or a list of blocks with `text`), and a `timestamp`.

### Codex

Standing context is `~/.codex/AGENTS.md` plus `AGENTS.md` in the repo.

Current Codex builds keep consolidated memory in `~/.codex/memories_1.sqlite`, table `stage1_outputs`, column `raw_memory`. When that table has rows, each `raw_memory` value is one thread's summary.

Session transcripts are `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each line has `timestamp` and `payload`. User text is a line whose `type` is `response_item` and whose `payload.role` is `user`; the words are in `payload.content` blocks of type `input_text`.

### Cursor

Project rules live in `.cursor/rules/`. User rules live in Cursor Settings.

Transcripts live in `~/.cursor/projects/<encoded-path>/agent-transcripts/<id>/<id>.jsonl`. Each line has `role` and `message`. The words are in `message.content` blocks of type `text`.

## Ask the agent to upload

Once `memwal_remember_bulk` and `memwal_analyze` are available, paste this into the client that already holds the session. The agent can see the current conversation, and it can read the files above.

```text
Import my existing memory into Walrus Memory. Use the namespace this client already recalls from.

1. Local memory. Read the memory files for this project (Claude: ~/.claude/projects/<encoded-cwd>/memory/*.md except MEMORY.md; Codex: raw_memory rows in ~/.codex/memories_1.sqlite; Cursor: .cursor/rules and user rules). Upload each durable fact with memwal_remember_bulk, one complete statement per entry, at most 20 per call.
2. Standing context. Read CLAUDE.md, AGENTS.md, and Cursor rules. Extract only durable preferences, decisions, constraints, and identity details. Upload those with memwal_remember_bulk. Leave tool instructions and repo conventions in the files.
3. This session and other recent sessions I name. Extract durable facts with memwal_analyze. Keep each call under 64 KiB. This tool has no session-time parameter, so include the date in the fact when it matters. Skip one-off tasks, the current bug, and small talk.
4. Skip anything that looks like a secret.
5. If a tool replies ACCEPTED, NOT YET SAVED, call memwal_remember_status with those job_ids and wait until they are saved. Then call memwal_recall with a fact you just imported and show me the match.
```

`memwal_remember_bulk` takes 1 to 20 strings. `memwal_analyze` takes one passage of at most 64 KiB and saves each extracted fact as its own memory. It does not accept a session time. See [MCP Reference](/mcp/reference) for the parameters.

## Batch upload with the SDK

Use the SDK when you want to run the copy yourself. `rememberBulk` is for facts you already have, one statement per item, at most 20 items per call. `analyze` is for a transcript: the relayer extracts facts, then stores each one. `analyze` accepts at most 64 KiB of text and returns at most 20 facts per call, so split a long session into several calls.

Pass `occurredAt` as the session time. The extractor writes that date into the fact text, which is how "yesterday" in an old transcript stays attached to the day it was said. Walrus Memory does not keep a separate event-time field you can filter on.

```ts
import { readFile, readdir } from "node:fs/promises";
import { MemWal } from "@mysten-incubation/memwal";

// MEMWAL_PRIVATE_KEY, MEMWAL_ACCOUNT_ID
// CLAUDE_MEMORY_DIR: directory of Claude memory *.md files
// SESSION_FILE: conversation text to extract from
// SESSION_TIME: optional RFC 3339 time of that session, e.g. 2026-10-01T09:00:00Z

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  // Mainnet. Use https://relayer-staging.memory.walrus.xyz for Testnet.
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: process.env.MEMWAL_NAMESPACE ?? "default",
});

function factFromMemoryFile(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
}

async function uploadFacts(facts: string[]) {
  for (let i = 0; i < facts.length; i += 20) {
    const batch = facts.slice(i, i + 20).map((text) => ({ text }));
    const result = await memwal.rememberBulkAndWait(batch);
    console.log(`saved ${result.succeeded}/${result.total}`);
  }
}

// Claude Code local memory for one project. Skip the MEMORY.md index.
const memoryDir = process.env.CLAUDE_MEMORY_DIR!;
const files = (await readdir(memoryDir)).filter(
  (name) => name.endsWith(".md") && name !== "MEMORY.md",
);
const facts: string[] = [];
for (const name of files) {
  const fact = factFromMemoryFile(await readFile(`${memoryDir}/${name}`, "utf8"));
  if (fact) facts.push(fact);
}
await uploadFacts(facts);

// The server rejects analyze text over 64 KiB (65536 bytes).
const transcript = await readFile(process.env.SESSION_FILE!, "utf8");
const chunk = Buffer.from(transcript).subarray(0, 60_000).toString("utf8");
const analyzed = await memwal.analyzeAndWait(chunk, {
  occurredAt: process.env.SESSION_TIME,
});
console.log(`extracted ${analyzed.facts.length}, saved ${analyzed.succeeded}`);
```

The Python SDK has the same flow: `remember_bulk_and_wait` for facts you already wrote, and `analyze_and_wait` for a transcript (`occurred_at` is the session time). See the [Python API reference](/python-sdk/api-reference).

Codex `raw_memory` text and a Cursor rule you have already reduced to durable statements go through `uploadFacts` the same way. A Codex or Cursor transcript goes through `analyzeAndWait`.

<Tip>
Confirm one fact before you copy a large history. `rememberBulkAndWait` returns `succeeded` per batch. Then `recall({ query: "<a fact you recognize>", limit: 3 })` should return that fact. The local files stay on disk; this copy does not remove them.
</Tip>

## Keep using what you imported

Install the plugin for the client you work in, so later sessions write to Walrus Memory as you go:

- [Claude Code](/mcp/claude-code)
- [Codex](/mcp/codex)
- [Cursor](/mcp/cursor)

On Claude Code, merge the Walrus Memory block into `~/.claude/CLAUDE.md` and turn off built-in memory, or the agent keeps writing `MEMORY.md` beside Walrus Memory. That step is in the Claude Code page.

Open a new session and ask for something only the imported fact would answer. When recall returns it, the account is carrying the memory you already had.
