# Type Flow

How types flow from database to API to UI. Single source of truth is `package/shared/db/schema.ts`.

## Derivation Chain

Each layer derives from the one above. Never redefine — always derive.

1. **`package/shared/db/schema.ts`** — Drizzle table definitions, enums, JSONB types (Drizzle)
2. **`package/shared/db/type.ts`** — DB types (`User`, `Chat`), enums (`MESSAGE_ROLES`), insert schemas (`chatInsertSchema`), common primitives (`idInputSchema`) (TS + Zod)
3. **`package/feature/[name]/api/input.ts`** — API route inputs. Derived via `insertSchema.pick().extend()` (Zod)
4. **`package/feature/[name]/api/form.ts`** — UI form schemas. Same derivation, adds `optionalId` for create/update (Zod)
5. **`package/feature/[name]/domain/type.ts`** — Component props, UI state, display types. No Zod, pure TS
6. **`package/feature/[name]/domain/[name].ts`** — Pure business rules. No DB, no async (Pure TS)

Consumers:
- `package/feature/[name]/api/route.ts` validates with `input.ts`
- `package/feature/[name]/ui/*.tsx` uses `form.ts` + `domain/type.ts`
- tRPC hooks called directly: `api.chat.list.useQuery()`

## Derivation Pattern

Every input/form schema derives from the insert schema. Never write standalone Zod schemas for fields that exist in the DB.

```ts
// package/feature/chat/api/input.ts — API input (strict, backend)
import { chatInsertSchema } from "@/shared/db/type";

export const createChatInput = chatInsertSchema
  .pick({ title: true, model: true, systemPrompt: true })
  .extend({
    title: z.string().min(1).max(100).optional(),
    model: z.string().min(1),
  });

// package/feature/chat/api/form.ts — form schema (looser, has optionalId)
import { chatInsertSchema, optionalIdSchema } from "@/shared/db/type";

export const chatFormSchema = chatInsertSchema
  .pick({ title: true, model: true, systemPrompt: true })
  .merge(optionalIdSchema);
```

Why: DB field renamed or type changed → TypeScript error at derivation site → you know exactly what to update.

## Type Usage in Domain and UI

Domain functions use `Pick<>` from shared DB types. UI types are pure TS, no Zod.

```ts
// package/feature/chat/domain/chat.ts — pure rule
import type { Chat, Message } from "@/shared/db/type";

export const canDeleteMessage = (
  message: Pick<Message, "role" | "createdAt">,
  chat: Pick<Chat, "userId">
) => {
  // Pure validation logic
  return message.role === "user";
};

// package/feature/chat/domain/type.ts — UI types
import type { Chat } from "@/shared/db/type";

export type ChatCardProps = {
  chat: Pick<Chat, "id" | "title" | "createdAt">;
  isActive?: boolean;
};
```

## Cross-Feature Imports

Features import ONLY from other features' `index.ts`. Never internal files.

```ts
// ✅ ALLOWED - import from feature barrel
import { ChatContainer, useChat } from "@/feature/chat";

// ❌ FORBIDDEN - never import internal files
import { chatAtom } from "@/feature/chat/state/atom";
import { chatRouter } from "@/feature/chat/api/route";
```

## Rules

1. **Never redefine DB types** — use `Pick<SharedType, ...>` from `@/shared/db/type`
2. **Derive input/form schemas** — `insertSchema.pick().extend()`, never standalone Zod for DB fields
3. **Custom validation in features** — regex, min/max, defaults added via `.extend()`
4. **Enums stay in shared** — they're cross-cutting (`MESSAGE_ROLES`, `AI_MESSAGE_STATUSES`)
5. **Domain functions are pure** — no DB, no async, use `Pick<>` for params
6. **Cross-feature imports only via `index.ts`** — never internal files

## Adding a New Feature

1. **Schema** — Tables already in `package/shared/db/schema.ts`
2. **Types** — Auto-generated in `package/shared/db/type.ts` via `tableDef()`
3. **API Input** — `package/feature/newfeature/api/input.ts` — derive from `newfeatureInsertSchema.pick().extend()`
4. **Form Schema** — `package/feature/newfeature/api/form.ts` — add `optionalIdSchema` for create/update
5. **Domain Logic** — `package/feature/newfeature/domain/newfeature.ts` — pure rules using `Pick<Newfeature, ...>`
6. **Public API** — `package/feature/newfeature/index.ts` — export only what other features need

## Example: Full Type Flow for Chat

```ts
// 1. Schema (package/shared/db/schema.ts)
export const chats = pgTable("chats", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  userId: uuid().references(() => users.id),
  title: text(),
  model: text().default("anthropic/claude-sonnet-4"),
  systemPrompt: text(),
  temperature: real(),
  createdAt: timestamp().defaultNow().notNull(),
});

// 2. Type derivation (package/shared/db/type.ts)
const chatsDef = tableDef(chats);
export type Chat = Select<typeof chats>;
export type ChatInsert = Insert<typeof chats>;
export const chatSchema = chatsDef.selectSchema;
export const chatInsertSchema = chatsDef.insertSchema;

// 3. API input (package/feature/chat/api/input.ts)
export const createChatInput = chatInsertSchema
  .pick({ title: true, model: true })
  .extend({
    title: z.string().min(1).max(100).optional(),
    model: z.string().min(1),
  });

// 4. Form schema (package/feature/chat/api/form.ts)
export const chatFormSchema = chatInsertSchema
  .pick({ title: true, model: true, systemPrompt: true })
  .merge(optionalIdSchema);

// 5. Domain type (package/feature/chat/domain/type.ts)
export type ChatListItemProps = {
  chat: Pick<Chat, "id" | "title" | "createdAt">;
  onSelect: (id: string) => void;
};

// 6. Domain logic (package/feature/chat/domain/chat.ts)
export const generateTitle = (
  message: Pick<Message, "content">
): string => {
  return message.content.slice(0, 50) + "...";
};

// 7. Public API (package/feature/chat/index.ts)
export { ChatContainer } from "./ui/chat";
export { useChat } from "./hook/use-chat";
export type { ChatListItemProps } from "./domain/type";
```

## Common Primitives

Shared validation patterns live in `package/shared/db/type.ts`:

```ts
// UUIDv7 validation
export const uuidv7Schema = z.string().uuid();

// ID input (for queries)
export const idInputSchema = z.object({
  id: uuidv7Schema,
});

// Optional ID (for forms)
export const optionalIdSchema = z.object({
  id: uuidv7Schema.optional(),
});
```

Use these in feature schemas:

```ts
import { idInputSchema, chatInsertSchema } from "@/shared/db/type";

// Delete chat input
export const deleteChatInput = idInputSchema;

// Update chat input
export const updateChatInput = chatInsertSchema
  .pick({ title: true, model: true })
  .merge(idInputSchema);
```
