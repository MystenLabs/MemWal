# MemWal Demo Script
## Personal Data Wallet - AI-Powered Memory on Blockchain

**Duration:** 5-7 minutes
**Target Audience:** Developers, Web3 enthusiasts, AI builders

---

## PART 1: Introduction (30 seconds)

### Opening Hook
> "What if your AI assistant could actually remember you - not on someone else's server, but on YOUR blockchain wallet?"

### Problem Statement
> "Today, every time you use ChatGPT or any AI assistant, you start from zero. Your preferences, your history, your personal context - gone. And if you do build up a history, it's stored on their servers, not yours."

### Solution
> "MemWal solves this. It's a Personal Data Wallet that stores your AI memories on the Sui blockchain, using Walrus for decentralized storage. You own your data. Encryption and access control are optional - developers can configure based on their use case."

---

## PART 2: Live Demo - Connect Wallet (30 seconds)

### Action: Show Connect Page
> "Let's see it in action. First, I connect my Sui wallet - we support Slush and Sui Wallet"

**Screen:** Show `/connect` page with wallet selection

### Action: Connect Wallet
> "One click to connect. The app now knows my wallet address, but nothing else yet."

**Screen:** Wallet connected, redirect to chat

---

## PART 3: Live Demo - Saving Memories (2 minutes)

### Demo 1: Simple Memory
**Type in chat:**
```
Remember that my name is Aaron
```

> "I just told the AI to remember my name. Watch what happens..."

**Show:**
- Slush wallet popup appears
- Transaction signing (explain: "This is registering my memory on-chain")
- Success notification

> "That memory is now stored on the Sui blockchain and linked to MY wallet. In this demo, encryption is off for simplicity - but developers can enable it with one config option."

### Demo 2: Multiple Memories (Batch)
**Type in chat:**
```
Remember: I love Bitcoin, I hate thick pizza, and I live in Ho Chi Minh City
```

> "MemWal supports batch memories - multiple facts in one transaction. This uses Walrus Quilt format, which saves up to 90% on gas fees."

**Show:**
- Single transaction for multiple memories
- Explain: "3 memories, 1 transaction, ~90% cheaper than individual uploads"

### Demo 3: Verify Memory Works
**Type in chat:**
```
What's my name and where do I live?
```

> "Now let's test if it actually remembers..."

**Show:** AI responds with correct information from blockchain memories

> "The AI retrieved my memories from the blockchain through vector search, found the relevant ones, and used them to answer. All in under 2 seconds."

---

## PART 4: Technical Deep Dive (1.5 minutes)

### Architecture Overview
> "Let me quickly show you what's happening under the hood."

**Show diagram:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MEMWAL ARCHITECTURE                               │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │    User      │
                              │   (dApp)     │
                              └──────┬───────┘
                                     │
                    "Remember that I love Bitcoin"
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMWAL SDK (Client-side)                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │ AI Extract  │───▶│  Embedding  │───▶│   Encrypt   │───▶│   Upload    │  │
│  │   Memory    │    │  Generation │    │  (Optional) │    │   Walrus    │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                     ┌───────────────┼───────────────┐
                     │               │               │
                     ▼               ▼               ▼
              ┌───────────┐   ┌───────────┐   ┌───────────┐
              │   Walrus  │   │    Sui    │   │   Local   │
              │  (Blobs)  │   │(Registry) │   │  (HNSW)   │
              └───────────┘   └───────────┘   └───────────┘
                     │               │               │
                     └───────────────┼───────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │ Vector Search│
                              │   <100ms     │
                              └──────────────┘
```

**Memory Save Flow:**
```
┌────────┐    ┌────────────┐    ┌──────────┐    ┌────────┐    ┌─────────┐
│  User  │───▶│ Extract &  │───▶│ Generate │───▶│ Upload │───▶│Register │
│ Input  │    │  Analyze   │    │Embedding │    │ Walrus │    │  Sui    │
└────────┘    └────────────┘    └──────────┘    └────────┘    └─────────┘
                                                     │              │
                                                     ▼              ▼
                                              ┌──────────────────────────┐
                                              │   Index to Local HNSW    │
                                              │   (for fast retrieval)   │
                                              └──────────────────────────┘
