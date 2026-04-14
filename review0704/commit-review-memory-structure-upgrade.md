# MemWal Memory Architecture

## 1. Overview

MemWal is a **structured memory layer** for AI agents with privacy-first design. Memories are typed, scored, temporally-aware, and encrypted end-to-end via SEAL + Walrus.

### Core Components

| Component | Role |
|---|---|
| **SDK (TypeScript)** | Client library — `remember()`, `recall()`, `forget()`, `stats()`, `consolidate()` |
| **Server (Rust/Axum)** | API server — auth, embedding, encryption orchestration, vector search |
| **PostgreSQL + pgvector** | Vector DB — stores embeddings, metadata, structured fields |
| **SEAL Sidecar** | Encryption/decryption proxy (threshold encryption) |
| **Walrus** | Decentralized blob storage for encrypted memory payloads |
| **OpenAI API** | Embedding generation + LLM fact extraction/consolidation |

### Memory Schema

| Field | Type | Description |
|---|---|---|
| `id` | `UUID` | Unique memory identifier |
| `owner` | `TEXT` | Sui wallet address (derived from delegate key) |
| `namespace` | `TEXT` | Memory isolation scope (default: `"default"`) |
| `blob_id` | `TEXT` | Walrus blob reference for encrypted payload |
| `embedding` | `VECTOR(1536)` | Semantic embedding vector |
| `memory_type` | `TEXT` | `fact` · `preference` · `episodic` · `procedural` · `biographical` |
| `importance` | `FLOAT` | 0.0 (trivial) → 1.0 (critical) |
| `source` | `TEXT` | `user` · `extracted` · `system` |
| `access_count` | `INTEGER` | Times this memory has been retrieved |
| `last_accessed_at` | `TIMESTAMPTZ` | Last retrieval timestamp |
| `content_hash` | `TEXT` | SHA-256 of plaintext (fast dedup without decrypting) |
| `metadata` | `JSONB` | Tags, context, arbitrary key-values |
| `superseded_by` | `TEXT` | Points to the newer memory that replaced this one |
| `valid_from` | `TIMESTAMPTZ` | When this fact became true |
| `valid_until` | `TIMESTAMPTZ` | When invalidated (NULL = still active) |

---

## 2. API Surface

| Endpoint | Method | Description |
|---|---|---|
| `/api/remember` | POST | Store a memory (auto: embed → encrypt → upload → store) |
| `/api/recall` | POST | Semantic search with composite scoring |
| `/api/analyze` | POST | Extract facts from text → dedup → consolidate → store |
| `/api/forget` | POST | Soft-delete memories by semantic query |
| `/api/consolidate` | POST | LLM-driven merge/dedup/cleanup of existing memories |
| `/api/stats` | POST | Memory statistics (counts, types, importance, storage) |
| `/api/remember/manual` | POST | Store pre-encrypted memory (SDK handles encryption) |
| `/api/recall/manual` | POST | Raw vector search (SDK handles decryption) |
| `/api/ask` | POST | RAG: recall relevant memories → LLM answer |
| `/api/restore` | POST | Restore memories from Walrus backup |
| `/health` | GET | Health check |

---

## 3. Flow Diagrams

### 3.1 Remember

```mermaid
flowchart TD
    A["Client: remember(text, opts?)"] --> B["Auth Middleware<br/>verify delegate key"]
    B --> C["Compute SHA-256<br/>content_hash"]
    C --> D{"content_hash<br/>exists in DB?"}
    
    D -->|Yes| E["touch_memory()<br/>bump access_count"]
    E --> F["Return existing<br/>(id, blob_id, type, importance)"]
    
    D -->|No| G["check_storage_quota()"]
    G --> H["Parallel: embed + SEAL encrypt"]
    H --> I["store_memory_with_transaction()"]
    I --> J["Upload to Walrus<br/>via sidecar"]
    J --> K["Insert vector_entries<br/>with all structured fields"]
    K --> L{"Concurrent<br/>duplicate?"}
    L -->|No| M["Return new<br/>(id, blob_id, type, importance)"]
    L -->|Yes| N["Return existing entry<br/>(race-safe)"]

    style D fill:#f9e79f,stroke:#f39c12
    style L fill:#f9e79f,stroke:#f39c12
    style F fill:#82e0aa,stroke:#27ae60
    style M fill:#82e0aa,stroke:#27ae60
    style N fill:#82e0aa,stroke:#27ae60
```

