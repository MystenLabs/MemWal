# Architecture

Single-app structure. Canonical reference for AI navigation.

Noter = Sui AI assistant platform. Chat-based AI interaction with Sui blockchain integration, zkLogin authentication, and tool execution.

## App Structure

```
noter/
  app/                   # Next.js app router (single app at root)
    ai/                  # AI chat routes
    api/                 # API routes (tRPC, chat)
    layout.tsx
    page.tsx
```

- Single Next.js app (no `apps/` folder needed)
- App router for routing and layouts
- API routes for tRPC and AI chat endpoints

## Shared Package

```
package/shared/
  components/
    ui/                  # shadcn primitives (57 components)
  db/
    schema.ts            # Drizzle tables (single source of truth)
    type.ts              # DB types, enums derived from schema
    relations.ts         # Drizzle relation definitions
  hook/                  # browser/DOM utilities
    use-mobile.ts
  lib/                   # utility libraries
    ai/                  # AI SDK configuration (providers, tools)
    db/                  # Drizzle client instance
    trpc/                # tRPC client/server setup
    utils.ts             # cn() and other utilities
  style/
    globals.css          # global styles, CSS variables
```

Notes:
- `shared/db/schema.ts` is the centralized Drizzle schema. No per-feature schema files.
- `shared/db/type.ts` derives all DB types and enums from schema.ts.

## Feature Package

```
package/feature/
  [name]/                # one per domain: chat, etc.
    index.ts             # PUBLIC API - client-safe exports (types, hooks, UI)
    ui/                  # React components
    state/
      atom.ts            # Jotai atoms + state types inline
    hook/                # React hooks
    api/
      route.ts           # tRPC routes (thin handlers)
    domain/
      type.ts            # feature-specific types
```

Not every feature has every file. Files are created as needed.

### File-to-Folder Escalation

When a file grows complex, promote it to a folder with the same name:
- `atom.ts` → `atom/chat.ts`, `atom/ui.ts`
- `route.ts` → `route/chat.ts`, `route/message.ts`

The folder name preserves the original semantic.

### Cross-Feature Import Rule

Features import ONLY from other features' `index.ts`, never internal files.

```ts
// ✅ ALLOWED - import from feature barrel
import { ChatContainer, useChat } from "@/feature/chat";

// ❌ FORBIDDEN - never import internal files
import { useChatAtom } from "@/feature/chat/state/atom";
import { chatRouter } from "@/feature/chat/api/route";
```

### index.ts as Single Public API

Each feature has ONE public entry point: `index.ts` (client-safe).

```ts
// index.ts - client-safe public API (types, hooks, UI)
export { ChatContainer, ChatSidebar } from './ui/chat';
export { useChat } from './hook/use-chat';
export type { ChatMessage } from './domain/type';
```

**Rules:**
1. External features (client) → `import from '@/feature/X'`
2. Internal files → `import type { Chat } from '@/shared/db/type'` or `from '../domain/type'`
3. Never `import from '../index'` inside a feature (causes cycles)

**Why this works:**
- DB types live in `@/shared/db/type` (leaf node, no feature deps)
- Feature-internal types live in `domain/type.ts`
- `index.ts` only re-exports from internal files, never imports from them

## Features

Current features in Noter:

| Feature | Tables | Purpose |
|---------|--------|---------|
| chat | chats, messages | AI chat conversations with tool execution |

### Chat Feature

- AI-powered conversations using Vercel AI SDK v6
- Multi-model support (Claude, GPT, etc.)
- Tool execution framework
- Message history and persistence
- Streaming responses

## Schema Patterns

Detailed in `shared/db/schema.ts`. Summary:

- UUIDv7 IDs: time-sorted, used as primary keys everywhere
- Basic fields pattern: `id`, `createdAt` shared across tables
- zkLogin authentication: Sui address-based identity
- AI message parts: JSON storage for structured AI responses
- Enums: `messageRole`, `aiMessageStatus` for type safety

## Path Aliases

```json
{
  "@/*": ["./*"],
  "@/shared/*": ["./package/shared/*"],
  "@/feature/*": ["./package/feature/*"]
}
```

Use these aliases consistently:
- `@/shared/db/type` for DB types
- `@/shared/components/ui/*` for UI components
- `@/shared/lib/*` for utilities
- `@/feature/chat` for feature imports

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **State**: Jotai (atomic state management)
- **Styling**: Tailwind CSS 4, shadcn/ui
- **Database**: PostgreSQL + Drizzle ORM
- **API**: tRPC (type-safe API layer)
- **AI**: Vercel AI SDK v6
- **Auth**: zkLogin (Sui blockchain-based authentication)
- **Validation**: Zod schemas

## Differences from Zander

Noter is a simplified, single-app version of Zander's architecture:

1. **No `apps/` folder** – `/app` at root (not `apps/main/app`)
2. **Leaner initially** – only essential folders created
3. **Same feature pattern** – identical `feature/[name]/` structure
4. **No `service/` yet** – can add later for realtime/workers
5. **Focused scope** – AI chat focused vs. all-in-one workspace

## Future Expansion

When needed, add:
- `package/shared/components/ace/` – custom complex components
- `package/shared/components/base/` – base building blocks
- `package/shared/util/` – pure utility functions
- `package/shared/config/` – environment, constants
- `service/realtime/` – WebSocket/PartyKit servers
- `service/worker/` – background jobs
- Additional features in `package/feature/`