```

**Memory Query Flow:**
```
┌────────┐    ┌────────────┐    ┌──────────┐    ┌────────────┐    ┌────────┐
│  User  │───▶│  Generate  │───▶│  HNSW    │───▶│  Fetch     │───▶│  RAG   │
│ Query  │    │  Embedding │    │  Search  │    │  Content   │    │Response│
└────────┘    └────────────┘    └──────────┘    └────────────┘    └────────┘
                                    │                │
                                    │           ┌────┴────┐
                                    │           │ Walrus  │
                                    │           │(if needed)│
                                    │           └─────────┘
                                    ▼
                              ┌───────────┐
                              │  <100ms   │
                              │  latency  │
                              └───────────┘
```

### Key Components:

1. **Sui Blockchain** - Ownership & on-chain registry
2. **Walrus** - Decentralized blob storage (cheap, permanent)
3. **Seal** - Optional encryption layer by Mysten Labs - enables access control for private data across multiple dApps. Users can grant/revoke access to specific apps
4. **HNSW Index** - Local vector search using Hierarchical Navigable Small World graphs - the same algorithm powering Pinecone and other production vector DBs. Gives us O(log n) search complexity with sub-millisecond latency
5. **OpenRouter** - AI model (Gemini 2.5 Flash for embeddings + chat)

### Show Server Logs (Optional)
> "Here's what the server logs look like when you ask a question..."

**Show logs:**
```
[Cache] Hit for: 0x8b7e6150...
Step 2: Checking for memory commands...
Step 3: Performing vector search...
   Search completed in 45ms
   Results: 3 items
   1. score=87.2%, content="my name is Aaron"
```

---

## PART 5: SDK Integration (1 minute)

### Show Code Example
> "For developers, integrating MemWal is simple. Here's all you need:"

```typescript
import { SimplePDWClient, DappKitSigner } from '@cmdoss/memwal-sdk'

// Initialize with your wallet
const pdw = new SimplePDWClient({
  signer: new DappKitSigner(signAndExecute, address),
  network: 'testnet',
  packageId: 'YOUR_PACKAGE_ID',
  features: {
    enableEncryption: false, // Optional: enable for sensitive data
    enableLocalIndexing: true,
  }
})

// Save a memory
await pdw.memory.save({
  content: "User prefers dark mode",
  category: "preference",
})

// Search memories
const results = await pdw.search.vector("What are user's preferences?")
```

> "That's it. Full blockchain memory in 10 lines of code."

---

## PART 6: Use Cases (45 seconds)

### Who is this for?

1. **AI App Builders**
   > "Build AI assistants that truly know your users - with their consent and ownership"

2. **Personal AI Agents**
   > "Create AI agents that accumulate knowledge over time, stored in user's wallet"

3. **Privacy-Focused Apps**
   > "Medical records, personal journals, sensitive data - enable encryption for maximum privacy, or keep it open for transparency"

4. **Cross-App Memory**
   > "Imagine your AI memory following you across different apps - because YOU own it"

---

## PART 7: Closing (30 seconds)

### Summary
> "MemWal gives you:
>
> - **Ownership**: Your memories in YOUR wallet
> - **Privacy**: Optional encryption with Seal
> - **Portability**: Take your AI context anywhere
> - **Efficiency**: 90% gas savings with Walrus Quilt
> - **Speed**: Sub-second vector search"

### Call to Action
> "The SDK is open source. Try the demo at [demo-url]. Star us on GitHub. And start building AI that remembers."

**Show:**
- GitHub repo link
- Demo app URL
- Discord/contact

---

## APPENDIX: Demo Checklist

### Before Recording:
- [ ] Wallet has testnet SUI (for gas)
- [ ] Clean browser (no cached wallet data)
- [ ] Server running locally or deployed
- [ ] Test all commands work
- [ ] Clear chat history for fresh demo

### Backup Scenarios:
If wallet popup is slow:
> "The wallet is confirming the transaction on-chain - this takes a few seconds on testnet"

If vector search is slow:
> "First search after restart rebuilds the index from blockchain - subsequent searches are instant"

### Key Metrics to Mention:
- Vector search: <100ms (after index warm)
- Memory save: ~3 seconds (including blockchain confirmation)
- Batch upload: 90% gas savings vs individual
- Index dimensions: 3072 (text-embedding-3-large compatible)

---

## Demo Commands Cheatsheet

```
# Save memories
Remember that my name is ...
Remember: I love Bitcoin, I hate Solana, I prefer dark mode
Don't forget that I'm allergic to peanuts

# Query memories
What's my name?
What are my preferences?
What do you know about me?

# Mixed (save + query)
Remember I live in Vietnam and tell me what you know about me
```