### 3.2 Recall (with Composite Scoring)

```mermaid
flowchart TD
    A["Client: recall(query, opts?)"] --> B["Auth Middleware"]
    B --> C["Embed query → vector"]
    C --> D["search_similar_filtered()<br/>with type filter, importance filter,<br/>active-only filter"]
    D --> E["Fetch 5× limit results<br/>(oversample for post-filter)"]
    E --> F["For each hit: download + decrypt"]
    
    F --> G["Compute Composite Score"]
    G --> G1["semantic = 1 - distance"]
    G --> G2["importance = stored value"]
    G --> G3["recency = 0.95^days_old"]
    G --> G4["frequency = ln(1+access)/ln(1+maxAccess)"]
    
    G1 --> H["score = W_s × semantic +<br/>W_i × importance +<br/>W_r × recency +<br/>W_f × frequency"]
    G2 --> H
    G3 --> H
    G4 --> H
    
    H --> I["Sort by composite score DESC"]
    I --> J["Truncate to limit"]
    J --> K["touch_memory() for each result"]
    K --> L["Return scored results"]

    style G fill:#d5f5e3,stroke:#2ecc71
    style H fill:#d5f5e3,stroke:#2ecc71
    style L fill:#82e0aa,stroke:#27ae60
```

### 3.3 Analyze (3-Stage Pipeline)

```mermaid
flowchart TD
    A["Client: analyze(text)"] --> B["Auth Middleware"]
    B --> C["Stage 1: EXTRACT<br/>extract_structured_facts_llm()<br/>→ type + importance per fact"]
    C --> D{"Facts found?"}
    D -->|No| E["Return empty"]
    
    D -->|Yes| F["Stage 2: FAST-PATH DEDUP"]
    F --> G["For each fact:<br/>SHA-256 content_hash"]
    G --> H{"Hash exists<br/>in DB?"}
    H -->|Yes| I["touch_memory()<br/>→ dup_results"]
    H -->|No| J["embed fact<br/>→ non_dup_facts"]
    
    I --> K{"All facts<br/>are dups?"}
    J --> K
    K -->|Yes| L["Return early<br/>(no quota consumed)"]
    
    K -->|No| M["check_storage_quota<br/>(only new facts)"]
    M --> N["Stage 3: FIND SIMILAR"]
    N --> O["For each non-dup:<br/>find_similar_existing()"]
    O --> P{"Similar memories<br/>found?"}
    
    P -->|No| Q["Direct ADD path:<br/>encrypt → upload → store"]
    
    P -->|Yes| R["Build integer→UUID mapping"]
    R --> S["Stage 4: LLM BATCH CONSOLIDATION<br/>Single LLM call for ALL facts"]
    S --> T["LLM decides per fact:<br/>ADD / UPDATE / DELETE / NOOP"]
    
    T --> U["Apply decisions"]
    U --> V["ADD: encrypt → upload → store new"]
    U --> W["UPDATE: encrypt + upload new<br/>→ supersede old"]
    U --> X["DELETE: soft_delete_memory()"]
    U --> Y["NOOP: touch_memory()"]
    
    V --> Z["Return results"]
    W --> Z
    X --> Z
    Y --> Z

    style C fill:#aed6f1,stroke:#2980b9
    style F fill:#f9e79f,stroke:#f39c12
    style S fill:#d7bde2,stroke:#8e44ad
    style Z fill:#82e0aa,stroke:#27ae60
```

### 3.4 Forget

```mermaid
flowchart TD
    A["Client: forget(query, opts?)"] --> B["Auth Middleware"]
    B --> C["Embed query → vector"]
    C --> D["search_similar_filtered()<br/>threshold = 1.0 - similarity"]
    D --> E["For each matching hit"]
    E --> F["soft_delete_memory(id)<br/>SET valid_until = NOW()"]
    F --> G["Return { forgotten: count }"]

    style F fill:#f5b7b1,stroke:#e74c3c
    style G fill:#82e0aa,stroke:#27ae60
```

