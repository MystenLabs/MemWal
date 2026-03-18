# Ownership and Access

MemWal separates the user who owns data from the keys and services that can interact with it.

## Responsibility Diagram

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "24px" },
  "flowchart": {
    "nodeSpacing": 58,
    "rankSpacing": 72,
    "padding": 26
  }
}}%%
flowchart LR
    Owner[Owner Wallet]
    Delegate[Delegate Key]
    Relayer[Relayer]
    Memory[Memory Operations]

    Owner -->|controls onchain account| Delegate
    Delegate -->|signs app requests| Relayer
    Relayer -->|executes beta workflow| Memory
```

## Owner Wallet

The owner is the Sui account that controls the MemWal account onchain.

## Delegate Keys

Delegate keys are lightweight Ed25519 keys used for day-to-day SDK authentication.
The relayer verifies the delegate key onchain and resolves:

- the owner address
- the account ID

Recall and restore may also use delegate-key material for SEAL-related decryption steps.

## Relayer Role

The relayer is an execution surface, not the owner. It verifies requests, applies namespace
boundaries, and runs the workflow.

## Why This Split Matters

This separation is one of the most important MemWal concepts:

- the **owner wallet** controls the onchain account
- the **delegate key** authenticates app access
- the **relayer** executes the beta workflow

That lets apps act on behalf of the user without taking over the owner wallet.

## Practical Result

In the default SDK path, your app usually needs a delegate key and a relayer URL, not the user's
owner wallet credentials.
