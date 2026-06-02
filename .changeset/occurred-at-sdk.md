---
"@mysten-incubation/memwal": patch
---

Add optional `occurredAt` to `analyze()` and `analyzeAndWait()` for temporal anchoring of extracted facts.

- New `AnalyzeOptions` overload: `analyze(text, { namespace, occurredAt })` accepts `Date` or RFC-3339 string. The legacy `analyze(text, namespace?)` signature still works unchanged.
- When `occurredAt` is supplied, the server resolves in-turn relative references ("last Friday", "yesterday") into absolute dates inside the extracted fact text before embedding and encryption.
- Wire format is RFC-3339 UTC with millisecond precision (e.g. `"2023-05-25T17:50:00.000Z"`).
- Invalid `Date` instances (constructed from malformed input) now throw a diagnostic `TypeError` from the SDK rather than an opaque `RangeError` from `toISOString()`.
- Field is omitted from the request body when not supplied — existing callers see byte-identical wire payloads.
