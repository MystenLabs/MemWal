# PDW SDK Integration Guide

**Two Ways to Integrate PDW into Your Application**

---

## 🎯 Choose Your Integration

### Option 1: AI SDK Tools (pdwTools) - For AI Agents

**Best for:** AI chatbots, autonomous agents, conversational apps

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';

const tools = pdwTools({
  userId: 'user-123',
  embedModel: google.textEmbeddingModel('text-embedding-004'),
  pdwConfig: { /* ... */ }
});

await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools,
  prompt: "Remember I love TypeScript"
});
```

**Features:**
- ✅ AI automatically saves/searches memories
- ✅ 3 tools (search, save, list)
- ✅ Zero manual work
- ✅ Works with any AI SDK model

**Documentation:** [QUICKSTART-AI-SDK.md](./QUICKSTART-AI-SDK.md)

---

### Option 2: Simple Client API (createSimplePDWClient) - For Everything Else

**Best for:** Node.js backends, APIs, serverless, CLI tools, any non-React app

```typescript
import { createSimplePDWClient } from 'personal-data-wallet-sdk';

const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// Direct function calls
await pdw.memory.create('I love TypeScript');
await pdw.search.vector('programming');
await pdw.chat.send(sessionId, 'What do I know?');
```

**Features:**
- ✅ 46 methods across 7 namespaces
- ✅ No React dependencies
- ✅ Works anywhere (Node, browser, serverless)
- ✅ Full control over operations

**Documentation:** [SIMPLE-CLIENT-API.md](./SIMPLE-CLIENT-API.md)

---

## 📊 Comparison

| Feature | pdwTools | Simple Client | React Hooks |
|---------|----------|---------------|-------------|
| **Environment** | Any | Any | React only |
| **Complexity** | Lowest | Low | Medium |
| **Control** | AI decides | Full control | Full control + UI |
| **Use Case** | AI agents | APIs, backends | React apps |
| **Methods** | 3 tools | 46 methods | 16 hooks |
| **Setup** | 1 function | 1 async call | Multiple hooks |

---

## 🎨 Use Cases

### AI Chatbot → Use pdwTools
```typescript
const tools = pdwTools(config);
await generateText({ model, tools, prompt: userMessage });
// AI automatically uses memory
```

### API Endpoint → Use Simple Client
```typescript
app.post('/api/search', async (req, res) => {
  const results = await pdw.search.vector(req.body.query);
  res.json(results);
});
```

### React dApp → Use Hooks
```tsx
function MyComponent() {
  const { mutate } = useCreateMemory();
  return <button onClick={() => mutate({ content })}>Save</button>;
}
```

---

## 🚀 Quick Start Guides

- **pdwTools:** See [QUICKSTART-AI-SDK.md](./QUICKSTART-AI-SDK.md)
- **Simple Client:** See [SIMPLE-CLIENT-API.md](./SIMPLE-CLIENT-API.md)
- **Implementation Status:** See [SIMPLE-CLIENT-STATUS.md](./SIMPLE-CLIENT-STATUS.md)

---

## 📈 Coverage

| Integration | Coverage | Status |
|-------------|----------|--------|
| **pdwTools** | 3/3 tools | ✅ 100% |
| **Simple Client** | 46/143 methods | ✅ 32% |
| **React Hooks** | 16 hooks | ✅ Complete |

**All three integrations are production-ready and can be used today! 🎉**
