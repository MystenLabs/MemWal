# Noter

AI assistant platform powered by Sui blockchain zkLogin authentication.

## Features

- **zkLogin Authentication**: Privacy-preserving blockchain authentication using OAuth
- **AI Chat**: Conversational AI powered by multiple models (Claude, GPT, etc.)
- **Sui Integration**: Blockchain-based identity without traditional wallets
- **Zero-Knowledge Proofs**: Authenticate without revealing credentials on-chain

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack, React 19)
- **Database**: PostgreSQL + Drizzle ORM
- **State**: Jotai (atomic state management)
- **API**: tRPC (type-safe API layer)
- **AI**: Vercel AI SDK v6
- **Blockchain**: Sui Network (zkLogin)
- **Styling**: Tailwind CSS 4, shadcn/ui
- **Validation**: Zod schemas

## Getting Started

### Prerequisites

- Node.js 18+ and pnpm
- PostgreSQL database (Neon, Supabase, or local)
- Google OAuth credentials
- Environment variables configured

### Installation

```bash
# Install dependencies
pnpm install

# Setup environment variables
cp .env.example .env
# Edit .env with your values

# Generate database tables
pnpm db:push

# Run development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

## Environment Variables

Create a `.env` file with:

```bash
# Database
DATABASE_URL=postgresql://...

# OAuth (Google)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Sui zkLogin
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_ZK_PROVER_URL=https://prover-dev.mystenlabs.com/v1
SALT_SERVICE_URL=https://salt.api.mystenlabs.com/get_salt

# AI
OPENROUTER_API_KEY=...

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Walrus Memory
MEMWAL_PRIVATE_KEY=...
MEMWAL_ACCOUNT_ID=0x...
MEMWAL_SERVER_URL=http://localhost:8000
```

`MEMWAL_PRIVATE_KEY` is the delegate private key from the Walrus Memory dashboard and
must stay server-side. Run `pnpm verify:memwal` before starting the app to
derive the public key locally and catch obvious credential mismatches.

### Getting OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable "Google+ API"
4. Go to Credentials → Create OAuth 2.0 Client ID
5. Add authorized redirect URI: `http://localhost:3000/auth/callback`
6. Copy Client ID and Client Secret to `.env`

## Project Structure

```
noter/
├── app/                    # Next.js app router
│   ├── ai/                 # AI chat routes (protected)
│   ├── auth/               # Auth callback handler
│   ├── api/                # API routes (tRPC)
│   └── page.tsx            # Home page
├── package/
│   ├── feature/            # Feature modules
│   │   ├── auth/           # zkLogin authentication
│   │   └── chat/           # AI chat
│   └── shared/             # Shared code
│       ├── components/ui/  # shadcn/ui components
│       ├── db/             # Database schema & types
│       ├── lib/            # Utilities & config
│       └── style/          # Global styles
├── doc/                    # Documentation
│   ├── architecture.md     # System architecture
│   ├── type-flow.md        # Type derivation patterns
│   └── zklogin-integration.md  # zkLogin guide
└── public/                 # Static files
```

## Key Features

### zkLogin Authentication

Users authenticate using Google OAuth and receive a unique Sui blockchain address:

```tsx
import { useAuth, LoginButton } from "@/feature/auth";

function App() {
  const { isAuthenticated, user, logout } = useAuth();

  if (!isAuthenticated) {
    return <LoginButton provider="google" />;
  }

  return (
    <div>
      <p>Sui Address: {user.suiAddress}</p>
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### Protected Routes

Use `AuthGuard` to protect routes:

```tsx
import { AuthGuard } from "@/feature/auth";

export default function ProtectedLayout({ children }) {
  return (
    <AuthGuard>
      {children}
    </AuthGuard>
  );
}
```

### AI Chat

AI-powered conversations with tool execution:

```tsx
import { ChatContainer } from "@/feature/chat";

function ChatPage() {
  return <ChatContainer chatId={chatId} />;
}
```

## Development

### Database Commands

```bash
# Generate migration
pnpm db:generate

# Push schema to database (dev)
pnpm db:push

# Run migrations (production)
pnpm db:migrate

# Open Drizzle Studio
pnpm db:studio
```

### Code Quality

```bash
# Lint
pnpm lint

# Type check
pnpm type-check
```

## Architecture Patterns

### Type Flow

```
schema.ts → type.ts → input.ts → form.ts → component.tsx
```

1. Define tables in `shared/db/schema.ts`
2. Types auto-derived in `shared/db/type.ts`
3. API inputs in `feature/*/api/input.ts` (derived via `.pick().extend()`)
4. Form schemas in `feature/*/api/form.ts`
5. Components use types from `shared/db/type.ts`

### Feature Structure

```
package/feature/[name]/
├── index.ts          # Public API
├── constant.ts       # Static values
├── domain/
│   ├── type.ts       # Feature types
│   └── [name].ts     # Pure domain logic
├── api/
│   ├── input.ts      # API inputs (Zod)
│   └── route.ts      # tRPC routes
├── state/
│   └── atom.ts       # Jotai atoms
├── hook/
│   └── use-*.ts      # React hooks
├── ui/
│   └── *.tsx         # React components
└── lib/
    └── *.ts          # Utilities
```

### Rules

1. **Schema is source of truth** – All tables in `shared/db/schema.ts`
2. **Derive, never redefine** – Use `insertSchema.pick().extend()`
3. **Cross-feature imports via index.ts only** – Never import internal files
4. **Domain functions are pure** – No DB, no async
5. **Types flow down** – schema → type → input → form → UI

## Documentation

- [Architecture](./doc/architecture.md) – System structure and patterns
- [Type Flow](./doc/type-flow.md) – How types are derived
- [zkLogin Integration](./doc/zklogin-integration.md) – Authentication guide

## Deployment

### Build

```bash
pnpm build
```

### Environment

Ensure all environment variables are set in production:

- Database URL
- OAuth credentials
- Sui network configuration
- AI API keys

### Database Migrations

Run migrations before deploying:

```bash
pnpm db:migrate
```

## License

MIT

## Learn More

- [Sui zkLogin Documentation](https://docs.sui.io/guides/developer/cryptography/zklogin-integration)
- [Next.js Documentation](https://nextjs.org/docs)
- [tRPC Documentation](https://trpc.io)
- [Drizzle ORM Documentation](https://orm.drizzle.team)