### 3.5 Consolidate

```mermaid
flowchart TD
    A["Client: consolidate(ns?, limit?)"] --> B["Auth Middleware"]
    B --> C["get_active_memories()"]
    C --> D{"< 2 memories?"}
    D -->|Yes| E["Return unchanged"]
    
    D -->|No| F["Decrypt all memories<br/>(dedup by blob_id)"]
    F --> G["Build integer→UUID mapping<br/>(prevent LLM hallucination)"]
    G --> H["llm_batch_consolidation()<br/>Single LLM call"]
    H --> I["Map integer IDs → UUIDs"]
    
    I --> J["Apply each decision"]
    J --> K["NOOP: touch_memory()"]
    J --> L["DELETE: soft_delete_memory()"]
    J --> M["UPDATE: encrypt new text<br/>→ upload → store<br/>→ supersede_memory(old, new)"]
    J --> N["ADD: encrypt → upload → store"]
    
    K --> O["Return stats<br/>(added, updated, deleted, unchanged)"]
    L --> O
    M --> O
    N --> O

    style H fill:#d7bde2,stroke:#8e44ad
    style O fill:#82e0aa,stroke:#27ae60
```

---

## 4. Sequence Diagrams

### 4.1 Remember

```mermaid
sequenceDiagram
    participant C as SDK Client
    participant S as Server
    participant DB as PostgreSQL
    participant LLM as OpenAI API
    participant SEAL as SEAL Sidecar
    participant W as Walrus

    C->>S: POST /api/remember {text, memory_type?, importance?}
    S->>S: SHA-256(text) → content_hash
    S->>DB: find_by_content_hash_full(owner, ns, hash)
    
    alt Duplicate found
        DB-->>S: (id, blob_id, type, importance)
        S->>DB: touch_memory(id) — bump access_count
        S-->>C: 200 {id, blob_id, type, importance}
    else New memory
        S->>DB: check_storage_quota(owner, text_bytes)
        par Parallel operations
            S->>LLM: Generate embedding
            S->>SEAL: SEAL encrypt(text)
        end
        LLM-->>S: vector[1536]
        SEAL-->>S: encrypted_bytes
        S->>S: store_memory_with_transaction()
        S->>SEAL: Upload to Walrus (via sidecar)
        SEAL->>W: Store encrypted blob
        W-->>SEAL: blob_id
        SEAL-->>S: blob_id
        S->>DB: INSERT vector_entries (+ memory_type, importance, content_hash, metadata)
        S-->>C: 200 {id, blob_id, type, importance}
    end
```

### 4.2 Recall

```mermaid
sequenceDiagram
    participant C as SDK Client
    participant S as Server
    participant DB as PostgreSQL
    participant LLM as OpenAI API
    participant SEAL as SEAL Sidecar
    participant W as Walrus

    C->>S: POST /api/recall {query, limit, memory_types?,<br/>min_importance?, scoring_weights?}
    S->>LLM: Generate embedding(query)
    LLM-->>S: query_vector[1536]
    
    S->>DB: search_similar_filtered(vector, owner, ns,<br/>limit×5, active_only, type_filter, min_importance)
    DB-->>S: hits[] {id, blob_id, distance,<br/>memory_type, importance, created_at, access_count}
    
    par For each hit (concurrent)
        S->>W: download_blob(blob_id)
        W-->>S: encrypted_data
        S->>SEAL: seal_decrypt(encrypted_data)
        SEAL-->>S: plaintext
    end
    
    S->>S: Compute composite score per result
    Note right of S: score = W_s × (1-distance)<br/>+ W_i × importance<br/>+ W_r × 0.95^days_old<br/>+ W_f × ln(1+access)/ln(1+max)
    S->>S: Sort by score DESC, truncate to limit
    
    par Touch accessed memories
        S->>DB: touch_memory(id) for each result
    end
    
    S-->>C: 200 {results: [{text, score, distance,<br/>memory_type, importance, access_count}], total}
```

### 4.3 Analyze (3-Stage Pipeline)

