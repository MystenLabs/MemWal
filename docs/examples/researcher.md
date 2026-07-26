---
title: Researcher Example
description: A research assistant that saves each research sprint as a structured memory and rebuilds context for fresh sessions through recall.
keywords: [researcher, example app, research assistant, remember, recall, session rehydration, long-form memory]
---

The researcher example (`apps/researcher`) is a research assistant that works in sprints. It shows long-form memory and session rehydration: each sprint's findings persist as a structured report, and a fresh session pulls back the relevant history before it starts.

## How it uses Walrus Memory

Researcher composes each sprint into one structured report and stores it with `remember`, then generates recall queries from sprint metadata to rebuild context:

```ts
const fullText =
  `Sprint Report: ${title}\n\n` +
  `${content}\n\n` +
  `References:\n${references}\n\n` +
  `Sources: ${sourceList}`;

const job = await memwal.remember(fullText);
await memwal.waitForRememberJob(job.job_id);
const { results } = await memwal.recall({ query, limit: 5 });
```

The structured report format matters: because the whole sprint lives in one memory, recall returns complete findings with their references and sources attached, and the assistant can cite where earlier conclusions came from.

## Run it locally

From the repo root:

```bash
pnpm install
pnpm dev:researcher
```

The [researcher source](https://github.com/MystenLabs/MemWal/tree/main/apps/researcher) documents its environment variables and setup.
