---
title: "Onchain Events"
description: >-
  The Sui events emitted by the Walrus Memory smart contract and how the indexer
  uses them to update local backend state, including current coverage details.
keywords:
  - Walrus Memory
  - MemWal
  - onchain events
  - Sui events
  - indexer
  - smart contract
goal:
  description: List the onchain events emitted by the Walrus Memory contract, identify which ones the indexer currently processes, and understand the gap for events not yet covered.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 100
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "What onchain events does the Walrus Memory contract emit?"
  - "Which Sui events does the MemWal indexer listen to?"
  - "What fields are included in the AccountCreated event?"
answer: >-
  The Walrus Memory contract emits AccountCreated, DelegateKeyAdded, DelegateKeyRemoved,
  AccountDeactivated, and AccountReactivated events. The indexer currently targets the
  AccountCreated event flow as its primary sync path; delegate key and activation events
  may be indexed in future iterations.
---

The indexer listens to Sui events emitted by the Walrus Memory contract and uses them to update local backend state.

## Events

The Walrus Memory contract emits the following events:

| Event | Emitted when | Fields |
|-------|-------------|--------|
| `AccountCreated` | A new account is created | `account_id`, `owner` |
| `DelegateKeyAdded` | A delegate key is added | `account_id`, `public_key`, `sui_address`, `label` |
| `DelegateKeyRemoved` | A delegate key is removed | `account_id`, `public_key` |
| `AccountDeactivated` | An account is frozen | `account_id`, `owner` |
| `AccountReactivated` | A frozen account is unfrozen | `account_id`, `owner` |
| `AccountQuarantined` | Admin containment is applied | `account_id`, `owner` |
| `AccountQuarantineCleared` | Admin containment is released | `account_id`, `owner` |

## Current Coverage

The indexer currently targets the `AccountCreated` event flow as its primary sync path. Delegate key events and account activation events are part of the broader design and may be indexed in future iterations.
