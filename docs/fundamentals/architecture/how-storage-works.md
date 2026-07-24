---
title: "How Storage Works"
description: "The lifecycle of a memory in Walrus Memory, from plaintext to encrypted blob on Walrus and searchable vector in the database."
---

When you call `memwal.remember(...)`, the relayer accepts a background job immediately and then stores the memory asynchronously. Here's what happens.

## Storing a memory

<figure>
  <iframe src="/diagrams/interactive_walrus-memory-remember_v1.html"
    style={{width:'100%',height:'710px',border:'0'}}
    title="Walrus Memory Remember: the agent embeds a new memory into a vector, encrypts it client-side with Seal, stores it on Walrus as a durable blob, and indexes it in pgvector by its vector and blob ID."
    loading="lazy"></iframe>
  <figcaption>
    Remember (writing a memory): the agent embeds the memory into a vector, encrypts the
    content with Seal, stores the ciphertext on Walrus as a durable blob, and records the
    vector plus blob ID in a pgvector index so the memory is searchable by meaning.
  </figcaption>
</figure>

<Steps>
  <Step>
    ### Embedding

    The relayer generates a vector embedding from your plaintext content. This embedding is a numerical representation of the meaning of your memory. It's what makes semantic search possible during recall.
  </Step>

  <Step>
    ### Encryption

    The relayer encrypts the plaintext content using Seal (Sui's encryption framework). Only the owner or their authorized delegates can decrypt the encrypted payload.
  </Step>

  <Step>
    ### Blob upload

    The relayer uploads the encrypted payload to Walrus as a blob and attaches metadata, including the namespace, so restore can discover the blob later. Walrus stores it durably across a decentralized network, so there is no single point of failure.
  </Step>

  <Step>
    ### Vector indexing

    The relayer stores the vector embedding (1536 dimensions, from `text-embedding-3-small`), along with the blob ID, owner address, and namespace, in the `vector_entries` table in PostgreSQL with pgvector. An HNSW index on the embedding column enables fast approximate nearest neighbor search during recall.
  </Step>
</Steps>

## Recalling a memory

<figure>
  <iframe src="/diagrams/interactive_walrus-memory-recall_v1.html"
    style={{width:'100%',height:'710px',border:'0'}}
    title="Walrus Memory Recall: the relayer embeds a query, searches pgvector for nearest neighbors, fetches the matching Walrus blobs by blob ID, decrypts them with Seal, and returns them to the agent context."
    loading="lazy"></iframe>
  <figcaption>
    Recall (reading a memory): the relayer embeds the query into the same vector space,
    pgvector returns the nearest stored vectors and their blob IDs, and the relayer fetches
    the matching encrypted blobs from Walrus, decrypts them with Seal, and adds the
    recovered memories to the agent context.
  </figcaption>
</figure>

1. The relayer converts your query into a vector embedding.
2. It searches the database for the closest matching vectors using pgvector's cosine distance operator (`<=>`), scoped to your memory space (`owner + namespace`).
3. It downloads the matching encrypted blobs from Walrus concurrently.
4. It decrypts each blob with Seal using the delegate key.
5. It returns the plaintext results to your app, sorted by distance (most relevant first).

<Note>
If a blob has expired on Walrus (returns 404), the relayer automatically deletes the stale vector entry from the database. This reactive cleanup keeps your recall results clean without manual intervention.
</Note>

## Restoring a memory space

<figure>
  <iframe src="/diagrams/interactive_walrus-memory-restore_v1.html"
    style={{width:'100%',height:'710px',border:'0'}}
    title="Walrus Memory Restore: the relayer re-reads the durable Seal-encrypted blobs on Walrus and re-indexes them to rebuild the pgvector search cache, because the blobs are the source of truth and the index is a derived cache."
    loading="lazy"></iframe>
  <figcaption>
    Restore (rebuilding the index): because Walrus holds every memory as a durable encrypted
    blob, the pgvector index is a rebuildable cache. The relayer re-reads the blobs, decrypts
    them, and re-indexes them to restore search with no data loss.
  </figcaption>
</figure>

If the local database is lost or incomplete, the restore flow rebuilds it from Walrus, the permanent source of truth.

1. The relayer queries onchain Walrus blob objects that the user owns, filtered by namespace metadata.
2. It compares against the local database to find which blobs it already indexed.
3. It downloads, decrypts, re-embeds, and re-indexes only the missing blobs.
4. The restore supports a configurable `limit` (default: 10) to control how many blobs it processes per call.

Restore is incremental and idempotent, so you can call it multiple times safely.

## Two layers, one system

| Layer | Stores | Purpose |
|-------|--------|---------|
| **Walrus** | Encrypted blobs | Durable, decentralized source of truth |
| **PostgreSQL + pgvector** | Vector embeddings + metadata | Fast semantic search for recall |

The database is rebuildable: if it's ever lost, the restore flow can rediscover blobs from Walrus by owner and namespace, then re-embed and re-index them. Walrus is the permanent record.
