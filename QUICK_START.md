# Quick Start Guide - PDW Integration

## 🚀 Start the App

```bash
cd /Users/realestzan/Code/personal-wallet
pnpm run dev
```

Open: **http://localhost:3000/showcase**

---

## ✨ Try These Examples

### Example 1: Store Personal Info
```
User: "My name is Alex and I'm 28 years old"
```
**Expected**:
- ✅ AI detects personal data
- ✅ Stores on Sui blockchain
- ✅ Category: "fact"
- ✅ Shows in memories panel

### Example 2: Test RAG (Retrieval)
```
User: "What's my name?"
```
**Expected**:
- ✅ Searches blockchain
- ✅ Finds: "My name is Alex..."
- ✅ AI responds with your name

### Example 3: Preferences
```
User: "I love pizza and hate broccoli"
```
**Expected**:
- ✅ Category: "preference"
- ✅ Importance: 5-7/10

---

## 📋 Check Logs

### Server Console (Terminal)
Look for:
```
✅ PDW Client initialized successfully
📍 Wallet Address: 0xb59f00b2...
🌐 Network: testnet
🔍 Personal data detected - storing on blockchain...
✅ Memory stored on blockchain!
📍 Memory ID: 0xc42287ae...
🗄️ Blob ID: X14FXpVA...
```

### Browser Console (DevTools)
Look for:
```
✅ Loaded N memories from blockchain
🔗 Memory stored on blockchain: {...}
```

---

## 🔍 Verify on Blockchain

1. **Copy Memory ID** from console (e.g., `0xc42287ae...`)
2. **Open Sui Explorer**: https://suiexplorer.com/?network=testnet
3. **Paste Memory ID** in search
4. **View transaction details**

---

## 🎮 Features to Test

| Feature | How to Test | Expected Result |
|---------|-------------|-----------------|
| **Personal Data Detection** | Send "I am a developer" | Detected & stored |
| **Vector Search (RAG)** | Ask "What do you know about me?" | Retrieves memories |
| **Categories** | Check memories panel | See badges (fact, preference) |
| **Importance** | Look for ⭐ stars | Rating 0-5 stars |
| **Persistence** | Refresh page | Memories still there |
| **Blockchain IDs** | Check blob ID | Shows truncated hash |

---

## 🐛 Troubleshooting

### "PDW Client initialization failed"
- Check `.env` file exists
- Verify `SUI_PRIVATE_KEY` format
- Ensure `GEMINI_API_KEY` is valid

### "No memories showing"
- Check console for errors
- Try sending personal data message
- Click "Refresh from Blockchain"

### Build Errors
- Run: `rm -rf .next && pnpm run build`
- Check `next.config.mjs` has WASM config

---

## 📊 Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    USER INTERFACE                        │
│                   (showcase.tsx)                         │
└─────────────┬───────────────────────────────────────────┘
              │
              ├──────────► POST /api/chat
              │            ├─ Vector Search (PDW)
              │            ├─ Inject Memories
              │            └─ Stream AI Response
              │
              ├──────────► POST /api/chat/extract-memory
              │            ├─ AI Detection
              │            ├─ Classification
              │            ├─ Generate Embedding
              │            ├─ Store on Walrus
              │            ├─ Register on Sui
              │            └─ Update Index
              │
              └──────────► GET /api/memories/list
                           └─ Fetch from Blockchain
                           
┌─────────────────────────────────────────────────────────┐
│                  PDW SDK (Server-Side)                   │
│                  (lib/pdw-service.ts)                    │
├─────────────────────────────────────────────────────────┤
│  • SimplePDWClient                                       │
│  • Vector Search (HNSW)                                  │
│  • AI Classification                                     │
│  • Knowledge Graph                                       │
└─────────────┬───────────────────────────────────────────┘
              │
              ├──────────► Sui Blockchain (Testnet)
              │            └─ Smart Contracts
              │
              ├──────────► Walrus Storage
              │            └─ Decentralized Blobs
              │
              └──────────► Gemini API
                           └─ Embeddings (768-dim)
```

---

## 💾 Data Flow

### Storing a Memory:

```
User Message
    ↓
AI Detection (pdw.ai.shouldSave)
    ↓
Classification (pdw.ai.classifyFull)
    ↓
Generate Embedding (pdw.ai.embed)
    ↓
Upload to Walrus → Blob ID
    ↓
Register on Sui → Memory ID
    ↓
Update HNSW Index
    ↓
Extract Knowledge Graph
```

### Retrieving Memories:

```
User Question
    ↓
Generate Query Embedding
    ↓
Vector Search (HNSW)
    ↓
Top 5 Similar Memories
    ↓
Inject into AI Prompt
    ↓
Personalized Response
```

---

## 🎯 Key Files

| File | Purpose |
|------|---------|
| `lib/pdw-service.ts` | PDW client initialization & helpers |
| `lib/pdw-types.ts` | TypeScript types |
| `app/api/chat/route.ts` | Chat with RAG |
| `app/api/chat/extract-memory/route.ts` | Store on blockchain |
| `app/api/memories/list/route.ts` | Fetch from blockchain |
| `components/showcase.tsx` | UI with blockchain integration |
| `.env` | Configuration (keep secret!) |

---

## 🔐 Security Notes

- ✅ Private keys stay on server-side
- ✅ SEAL encryption available (disabled for now)
- ✅ Blockchain transactions signed server-side
- ✅ Never expose PDW client to browser
- ⚠️ SEAL encryption disabled by default (can enable)

---

## 📚 SDK Methods Used

```typescript
// Detection & Classification
await pdw.ai.shouldSave(content)        // true/false
await pdw.ai.classifyFull(content)      // {category, importance, ...}

// Memory Operations
await pdw.memory.create(content, {category, importance})
await pdw.memory.list()

// Search
await pdw.search.vector(query, {limit: 5})

// Knowledge Graph
await pdw.graph.extract(conversation)

// Embeddings
await pdw.ai.embed(text)  // Float32Array[768]
```

---

## 🎉 Success!

If you see this in your console:
```
✅ PDW Client initialized successfully
📍 Wallet Address: 0xb59f00b2...
```

**You're all set! The integration is working! 🚀**
