---
title: "withMemWal"
description: "Drop-in memory middleware for Vercel AI SDK apps."
---

Drop-in memory middleware for Vercel AI SDK apps.

```ts
import { generateText } from "ai";
import { withMemWal } from "@mysten/memwal/ai";
import { openai } from "@ai-sdk/openai";

const model = withMemWal(openai("gpt-4o"), {
  key: "<your-ed25519-private-key>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "chatbot-prod",
  maxMemories: 5,
  autoSave: true,
});

const result = await generateText({
  model,
  messages: [{ role: "user", content: "What do you know about me?" }],
});
```

## What It Does

Before generation:

- Reads the last user message
- Runs `recall()` against MemWal
- Filters by relevance
- Injects memory context into the prompt

After generation:

- Optionally runs `analyze()` on the user message
- Saves extracted facts asynchronously

Set a namespace explicitly for each product surface that uses the middleware. Otherwise recalled
and auto-saved memories fall back to `"default"`.

## When To Use Direct SDK Calls Instead

Use direct SDK methods when your app needs precise control over:

- When memory is stored
- Which text is analyzed
- How recall results are displayed or filtered
