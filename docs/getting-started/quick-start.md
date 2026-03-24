---
title: "Quick Start"
---

The fastest way to get MemWal running is through the TypeScript SDK.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ or [Bun](https://bun.sh/) v1+
- A delegate key (Ed25519 private key in hex)
- A MemWalAccount object ID on Sui
- A relayer URL - use a public relayer if one is available to you, or your own local or self-hosted relayer

## Quick Start

<Steps>
  <Step>
    ### Install the SDK

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add @mysten/memwal
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install @mysten/memwal
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add @mysten/memwal
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add @mysten/memwal
        ```
      </Tab>
    </Tabs>

    **Optional packages**

    For AI middleware with [Vercel AI SDK](https://sdk.vercel.ai/) (`@mysten/memwal/ai`):

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

    For the [manual client flow](/getting-started/choose-your-path) (`@mysten/memwal/manual`):

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
    ### Configure the SDK

    Set up the SDK with your delegate key, account ID, and relayer URL:

    ```ts
    import { MemWal } from "@mysten/memwal";

    const memwal = MemWal.create({
      key: "<your-ed25519-private-key>",
      accountId: "<your-memwal-account-id>",
      serverUrl: "https://your-relayer-url.com",
      namespace: "my-app",
    });
    ```

    If you are self-hosting the relayer and do not have `MEMWAL_ACCOUNT_ID` yet, see [Self-Hosting](/relayer/self-hosting) for the account-creation and delegate-key setup flow after the relayer starts.
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
