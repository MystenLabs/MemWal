---
title: "Example Apps"
description: "Short examples showing how each demo app uses MemWal."
---

The repo includes ready-to-run apps in `apps/` that show different MemWal integration patterns.
This page focuses on app-level patterns,the basic SDK flow covered in [Quick Start](/sdk/quick-start) and [MemWal Usage](/sdk/usage/memwal).

## Run Locally

```bash
pnpm dev:app
pnpm dev:chatbot
pnpm dev:noter
pnpm dev:researcher
```

## [App](https://github.com/MystenLabs/MemWal/tree/main/apps/app)

Onboarding app, account dashboard, playground, and interactive demo for MemWal.

```ts
const memwal = MemWal.create({
  key: delegateKey,
  accountId: accountObjectId,
  serverUrl,
  namespace,
});

await memwal.remember(rememberText);
await memwal.recall(recallQuery, 5);
await memwal.analyze(analyzeText);
```

This app covers the full getting-started flow in one place. It signs users in, sets up delegate keys, shows SDK credentials, and includes a live playground for `remember()`, `recall()`, `analyze()`, `restore()`, AI middleware, and manual mode.

## [Chatbot](https://github.com/MystenLabs/MemWal/tree/main/apps/chatbot)

AI chat app with persistent memory across sessions.

```ts
import { withMemWal } from "@mysten/memwal/ai";

const model = withMemWal(baseModel, {
  key,
  accountId,
  serverUrl,
  maxMemories: 5,
  autoSave: true,
});
```

This app shows AI middleware integration in a production-style chat app. The UI can enable MemWal, collect a delegate key and account ID, and pass them to the chat API. The server wraps the selected model with `withMemWal`, so recall happens before generation and new context can be auto-saved after each turn.

## [Noter](https://github.com/MystenLabs/MemWal/tree/main/apps/noter)

Note-taking app that stores insights as encrypted, searchable memory.

```ts
export const extractMemories = async (text: string): Promise<string[]> => {
  const memwal = getMemWalClient();
  const result = await memwal.analyze(text);
  return (result.facts ?? []).map((f) => f.text);
};
```

This app shows note-to-memory extraction. Noter keeps a shared server-side MemWal client, lets the user configure the key and account at runtime, and uses `analyze()` to turn note content into structured facts that can be reused by the editor and AI features.

## [Researcher](https://github.com/MystenLabs/MemWal/tree/main/apps/researcher)

Research assistant that saves and recalls findings across sessions.

```ts
const fullText =
  `Sprint Report: ${title}\n\n` +
  `${content}\n\n` +
  `References:\n${references}\n\n` +
  `Sources: ${sourceList}`;

await memwal.remember(fullText);
const { results } = await memwal.recall(query, 5);
```

This app shows long-form research memory and session rehydration. Researcher saves each sprint as a structured report in MemWal, then generates recall queries from sprint metadata, pulls back the most relevant findings, and rebuilds context for a fresh session.
