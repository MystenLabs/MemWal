---
title: "Cookbook: Multi-Tenant Server Apps"
description: "Serve many end users from one MemWalAccount using a delegate key on the server and a namespace per user wallet."
---

This is the pattern for SaaS-style apps where **one operator** runs a server that stores memory on behalf of **many end users** — for example a Next.js app on Vercel where users connect a Sui wallet only for sign-in, and the server holds the credentials.

## The Pattern at a Glance

| Layer | What it holds | Why |
| --- | --- | --- |
| **Operator** | One `MemWalAccount` + one **delegate key** | Created once on the [dashboard](https://memory.walrus.xyz). Pays for storage, owns all memory. |
| **Server** (API routes) | `MEMWAL_PRIVATE_KEY` + `MEMWAL_ACCOUNT_ID` as env vars | The delegate key authenticates every relayer call. Never sent to the browser. |
| **End user** | A connected Sui wallet, used for **auth only** | The wallet proves identity. The user does **not** create a MemWalAccount. |
| **Isolation** | One **namespace per wallet**, e.g. `myapp-{walletAddress}` | Keeps each user's memories in a separate logical bucket under the shared account. |

```
                  ┌─────────────────────────────────────┐
  End user wallet │  Server (Next.js API route, Vercel)  │   Relayer + Walrus
  (auth only)     │                                      │
       │ sign-in  │  MemWal.create({                     │
       ├─────────▶│    key:       MEMWAL_PRIVATE_KEY,     │
       │          │    accountId: MEMWAL_ACCOUNT_ID,      │   one MemWalAccount
       │          │  })                                   │   ├─ ns: myapp-0xalice…
       │ request  │  ns = `myapp-${address.toLowerCase()}`│──▶├─ ns: myapp-0xbob…
       ├─────────▶│  memwal.remember(text, ns)            │   └─ ns: myapp-0xcarol…
       │          │  memwal.recall({ query, namespace })  │
       └──────────┴──────────────────────────────────────┘
```

## 1. Set Up the Delegate Key (not the owner key)

Create the account and a delegate key once, on the [Walrus Memory dashboard](https://memory.walrus.xyz). The dashboard gives you:

- A **MemWalAccount object ID** (`0x…`) → your `MEMWAL_ACCOUNT_ID`
- A **delegate private key** (hex) → your `MEMWAL_PRIVATE_KEY`

<Warning>
Use a **delegate key**, never the **owner** wallet key. The owner key can transfer the account and manage delegates; a delegate key can only read and write memory. If a delegate key leaks, you revoke it without touching the owner wallet. See [Delegate Key Management](/contract/delegate-key-management).
</Warning>

Store both as server-side environment variables:

```bash .env.local
MEMWAL_PRIVATE_KEY=<delegate-private-key-hex>
MEMWAL_ACCOUNT_ID=0x<memwal-account-object-id>
```

### Revoke flow

If a delegate key is compromised, revoke it from the [dashboard](https://memory.walrus.xyz), or programmatically with the **owner** credentials:

```ts
import { removeDelegateKey } from "@mysten-incubation/memwal/account";

await removeDelegateKey({
  packageId: "0x<contract-package-id>",
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  publicKey: "<delegate-public-key-hex>", // the leaked key's public key
  suiPrivateKey: "suiprivkey1...",        // owner key — kept offline, NOT on the server
});
```

Then generate a fresh delegate key, register it with `addDelegateKey`, and rotate `MEMWAL_PRIVATE_KEY`. See the full lifecycle in [Delegate Key Management](/contract/delegate-key-management).

## 2. Namespace Naming for Multi-User Apps

Derive a deterministic namespace from the authenticated wallet address. Normalize it so the same wallet always maps to the same namespace:

```ts
// lib/memory/namespace.ts
export function userNamespace(walletAddress: string): string {
  return `myapp-${walletAddress.toLowerCase()}`;
}
```

Guidelines:

- **Prefix with your app name** (`myapp-…`) so multiple apps can share one account without colliding.
- **Lowercase the address** — namespaces are matched exactly, with no prefix or hierarchy, so `0xAB…` and `0xab…` are different buckets.
- **Keep it stable** — never include a timestamp or session ID, or you lose the user's history on the next request.

<Warning>
A namespace is a **data-organization boundary, not a security boundary between users.** The delegate key can read and write **every** namespace under the account. Cross-user isolation depends entirely on your server mapping each *authenticated* wallet to the correct namespace. Verify the wallet signature **before** choosing the namespace — never take the namespace (or raw address) from an unauthenticated request body.
</Warning>

## 3. Next.js / Serverless Example

Create one client per request (or memoize per warm Lambda) and pass the per-user namespace into each call.

```ts
// lib/memory/client.ts
import { MemWal } from "@mysten-incubation/memwal";

export function getMemWal() {
  return MemWal.create({
    key: process.env.MEMWAL_PRIVATE_KEY!,
    accountId: process.env.MEMWAL_ACCOUNT_ID!,
    serverUrl: "https://relayer.memory.walrus.xyz",
  });
}
```

```ts
// app/api/chat/route.ts  (Next.js App Router)
import { getMemWal } from "@/lib/memory/client";
import { userNamespace } from "@/lib/memory/namespace";
import { verifyWalletAuth } from "@/lib/auth"; // your wallet-signature check

export async function POST(req: Request) {
  // 1. Authenticate the user from a signed message — NOT from a raw address field.
  const session = await verifyWalletAuth(req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const ns = userNamespace(session.walletAddress);
  const { message } = await req.json();
  const memwal = getMemWal();

  // 2. Load relevant memory for this user.
  const recalled = await memwal.recall({
    query: message,
    namespace: ns,
    limit: 5,
  });

  // 3. Generate a reply with your model, injecting recalled.results as context…
  const reply = await generateReply(message, recalled.results);

  // 4. Persist new memory. Use rememberAndWait when the next read must see it
  //    immediately (e.g. same-session follow-up); use remember (fire-and-forget)
  //    when eventual indexing is fine and you don't want to block the response.
  await memwal.remember(`User said: ${message}`, ns);

  return Response.json({ reply, recalled: recalled.results });
}
```

<Note>
**Structured agent state (a single profile JSON):** semantic `recall` is built for *fuzzy* retrieval by meaning, so it is not a reliable way to fetch one authoritative "current profile" record. If you need deterministic key-based reads/upserts, follow [issue #247](https://github.com/MystenLabs/MemWal/issues/247) — for now, prefer a **dedicated namespace per structured record** and treat free-form semantic lines separately.
</Note>

## 4. Security Checklist

<Steps>
<Step title="Keep the delegate key server-side only">
`MEMWAL_PRIVATE_KEY` must live in server env vars. Never ship it to the browser, a client component, or `NEXT_PUBLIC_*`. Any code path that reaches the client must not import the memory client.
</Step>
<Step title="Use the wallet for identity, not authorization">
The user's wallet signature proves *who they are*. It does not grant memory access — your delegate key does. Verify the signature server-side and derive the namespace from the verified address.
</Step>
<Step title="Never trust a client-supplied namespace">
Compute the namespace on the server from the authenticated address. If a client could send its own namespace, any user could read another user's bucket.
</Step>
<Step title="Keep the owner key offline">
The owner wallet (used for `createAccount` / `addDelegateKey` / `removeDelegateKey`) should never be deployed to the server. Run those operations from a local machine or a secure admin tool.
</Step>
</Steps>

## 5. For Demos & Submissions

Your `MemWalAccount` is a regular Sui object — share its object ID and view it on a Sui explorer (e.g. [Suiscan](https://suiscan.xyz) or [SuiVision](https://suivision.xyz)) to prove memory is really on-chain, not just in a local cache. Pair it with a live `health()` check (see the [API Reference](/sdk/api-reference)) so judges can confirm the relayer is reachable.

## See Also

- [Quick Start](/sdk/quick-start) — install and store your first memory
- [Delegate Key Management](/contract/delegate-key-management) — full key lifecycle
- [Ownership & Access](/fundamentals/concepts/ownership-and-access) — the trust model behind accounts and delegates
- [API Reference](/sdk/api-reference) — full method signatures
