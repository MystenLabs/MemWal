---
title: "Research App Example"
description: >-
  An application-level pattern for storing structured research findings with Walrus Memory and recalling them in later sessions. Structured summaries recall better than raw transcripts because they keep the signal high.
keywords:
  - research app
  - structured memory
  - Walrus Memory
  - MemWal
  - remember
  - recall
goal:
  description: Store structured research findings and recall them effectively in later sessions using the Walrus Memory SDK.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 50
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I store research findings with Walrus Memory?
  - Why do structured summaries recall better than raw transcripts?
  - What is the research app pattern for Walrus Memory?
answer: >-
  The research app pattern stores structured summaries with remember(), generates targeted queries later, and uses recall() to pull relevant findings back into context. Structured summaries recall better than raw transcripts because they preserve high signal content, making semantic search more effective.
---

## Use This When

- you want to store structured research findings
- you want to recall them in later sessions

## Pattern

1. save a structured summary with `remember()`
2. generate targeted queries later
3. use `recall()` to pull relevant findings back into context

## Why This Works

Structured summaries usually recall better than raw transcripts because they keep the signal high.

## Read Next

- [AI Research Assistant with Remember & Recall](/sdk/advanced-usage)
