---
title: "Quick Start"
---

The fastest way to get MemWal running is through the TypeScript SDK.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ or [Bun](https://bun.sh/) v1+

## Quick Start

<Steps>
  <Step>
    ### Install the SDK

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add @mysten-incubation/memwal
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install @mysten-incubation/memwal
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add @mysten-incubation/memwal
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add @mysten-incubation/memwal
        ```
      </Tab>
    </Tabs>

    **Optional packages**

    For AI middleware with [Vercel AI SDK](https://sdk.vercel.ai/) (`@mysten-incubation/memwal/ai`):

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add ai
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install ai
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add ai
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add ai
        ```
      </Tab>
    </Tabs>

    For the [manual client flow](/getting-started/choose-your-path) (`@mysten-incubation/memwal/manual`):

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add @mysten/sui @mysten/seal @mysten/walrus
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install @mysten/sui @mysten/seal @mysten/walrus
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add @mysten/sui @mysten/seal @mysten/walrus
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add @mysten/sui @mysten/seal @mysten/walrus
        ```
      </Tab>
    </Tabs>
  </Step>

  <Step>
    ### Generate your account ID and delegate key

    Create a MemWal account ID and delegate private key for your SDK client using one of the hosted endpoints below.

    <Note>
    The following endpoints are provided as a public good by Walrus Foundation.
    </Note>

    | App | URL |
    | --- | --- |
    | **MemWal Playground** | [memwal.ai](https://memwal.ai) |
    | **Walrus-hosted Playground** | [memwal.wal.app](https://memwal.wal.app) |

    For the contract-based setup flow, see [Delegate Key Management](/contract/delegate-key-management) and [MemWal smart contract](/contract/overview).
  </Step>

  <Step>
    ### Choose a relayer

    Use a hosted relayer, or deploy your own [self-hosted relayer](/relayer/self-hosting) with access to a wallet funded with WAL and SUI:

    <Note>
    Following endpoints are provided as public good by Walrus Foundation.
    </Note>

    | Network | Relayer URL |
    | --- | --- |
    | **Production** (mainnet) | `https://relayer.memwal.ai` |
    | **Staging** (testnet) | `https://relayer.staging.memwal.ai` |
  </Step>

  <Step>
    ### Configure the SDK

    Set up the SDK with your delegate key, account ID, and relayer URL:

    ```ts
    import { MemWal } from "@mysten-incubation/memwal";

    const memwal = MemWal.create({
      key: "<your-ed25519-private-key>",
      accountId: "<your-memwal-account-id>",
      serverUrl: "https://relayer.memwal.ai",
      namespace: "my-app",
    });
    ```
  </Step>

  <Step>
    ### Verify your connection

    Run a health check to confirm everything is working:

    ```ts
    await memwal.health();
    ```
  </Step>

  <Step>
    ### Store and recall your first memory

    ```ts
    await memwal.remember("User prefers dark mode and works in TypeScript.");

    const result = await memwal.recall("What do we know about this user?");
    console.log(result.results);
    ```

    That's it - you're up and running.
  </Step>
</Steps>
