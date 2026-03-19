# Storage Structure

MemWal splits storage into a payload layer and an index layer.

## Storage Diagram

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "36px" },
  "flowchart": {
    "nodeSpacing": 96,
    "rankSpacing": 120,
    "padding": 54
  }
}}%%
flowchart LR
    App[App]
    SDK[SDK]
    Relayer[Relayer]
    Blob[Walrus Blob<br/>encrypted payload]
    Index[Indexer]

    App --> SDK
    SDK --> Relayer
    Relayer --> Blob
    Relayer --> Index
    Index --> Blob
```

## Payload Layer

- encrypted payloads live on Walrus
- blob metadata carries `memwal_namespace`

## Index Layer

- PostgreSQL stores vectors
- entries are keyed by `owner + namespace + blob_id`
- this is what recall searches

## Logical Boundary

`owner + namespace` is the practical memory boundary in the current system.

## Restore Flow

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "24px" },
  "flowchart": {
    "nodeSpacing": 82,
    "rankSpacing": 105,
    "padding": 40
  }
}}%%
flowchart TD
    Chain[Query blobs by
     owner + namespace]
    Compare[Compare with local vector entries]
    Missing[Find missing blob IDs]
    Download[Download + 
    decrypt missing blobs]
    Reindex[Re-embed + insert into PostgreSQL]

    Chain --> Compare --> Missing --> Download --> Reindex
```

Restore is incremental:

1. find blobs for one owner and namespace
2. compare with local indexed state
3. restore only missing entries

## Why This Split Exists

- Walrus is the durable payload layer
- PostgreSQL is the searchable local index
- the relayer can rebuild the index without rewriting the payload layer
