---
title: "Core Flows"
---



## Save

1. sign `remember`
2. verify delegate access
3. embed and encrypt
4. upload to Walrus
5. store vector metadata under `owner + namespace`

## Recall

1. sign `recall`
2. embed the query
3. search PostgreSQL by `owner + namespace`
4. download matching blobs
5. decrypt and return plaintext

## Analyze

1. send text to `analyze`
2. extract facts
3. store each fact as memory

## Ask

1. send a question
2. recall relevant memories
3. inject them into the prompt
4. return the answer plus used memories

## Manual Client Flow

For `MemWalManual`, the client:

1. embeds locally
2. encrypts locally
3. sends encrypted payload plus vector to the relayer
4. later searches by vector and decrypts locally

## Restore

1. call `restore(namespace, limit?)`
2. discover blobs for one owner and namespace
3. compare blob IDs with local indexed state
4. restore only missing entries
5. decrypt, re-embed, and re-index them

Restore fills gaps. It does not wipe and rebuild everything.
