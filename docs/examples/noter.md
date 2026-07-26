---
title: Noter Example
description: A note-taking app that turns note content into structured, searchable memories with the analyze operation and zkLogin sign-in.
keywords: [noter, example app, analyze, fact extraction, zkLogin, notes, Next.js]
---

The noter example (`apps/noter`) is a note-taking app with zkLogin sign-in, so users authenticate with OAuth instead of managing a wallet. It shows the note-to-memory pattern: free-form writing becomes structured facts that recall can find later.

## How it uses Walrus Memory

Noter keeps a shared server-side Walrus Memory client and uses `analyze` to turn note content into discrete facts, which the relayer stores asynchronously:

```ts
export const extractMemories = async (text: string): Promise<string[]> => {
  const memwal = getMemWalClient();
  const result = await memwal.analyze(text);
  return (result.facts ?? []).map((f) => f.text);
};
```

Because `analyze` stores each extracted fact as its own memory, later recall returns the specific fact that matches a query instead of a whole note. The user configures the delegate key and account at runtime.

## Run it locally

From the repo root:

```bash
pnpm install
pnpm dev:noter
```

Noter needs a PostgreSQL database and Google OAuth credentials for zkLogin. The [noter source](https://github.com/MystenLabs/MemWal/tree/main/apps/noter) documents its environment variables and setup.
