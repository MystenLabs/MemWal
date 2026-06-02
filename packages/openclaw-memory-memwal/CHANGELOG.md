# @mysten-incubation/oc-memwal

## 0.0.4

### Patch Changes

- [#218](https://github.com/MystenLabs/MemWal/pull/218) [`333d327`](https://github.com/MystenLabs/MemWal/commit/333d3279f59c2a033225bc99238b7586474333fb) Thanks [@hungtranphamminh](https://github.com/hungtranphamminh)! - Wire temporal anchoring through the agent-side memory tools.

  ### Added

  - `memory_store` tool now accepts an optional `occurredAt` argument (RFC-3339 / ISO-8601 string) so agents can anchor recounted past events to the date they actually occurred. Description tells the LLM to omit it when unknown rather than guess.

  ### Changed

  - Auto-capture hook (`agent_end`) now passes `new Date()` as `occurredAt` to `analyze()`. Every captured conversation now gets temporal anchoring automatically — the server extractor resolves in-turn relative references ("yesterday", "last Friday") into absolute dates inside the stored fact text. Facts captured by this version now carry resolved dates.
  - SDK dependency bumped from published `^0.0.2` to `workspace:*` to consume the new `AnalyzeOptions` signature.

- Updated dependencies [[`333d327`](https://github.com/MystenLabs/MemWal/commit/333d3279f59c2a033225bc99238b7586474333fb)]:
  - @mysten-incubation/memwal@0.0.7

## 0.0.3

### Patch Changes

- Rebrand package metadata and documentation from MemWal to Walrus Memory.

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
