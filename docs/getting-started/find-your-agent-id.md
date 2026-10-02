---
title: "Find Your Agent ID"
description: "Your Agent ID is your delegate public key. Find and copy it from the dashboard, the MCP credential file, or the SDK."
keywords:
  - agent id
  - MEMWAL_AGENT_ID
  - delegate public key
  - memwal_agent_id
  - follow activity
  - beta testing
---

Your **Agent ID** is your **delegate public key**: a hex-encoded Ed25519 public key (64 hex characters). Every memory you create is stamped on-chain with this value under the `memwal_agent_id` key, so an Agent ID is the stable identifier for the agent that wrote a memory.

<Note>
Each delegate key has its own Agent ID. An account can hold more than one delegate key, so it can have more than one Agent ID. Share the Agent ID for the key your app is configured with.
</Note>

## Find your Agent ID on the dashboard

The dashboard is the fastest way to collect your Agent ID.

<Steps>
  <Step>
    Open the [Walrus Memory dashboard](https://memory.walrus.xyz/dashboard) and connect the wallet that owns your account.
  </Step>
  <Step>
    Go to the **Delegate keys** section. Each row is one delegate key.
  </Step>
  <Step>
    The **Public key (Agent ID)** column holds your Agent ID. Use the copy button on the row to copy the full value. The displayed value is shortened for readability, but the copy button always copies the complete key.
  </Step>
</Steps>

## Other ways to find your Agent ID

### MCP and CLI clients

The stdio MCP package stores your credentials at `~/.memwal/credentials.json`. The **delegate public key** field in that file is your Agent ID. See the [MCP reference](/mcp/reference) for the full list of stored fields.

### SDK

Both SDKs return the Agent ID for the current delegate key.

<Tabs>
  <Tab title="TypeScript">
    ```ts
    const agentId = memwal.getPublicKeyHex();
    console.log(agentId);
    ```
  </Tab>
  <Tab title="Python">
    ```py
    agent_id = memwal.get_public_key_hex()
    print(agent_id)
    ```
  </Tab>
</Tabs>

## Why the Agent ID matters

Because every memory blob is tagged on-chain with `memwal_agent_id`, the Agent ID lets you and the Walrus Memory team attribute and follow the activity tied to a given delegate key. During beta testing, share your Agent ID with the team so they can follow your activity.

<Note>
The Agent ID is your delegate **public** key, so it is safe to share. Never share your delegate **private** key (`MEMWAL_PRIVATE_KEY`). Anyone who holds the private key can act as your agent until you revoke it.
</Note>