```mermaid
sequenceDiagram
    participant C as SDK Client
    participant S as Server
    participant DB as PostgreSQL
    participant LLM as OpenAI API
    participant SEAL as SEAL Sidecar
    participant W as Walrus

    C->>S: POST /api/analyze {text}
    
    rect rgb(173, 216, 230)
        Note over S,LLM: Stage 1 — EXTRACT
        S->>LLM: extract_structured_facts_llm(text)
        LLM-->>S: [{text, memory_type, importance}]
    end

    rect rgb(255, 243, 205)
        Note over S,DB: Stage 2 — FAST-PATH DEDUP
        loop For each extracted fact
            S->>S: SHA-256(fact.text) → hash
            S->>DB: find_by_content_hash(owner, ns, hash)
            alt Duplicate
                DB-->>S: (id, blob_id)
                S->>DB: touch_memory(id)
                S->>S: → dup_results
            else New
                S->>LLM: generate_embedding(fact.text)
                LLM-->>S: vector
                S->>S: → non_dup_facts
            end
        end
    end

    alt All duplicates
        S-->>C: 200 {facts: dup_results}
    end

    S->>DB: check_storage_quota(only new bytes)

    rect rgb(214, 234, 248)
        Note over S,DB: Stage 3 — FIND SIMILAR
        loop For each non-dup fact
            S->>DB: find_similar_existing(vector, threshold=0.7)
            DB-->>S: similar_memories[]
        end
    end

    alt No similar memories found
        rect rgb(200, 255, 200)
            Note over S,W: Direct ADD path
            loop For each fact
                par
                    S->>SEAL: seal_encrypt(fact)
                    S->>LLM: generate_embedding(fact)
                end
                S->>SEAL: upload_blob → Walrus
                S->>DB: insert_vector + structured fields
            end
        end
    else Similar memories exist
        rect rgb(215, 189, 226)
            Note over S,LLM: Stage 4 — LLM BATCH CONSOLIDATION
            S->>S: Build integer→UUID mapping
            S->>W: Download + decrypt similar memories
            S->>LLM: llm_batch_consolidation()<br/>Single call: old_memories + new_facts
            LLM-->>S: [{action, target_id, text}]<br/>ADD / UPDATE / DELETE / NOOP
        end

        rect rgb(200, 255, 200)
            Note over S,W: Apply Decisions
            loop For each decision
                alt ADD
                    S->>SEAL: encrypt(new_text)
                    S->>SEAL: upload → Walrus
                    S->>DB: insert_vector
                else UPDATE
                    S->>SEAL: encrypt(merged_text)
                    S->>SEAL: upload → Walrus
                    S->>DB: insert_vector (new entry)
                    S->>DB: supersede_memory(old_id, new_id)
                else DELETE
                    S->>DB: soft_delete_memory(old_id)
                else NOOP
                    S->>DB: touch_memory(old_id)
                end
            end
        end
    end

    S-->>C: 200 {facts: [{text, id, blob_id}], total}
```

### 4.4 Forget

```mermaid
sequenceDiagram
    participant C as SDK Client
    participant S as Server
    participant DB as PostgreSQL
    participant LLM as OpenAI API

    C->>S: POST /api/forget {query, limit?, threshold?}
    S->>LLM: generate_embedding(query)
    LLM-->>S: query_vector[1536]
    
    Note right of S: threshold (similarity) → distance<br/>distance = 1.0 - threshold
    S->>DB: search_similar_filtered(vector, owner, ns,<br/>limit, active_only=true)
    DB-->>S: hits[] within distance threshold
    
    loop For each matching hit
        S->>DB: soft_delete_memory(hit.id)<br/>SET valid_until = NOW()
    end
    
    S-->>C: 200 {forgotten: count, owner, namespace}
```

### 4.5 Consolidate

