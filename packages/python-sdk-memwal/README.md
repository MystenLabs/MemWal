# Walrus Memory Python SDK

Python SDK for [Walrus Memory](https://memwal.ai) — Privacy-first AI memory with Ed25519 signing.

All data processing (encryption, embedding, Walrus storage) happens server-side in a TEE. The SDK signs requests with your Ed25519 delegate key and sends text over HTTPS.

## Installation

```bash
pip install memwal
```

With optional integrations:

```bash
pip install memwal[langchain]   # LangChain support
pip install memwal[openai]      # OpenAI SDK support
pip install memwal[all]         # Everything
```

## Try It In Colab

Open the runnable [Walrus Memory Python SDK Colab](https://colab.research.google.com/drive/1SaKjkSp0DXnM_nktWSiEC-l9qGtVr6ph) for a notebook walkthrough covering installation, secure `staging` configuration, optional `prod`, health checks, `remember`, `remember_async`, async job waiting, `recall`, bulk remember, `remember_bulk_async`, `remember_bulk_and_wait`, optional SDK utilities, OpenAI/LangChain middleware, OpenAI-compatible provider settings such as `OPENAI_BASE_URL`, and troubleshooting.

## Quick Start

Set your environment variables first:

```bash
export MEMWAL_PRIVATE_KEY="your-ed25519-delegate-private-key-hex"
export MEMWAL_ACCOUNT_ID="0x-your-walrus-memory-account-id"
export MEMWAL_SERVER_URL="https://relayer.memwal.ai"
```

`MEMWAL_PRIVATE_KEY` is the delegate private key from the Walrus Memory dashboard and
must stay server-side.

### Async (recommended)

```python
import asyncio
import os
from memwal import MemWal, RecallParams

async def main():
    memwal = MemWal.create(
        key=os.environ["MEMWAL_PRIVATE_KEY"],
        account_id=os.environ["MEMWAL_ACCOUNT_ID"],
        server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
    )

    # Store a memory and wait until the background job is searchable
    result = await memwal.remember_and_wait("I'm allergic to peanuts")
    print(result.blob_id)

    # Recall memories
    matches = await memwal.recall(RecallParams(query="food allergies", limit=10, max_distance=0.7))
    for memory in matches.results:
        print(f"{memory.text} (relevance: {1 - memory.distance:.2f})")

    # Analyze conversation for facts and wait until extracted facts are searchable
    analysis = await memwal.analyze_and_wait("I love coffee and live in Tokyo")
    for fact in analysis.facts:
        print(fact.text)

    await memwal.close()

asyncio.run(main())
```

### Sync

```python
import os
from memwal import MemWalSync, RecallParams

client = MemWalSync.create(
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
)

result = client.remember_and_wait("I'm allergic to peanuts")
matches = client.recall(RecallParams(query="food allergies"))
client.close()
```

### Context Manager

```python
import os
from memwal import MemWal

async with MemWal.create(
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
) as memwal:
    await memwal.remember_and_wait("I prefer dark mode")
```

## Environment Presets

Instead of hardcoding a relayer URL, pass `env` to target a hosted relayer.
Same shorthand as the TypeScript SDK and MCP package.

```python
from memwal import MemWal

memwal = MemWal.create(
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    env="prod",   # prod | dev | staging | local
)
```

| `env` | Relayer URL |
|-------|-------------|
| `prod` | `https://relayer.memwal.ai` |
| `dev` | `https://relayer.dev.memwal.ai` |
| `staging` | `https://relayer.staging.memwal.ai` |
| `local` | `http://127.0.0.1:8000` |

Precedence: an explicit non-default **`server_url` wins over `env`**, which wins
over the default. An unknown preset raises `ValueError`. `env` is also accepted
by `MemWalSync.create`, `with_memwal_langchain`, and `with_memwal_openai`.

## AI Middleware

### LangChain

```python
import os
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage
from memwal import with_memwal_langchain

llm = ChatOpenAI(model="gpt-4o")
smart_llm = with_memwal_langchain(
    llm,
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
    max_memories=5,
    min_relevance=0.3,
)

# Memories are automatically recalled and injected
response = await smart_llm.ainvoke([HumanMessage("What are my food allergies?")])
```

### OpenAI SDK

```python
import os
from openai import AsyncOpenAI
from memwal import with_memwal_openai

client = AsyncOpenAI()
smart_client = with_memwal_openai(
    client,
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
)

# Memories are automatically recalled and injected
response = await smart_client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What are my food allergies?"}],
)
```

## API Reference

### `MemWal.create(key, account_id, server_url?, namespace?)`

Create a new async client.

### Methods

| Method | Description |
|--------|-------------|
| `await remember(text, namespace?)` | Accept a background remember job and return `job_id` |
| `await wait_for_remember_job(job_id, ...)` | Poll one remember job until it is searchable |
| `await remember_and_wait(text, namespace?, ...)` | Store a memory and wait until it is searchable |
| `await remember_bulk(items)` | Accept several background remember jobs |
| `await wait_for_remember_jobs(job_ids, opts?)` | Poll several remember jobs together |
| `await remember_bulk_and_wait(items, opts?)` | Store several memories and wait for completion |
| `await recall(RecallParams(query, limit?, namespace?, max_distance?))` | Search memories, optionally filtering by distance |
| `await analyze(text, namespace?)` | Extract and store facts |
| `await ask(question, limit?, namespace?)` | Ask a question answered using memories |
| `await restore(namespace, limit?)` | Restore a namespace |
| `await health()` | Check server health |
| `await remember_manual(opts)` | Store with pre-computed vector |
| `await recall_manual(opts)` | Search with pre-computed vector |
| `await get_public_key_hex()` | Get Ed25519 public key |

## Authentication

Every request is signed with Ed25519:

```
message = f"{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
```

Signed requests send `x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, and `x-account-id`. Relayer-mode requests also send `x-seal-session`; manual-mode requests omit decrypt credentials.

## License

MIT
