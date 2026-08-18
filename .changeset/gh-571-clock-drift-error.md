---
"@mysten-incubation/memwal": patch
---

Surface relayer clock-drift rejections as an actionable error (#571).

When the relayer rejects a signed request because the client's timestamp is outside its accepted clock-drift window, it now returns `401` with an `x-auth-error: ERR_TIMESTAMP_OUT_OF_BOUNDS` header. The SDK detects this on both the Relayer and manual request paths and throws a clear error (`serverCode: "ERR_TIMESTAMP_OUT_OF_BOUNDS"`) telling the caller to synchronize the client clock — instead of an opaque `401`. Fully backward-compatible: responses without the header behave exactly as before.
