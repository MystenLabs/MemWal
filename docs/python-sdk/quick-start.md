---
title: "Quick Start"
description: "Install the Walrus Memory Python SDK and store your first memory in under a minute."
---

The Walrus Memory Python SDK (`memwal` on PyPI) gives your app persistent, encrypted memory — store, recall, and analyze context across sessions. It mirrors the TypeScript `MemWal` client: same relayer, same Ed25519 auth, same methods.

| Entry point | Import | When to use |
| --- | --- | --- |
| `MemWal` | `from memwal import MemWal` | **Recommended default** — async-native, relayer handles embeddings, SEAL, and storage |
| `MemWalSync` | `from memwal import MemWalSync` | Scripts, notebooks, and non-async apps — same API, runs through `asyncio.run()` |
| `with_memwal_langchain` / `with_memwal_openai` | `from memwal import ...` | You already use LangChain or the OpenAI SDK and want memory as middleware |

## Installation

```bash
pip install memwal
```

## Try It In Colab

Open the runnable [Walrus Memory Python SDK Colab](https://colab.research.google.com/drive/1SaKjkSp0DXnM_nktWSiEC-l9qGtVr6ph) for a notebook walkthrough covering installation, secure configuration, health checks, `remember`, `remember_async`, async job waiting, `recall`, bulk remember, `remember_bulk_async`, `remember_bulk_and_wait`, optional SDK utilities, OpenAI/LangChain middleware, OpenAI-compatible provider settings such as `OPENAI_BASE_URL`, and basic troubleshooting. It defaults to `staging` for test credentials and can switch to `prod` for production credentials.

Optional integrations:

<CodeGroup>

```bash LangChain
pip install memwal[langchain]
```

```bash OpenAI
pip install memwal[openai]
```

```bash Everything
pip install memwal[all]
```

</CodeGroup>

Requires Python 3.9+. Core dependencies are `httpx` and `PyNaCl` (Ed25519 signing).

## Configuration

Before wiring the SDK into your app:

- Generate a Walrus Memory account ID and delegate private key for your client using the hosted endpoint:
  - Production (mainnet): `https://memwal.ai`
  - Staging (testnet): `https://staging.memwal.ai`
- Choose a relayer:
  - Use the [managed relayer](/relayer/public-relayer), selected with the `env` preset
  - Or pass an explicit `server_url` to your own relayer

`MemWal.create` takes the following arguments:

| Argument | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `key` | `str` | Yes | — | Ed25519 delegate private key in hex |
| `account_id` | `str` | Yes | — | Walrus Memory account object ID on Sui |
| `server_url` | `str` | No | `http://localhost:8000` | Explicit relayer URL — wins over `env` |
| `namespace` | `str` | No | `"default"` | Default namespace for memory isolation |
| `env` | `str` | No | — | Hosted relayer preset: `staging` for testing or `prod` for production |

### Environment presets

Instead of hardcoding a URL, pass `env`. The public docs and Colab example use `staging` for testing and `prod` for production credentials.

| `env` | Relayer URL |
| --- | --- |
| `prod` | `https://relayer.memwal.ai` |
| `staging` | `https://relayer.staging.memwal.ai` |

Precedence: an explicit non-default `server_url` > `env` > the default. An unknown preset raises `ValueError`.

## First Memory

`remember` returns as soon as the relayer accepts the job (~500ms); the upload + on-chain commit run in the background. Use `remember_and_wait` to block until it is fully persisted.

```python
import asyncio
import os
from memwal import MemWal, RecallParams

async def main():
    memwal = MemWal.create(
        key=os.environ["MEMWAL_PRIVATE_KEY"],
        account_id=os.environ["MEMWAL_ACCOUNT_ID"],
        env="prod",
        namespace="demo",
    )

    await memwal.health()
    await memwal.remember_and_wait("I live in Hanoi and prefer dark mode.")

    result = await memwal.recall(RecallParams(query="What do we know about this user?"))
    for memory in result.results:
        print(memory.text, f"(distance: {memory.distance:.3f})")

    await memwal.close()

asyncio.run(main())
```

Prefer a synchronous style? Swap `MemWal` for `MemWalSync` and drop the `await`s — see [Usage](/python-sdk/usage).

## Next Steps

- [Usage](/python-sdk/usage) — async vs sync, namespace rules, manual methods, and middleware
- [API Reference](/python-sdk/api-reference) — full method signatures and result types
- [Changelog](/python-sdk/changelog) — release history for `memwal`