```mermaid
sequenceDiagram
    participant C as SDK Client
    participant S as Server
    participant DB as PostgreSQL
    participant LLM as OpenAI API
    participant SEAL as SEAL Sidecar
    participant W as Walrus

    C->>S: POST /api/consolidate {namespace?, limit?}
    S->>DB: get_active_memories(owner, ns, limit)
    DB-->>S: memories[] (id, blob_id, type, importance)
    
    alt < 2 memories
        S-->>C: 200 {unchanged: all}
    end

    Note over S,W: Decrypt all (dedup by blob_id)
    loop For each unique blob_id
        S->>W: download_blob(blob_id)
        W-->>S: encrypted_data
        S->>SEAL: seal_decrypt(encrypted_data)
        SEAL-->>S: plaintext
    end

    S->>S: Build integer→UUID mapping<br/>"0"→uuid1, "1"→uuid2, ...

    rect rgb(215, 189, 226)
        Note over S,LLM: LLM Batch Consolidation
        S->>LLM: Single call with all memories<br/>as both "existing" and "new"
        LLM-->>S: decisions[] {action, target_id, text}
        S->>S: Map integer IDs → UUIDs
    end

    loop Apply each decision
        alt NOOP
            S->>DB: touch_memory(id)
        else DELETE
            S->>DB: soft_delete_memory(id)
        else UPDATE
            S->>SEAL: seal_encrypt(merged_text)
            S->>SEAL: upload → Walrus
            S->>DB: insert_vector (new entry)
            S->>DB: supersede_memory(old_id, new_id)
        else ADD
            S->>SEAL: seal_encrypt(new_text)
            S->>SEAL: upload → Walrus
            S->>DB: insert_vector (new entry)
        end
    end

    S-->>C: 200 {processed, added, updated, deleted, unchanged}
```

---

## 5. Composite Scoring Formula

```
score = W_semantic × (1 - cosine_distance)
      + W_importance × importance
      + W_recency × 0.95^(days_old)
      + W_frequency × ln(1 + access_count) / ln(1 + max_access)
```

| Weight | Default | Meaning |
|---|---|---|
| `W_semantic` | 0.5 | Semantic similarity (primary signal) |
| `W_importance` | 0.2 | Assigned importance score |
| `W_recency` | 0.2 | Newer = higher score (5% decay per day) |
| `W_frequency` | 0.1 | Frequently accessed = more relevant |

---

## 6. SDK Usage

```typescript
// ── Remember ──
await memwal.remember("allergic to peanuts", "health")

await memwal.remember("User prefers dark mode", {
  memoryType: 'preference',
  importance: 0.8,
  tags: ['ui', 'settings'],
})

// ── Recall ──
await memwal.recall("food allergies", 10)

await memwal.recall("food allergies", {
  limit: 5,
  memoryTypes: ['fact', 'biographical'],
  minImportance: 0.3,
  scoringWeights: { semantic: 0.6, importance: 0.3, recency: 0.1 },
})

// ── Forget ──
await memwal.forget("peanut allergy")

// ── Stats ──
await memwal.stats()
// → { total, by_type, avg_importance, storage_bytes, ... }

// ── Consolidate ──
await memwal.consolidate()
// → merge duplicates, resolve conflicts across all memories
```

---

## 7. AI Middleware

The `withMemWal()` middleware automatically injects relevant memories into LLM prompts, grouped by type:

```
[Memory Context] The following are known facts about this user:

📌 Facts:
  ⚡ User is allergic to peanuts (score: 0.92)
  💡 User works at Google (score: 0.78)

⭐ Preferences:
  ⚡ User prefers dark mode (score: 0.85)

👤 Personal Info:
  💡 User's name is Duc, lives in Hanoi (score: 0.71)
```

- Memories are ranked by composite score (not just cosine distance)
- Importance icons: ⚡ (≥ 0.8), 💡 (≥ 0.5)
- Grouped by memory type for better LLM comprehension

---

## 8. Key Design Decisions

| Decision | Rationale |
|---|---|
| **Content hash dedup** | SHA-256 check before any LLM/network call — eliminates exact duplicates at zero cost |
| **Batch LLM consolidation** | 1 LLM call for ALL facts instead of per-fact — cost-efficient, cross-fact awareness |
| **Integer→UUID mapping** | LLM sees `"0","1","2"` instead of UUIDs — prevents hallucinated IDs |
| **Soft-delete** | `valid_until = NOW()` instead of DELETE — full audit trail, recoverable |
| **Supersede chain** | Old memory points to new via `superseded_by` — preserves history |
| **Deferred quota check** | Quota checked AFTER dedup — duplicates don't consume new storage |
| **5× oversampling** | Recall fetches 5× the requested limit, then post-filters by composite score |
| **Temporal validity** | `valid_from` / `valid_until` window — supports time-scoped queries |
