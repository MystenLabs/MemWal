---
"@mysten-incubation/oc-memwal": patch
---

Wire temporal anchoring through the agent-side memory tools.

### Added

- `memory_store` tool now accepts an optional `occurredAt` argument (RFC-3339 / ISO-8601 string) so agents can anchor recounted past events to the date they actually occurred. Description tells the LLM to omit it when unknown rather than guess.

### Changed

- Auto-capture hook (`agent_end`) now passes `new Date()` as `occurredAt` to `analyze()`. Every captured conversation now gets temporal anchoring automatically — the server extractor resolves in-turn relative references ("yesterday", "last Friday") into absolute dates inside the stored fact text. Facts captured by this version now carry resolved dates.
- SDK dependency bumped from published `^0.0.2` to `workspace:*` to consume the new `AnalyzeOptions` signature.
