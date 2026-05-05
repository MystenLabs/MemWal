---
title: "Changelog"
description: "Release history for the MemWal OpenClaw plugin."
---

Track what's new, changed, and fixed in `@mysten-incubation/oc-memwal`.

For the latest version, see the [npm package page](https://www.npmjs.com/package/@mysten-incubation/oc-memwal).

## 0.0.2

### Internal

- Update `@mysten-incubation/memwal` dependency to `^0.0.2`

## 0.0.1

### Initial Release

- NemoClaw/OpenClaw memory plugin powered by MemWal
- Automatic memory recall via `before_prompt_build` hook
- Automatic fact capture via `agent_end` hook
- Session summary on `before_reset` hook
- CLI commands: `openclaw memwal stats`, `openclaw memwal search`
- LLM tools: `memory_search`, `memory_store`
