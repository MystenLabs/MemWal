# Unit Tests for PDW SDK

Các file test modular cho từng feature cơ bản của Personal Data Wallet SDK.

## 📁 Test Files

| File | Feature | Description |
|------|---------|-------------|
| `01-embedding.ts` | **Embedding** | Test EmbeddingService: single/batch embeddings, similarity calculation |
| `02-encryption.ts` | **Encryption** | Test encryption/decryption với SEAL |
| `03-storage-upload.ts` | **Storage** | Test upload blob lên Walrus (encrypted & plain) |
| `04-vector-index.ts` | **Vector Index** | Test HNSW indexing và semantic search |
| `05-retrieval.ts` | **Retrieval** | Test memory retrieval với filters và hybrid search |

---

## 🚀 Setup

### 1. Environment Variables

Tạo file `.env` trong root của `packages/pdw-sdk/`:

```bash
# API Keys
GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_AI_API_KEY=your_google_ai_api_key_here

# Optional
OPENAI_API_KEY=your_openai_key
COHERE_API_KEY=your_cohere_key
```

### 2. Install Dependencies

```bash
npm install
```

---

## ▶️ Chạy Tests

### Cách 1: Sử dụng npm scripts (Recommended)

```bash
# Test tất cả
npm run test:unit

# Test từng file
npm run test:embedding
npm run test:encryption
npm run test:storage
npm run test:vector
npm run test:retrieval
```

### Cách 2: Chạy trực tiếp với tsx

```bash
# Test embedding
npx tsx examples/unit/01-embedding.ts

# Test encryption
npx tsx examples/unit/02-encryption.ts

# Test storage
npx tsx examples/unit/03-storage-upload.ts

# Test vector
npx tsx examples/unit/04-vector-index.ts

# Test retrieval
npx tsx examples/unit/05-retrieval.ts
```

### Cách 3: Với ts-node

```bash
npx ts-node examples/unit/01-embedding.ts
```

---

## 📝 Test Details

### 01-embedding.ts
- ✅ Initialize EmbeddingService với Google Gemini
- ✅ Generate single text embedding
- ✅ Generate batch embeddings
- ✅ Calculate cosine similarity
- ✅ Vector operations (normalize, distance)
- ✅ Service statistics

**Expected output:**
```
✅ Embedding generated:
   - Dimensions: 768
   - Model: text-embedding-004
   - Processing time: ~500ms
```

---

### 02-encryption.ts
- ✅ Initialize SEAL encryption
- ✅ Encrypt/decrypt text
- ✅ Encrypt/decrypt JSON
- ✅ Encrypt/decrypt binary data
- ✅ Verify data integrity

**Expected output:**
```
✅ Text decrypted:
   - Original: "This is a secret..."
   - Decrypted: "This is a secret..."
   - Match: ✅ Yes
```

---

### 03-storage-upload.ts
- ✅ Upload plain text blob
- ✅ Upload encrypted blob
- ✅ Upload JSON blob
- ✅ Retrieve blob from Walrus
- ✅ Verify data integrity

**Expected output:**
```
✅ Blob uploaded:
   - Blob ID: abc123...
   - Content size: 52 bytes
   - Encrypted: No
```

**Note:** Blobs may take a few minutes to become available on Walrus network.

---

### 04-vector-index.ts
- ✅ Create HNSW vector index
- ✅ Add vectors to index
- ✅ Search similar vectors
- ✅ Multiple query search
- ✅ Index statistics
- ✅ Save/load index

**Expected output:**
```
✅ Search results:
   1. Similarity: 0.9234
      Text: "Machine learning and AI"
```

---

### 05-retrieval.ts
- ✅ Add memories with metadata
- ✅ Semantic search
- ✅ Filtered search (by category)
- ✅ Search by importance
- ✅ Hybrid search (vector + metadata)

**Expected output:**
```
✅ Results found: 3
   1. "Team meeting about Q4..."
   Category: work, Importance: 8
```

---

## 🔧 Troubleshooting

### Lỗi: "Cannot find module 'ai'"

```bash
npm install ai @ai-sdk/google
```

### Lỗi: "GEMINI_API_KEY not found"

Đảm bảo file `.env` có:
```
GEMINI_API_KEY=your_key_here
```

### Lỗi: "Cannot connect to Walrus"

- Kiểm tra network (testnet/mainnet)
- Đảm bảo có SUI tokens để trả phí gas
- Blobs có thể cần vài phút để available

### Lỗi: Build/TypeScript errors

```bash
# Build lại
npm run build

# Hoặc chạy trực tiếp với tsx (không cần build)
npx tsx examples/unit/01-embedding.ts
```

---

## 📊 Performance Benchmarks

| Test | Average Time | Notes |
|------|-------------|-------|
| Embedding (single) | ~500ms | Depends on API latency |
| Embedding (batch 10) | ~2s | ~200ms per text |
| Encryption | ~50ms | For 1KB data |
| Upload to Walrus | ~3-5s | Network dependent |
| Vector search | ~10ms | For 1000 vectors |
| Full retrieval | ~1s | Including decryption |

---

## 🎯 Next Steps

After running unit tests successfully:

1. ✅ Run integration tests: `npm run test:integration`
2. ✅ Check out full examples: `examples/integration/`
3. ✅ Read SDK docs: [CLAUDE.md](../../CLAUDE.md)
4. ✅ Build your app with PDW SDK!

---

## 💡 Tips

- **Start with 01-embedding.ts** - Đơn giản nhất, không cần blockchain
- **Run tests sequentially** - Dễ debug hơn
- **Check logs carefully** - Mỗi test có detailed output
- **Save test data** - Index files được lưu trong `.tmp/`
- **Use small datasets** - Để test nhanh hơn

---

## 🐛 Known Issues

1. **Walrus upload timeout**: Network có thể chậm, tăng timeout nếu cần
2. **HNSW index size**: Index files có thể lớn, nhớ cleanup `.tmp/`
3. **API rate limits**: Google Gemini có rate limit, thêm delays nếu cần

---

## 📚 Resources

- [PDW SDK Documentation](../../CLAUDE.md)
- [Sui Documentation](https://docs.sui.io/)
- [Walrus Documentation](https://docs.walrus.site/)
- [Vercel AI SDK](https://sdk.vercel.ai/)
