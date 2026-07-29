---
title: Example Apps
description: >-
  Short examples showing how each demo app in the MemWal repo uses Walrus Memory,
  including the Playground, Chatbot, Noter, and Researcher integration patterns.
keywords:
  - Walrus Memory
  - MemWal
  - example apps
  - demo
  - Playground
  - Chatbot
  - integration patterns
goal:
  description: Identify which example app matches your integration pattern, clone and run it locally, and use it as a starting point for your own Walrus Memory integration.
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
  - What example apps are included in the Walrus Memory repo?
  - How does the MemWal Chatbot app integrate AI middleware with memory?
  - How do I run the MemWal demo apps locally?
answer: >-
  The MemWal repo includes four demo apps: Playground (full SDK playground), Chatbot
  (AI middleware with persistent memory), Noter (note-to-memory extraction using analyze),
  and Researcher (long-form research memory with session rehydration). After configuring
  each app's environment and database, run them with pnpm dev:app, pnpm dev:chatbot,
  pnpm dev:noter, or pnpm dev:researcher.
---

The repo includes ready-to-run apps in `apps/` that show different Walrus Memory integration patterns. Start here for app-level patterns; [Quick Start](/sdk/quick-start) and [Walrus Memory Usage](/sdk/usage/memwal) cover the basic SDK flow.

## Run locally

Each app needs its own environment file and database setup before it starts; the chatbot, noter, and researcher pages below cover the exact steps. After configuring an app, run it from the repo root:

```bash
pnpm dev:app
pnpm dev:chatbot
pnpm dev:noter
pnpm dev:researcher
```

## [Playground](https://github.com/MystenLabs/MemWal/tree/main/apps/app)

Dashboard, playground, and interactive demo for Walrus Memory.

```ts
const memwal = MemWal.create({
  key: delegateKey,
  accountId: accountObjectId,
  serverUrl,
  namespace,
});

const job = await memwal.remember(rememberText);
await memwal.waitForRememberJob(job.job_id);
await memwal.recall({ query: recallQuery, limit: 5 });
await memwal.analyze(analyzeText);
```

This app covers the full getting-started flow in one place. It signs users in, sets up delegate keys, shows SDK credentials, and includes a live playground for `remember()`, `recall()`, `analyze()`, `restore()`, AI middleware, and manual mode.

## The demo apps

Each demo app has its own page with the integration pattern it shows, the key code, and run instructions:

- **Chatbot:** [An AI chat app](/examples/chatbot) that wraps its model with the AI middleware, so recall runs before each generation and new context saves automatically.
- **Noter:** [A note-taking app](/examples/noter) with zkLogin sign-in that turns note content into structured, searchable facts through `analyze`.
- **Researcher:** [A research assistant](/examples/researcher) that saves each sprint as a structured report and rebuilds context for fresh sessions through recall.
