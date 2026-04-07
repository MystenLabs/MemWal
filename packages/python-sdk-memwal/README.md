# memwal

Python SDK for [MemWal](https://memwal.ai) — Privacy-first AI memory with Ed25519 signing.

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

## Quick Start

Set your environment variables first:

```bash
export MEMWAL_KEY="your-ed25519-delegate-key-hex"
export MEMWAL_ACCOUNT_ID="0x-your-memwal-account-id"
export MEMWAL_SERVER_URL="https://relayer.memwal.ai"
```

### Async (recommended)

```python
import asyncio
import os
from memwal import MemWal

async def main():
    memwal = MemWal.create(
        key=os.environ["MEMWAL_KEY"],
        account_id=os.environ["MEMWAL_ACCOUNT_ID"],
        server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
    )

    # Store a memory
    result = await memwal.remember("I'm allergic to peanuts")
    print(result.blob_id)

    # Recall memories
    matches = await memwal.recall("food allergies")
    for memory in matches.results:
        print(f"{memory.text} (relevance: {1 - memory.distance:.2f})")

    # Analyze conversation for facts
    analysis = await memwal.analyze("I love coffee and live in Tokyo")
    for fact in analysis.facts:
        print(fact.text)

    await memwal.close()

asyncio.run(main())
```

### Sync

```python
import os
from memwal import MemWalSync

client = MemWalSync.create(
    key=os.environ["MEMWAL_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memwal.ai"),
)

result = client.remember("I'm allergic to peanuts")
matches = client.recall("food allergies")
client.close()
```

### Context Manager

```python
import os
from memwal import MemWal

async with MemWal.create(
    key=os.environ["MEMWAL_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
) as memwal:
    await memwal.remember("I prefer dark mode")
```

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
    key=os.environ["MEMWAL_KEY"],
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
    key=os.environ["MEMWAL_KEY"],
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
| `await remember(text, namespace?)` | Store a memory |
| `await recall(query, limit?, namespace?)` | Search memories |
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
message = f"{timestamp}.{method}.{path}.{sha256(body)}"
```

Headers sent: `x-public-key`, `x-signature`, `x-timestamp`, `x-delegate-key`, `x-account-id`.

## License

MIT
