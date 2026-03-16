# Sui zkLogin Integration

Noter uses Sui's zkLogin for privacy-preserving blockchain authentication. Users sign in with existing OAuth providers (Google, Facebook, etc.) and receive a unique Sui address derived from their credentials.

## Architecture Overview

### Components

1. **Authentication Feature** (`package/feature/auth/`)
   - Domain logic for zkLogin flow
   - tRPC API routes for OAuth and proof generation
   - React hooks and UI components
   - Jotai atoms for state management

2. **Database Schema**
   - `users` table: Stores user profiles with Sui addresses
   - `zklogin_sessions` table: Manages ephemeral keypairs and ZK proofs

3. **External Services**
   - Google OAuth: User authentication
   - Mysten Labs Prover: Zero-knowledge proof generation
   - Mysten Labs Salt Service: User salt derivation
   - Sui Network: Epoch information and address derivation

## Authentication Flow

### High-Level Flow

```
User → Google OAuth → JWT → ZK Proof → Sui Address → Authenticated
```

### Detailed Steps

1. **Initiate Login**
   - User clicks "Continue with Google"
   - System generates ephemeral keypair (valid for ~24h)
   - Fetches current epoch from Sui network
   - Generates nonce from public key + epoch + randomness
   - Redirects to Google OAuth with nonce

2. **OAuth Callback**
   - Google redirects back with JWT (id_token)
   - System validates JWT and nonce
   - Fetches user salt from Mysten Labs service
   - Generates ZK proof (takes ~3s)
   - Derives Sui address from JWT + salt

3. **User Creation/Update**
   - Looks up user by Sui address
   - Creates new user or updates existing profile
   - Stores session with cached ZK proof
   - Sets auth state in frontend

4. **Session Persistence**
   - Session stored in sessionStorage (ephemeral key security)
   - Auto-validates on page load
   - Expires after ~23 hours (Sui epoch boundary)

## Usage

### Protect Routes

```tsx
import { AuthGuard } from "@/feature/auth";

export default function ProtectedPage() {
  return (
    <AuthGuard>
      <YourContent />
    </AuthGuard>
  );
}
```

### Use Auth State

```tsx
import { useAuth } from "@/feature/auth";

function MyComponent() {
  const { isAuthenticated, user, login, logout } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={() => login("google")}>Sign In</button>;
  }

  return (
    <div>
      <p>Welcome, {user.name}!</p>
      <p>Sui Address: {user.suiAddress}</p>
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### Display User Menu

```tsx
import { UserMenu } from "@/feature/auth";

function Header() {
  const { user } = useAuth();

  return (
    <header>
      {user && <UserMenu user={user} />}
    </header>
  );
}
```

## Environment Variables

Required environment variables (already in `.env`):

```bash
# OAuth Configuration
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Sui zkLogin
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_ZK_PROVER_URL=https://prover-dev.mystenlabs.com/v1
SALT_SERVICE_URL=https://salt.api.mystenlabs.com/get_salt

# App URL (for OAuth callback)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Database Migration

Run the migration to create the `zklogin_sessions` table:

```bash
pnpm db:push
```

Or for production:

```bash
pnpm db:migrate
```

## Security Considerations

### Ephemeral Key Storage

- **sessionStorage** (not localStorage): Keys cleared on browser close
- Never log private keys
- Production: Consider encrypting keys at rest

### Session Management

- Sessions expire at Sui epoch boundary (~24h)
- ZK proof cached per session (reusable for multiple transactions)
- Auto-logout on expiration

### OAuth Security

- Nonce validation prevents replay attacks
- JWT signature verification via OAuth provider
- State parameter prevents CSRF

## Extending to Other Providers

To add Facebook, Twitch, or other providers:

1. Update `package/feature/auth/constant.ts`:

```typescript
export const OAUTH_PROVIDERS = {
  google: { ... },
  facebook: {
    name: "Facebook",
    clientId: process.env.FACEBOOK_CLIENT_ID!,
    authUrl: "https://www.facebook.com/v18.0/dialog/oauth",
  },
  // ...
} as const;

export const OAUTH_SCOPES = {
  google: ["openid", "email", "profile"],
  facebook: ["openid", "email", "public_profile"],
  // ...
} as const;
```

2. Add environment variables:

```bash
FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
```

3. Update `InitiateLoginInput` schema in `api/input.ts`

4. Use in UI:

```tsx
<LoginButton provider="facebook" />
```

## Future Enhancements

### Transaction Signing

The ZK proof can be used to sign Sui transactions:

```typescript
import { assembleZkLoginSignature } from "@/feature/auth/lib/zklogin-client";

// Sign transaction
const signature = assembleZkLoginSignature({
  userSignature: signedData,
  zkProof: session.zkProof,
  ephemeralPublicKey: session.ephemeralKeyPair.publicKey,
  maxEpoch: session.maxEpoch,
});

// Submit to Sui network
await suiClient.executeTransactionBlock({ signature, ... });
```

### Custom Salt Management

Replace Mysten Labs salt service with HKDF-based derivation:

```typescript
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

function deriveUserSalt(masterSeed: string, jwt: JwtClaims): string {
  const ikm = Buffer.from(masterSeed, "utf-8");
  const salt = Buffer.from(`${jwt.iss}||${jwt.aud}`, "utf-8");
  const info = Buffer.from(jwt.sub, "utf-8");

  const derivedSalt = hkdf(sha256, ikm, salt, info, 32);
  return derivedSalt.toString("hex");
}
```

### Self-Hosted Prover

For high-volume applications, deploy your own ZK prover:

```bash
docker pull mysten/zklogin:prover-stable
docker run -p 8080:8080 \
  -e MIN_CPU_CORES=16 \
  -e MIN_MEMORY_GB=16 \
  mysten/zklogin:prover-stable
```

Update `NEXT_PUBLIC_ZK_PROVER_URL` to your prover instance.

## Troubleshooting

### "No ID token received"

- Check OAuth redirect URI matches exactly
- Ensure `response_type=id_token` in OAuth URL
- Verify Google OAuth consent screen is configured

### "Failed to generate ZK proof"

- Check prover service is accessible
- Ensure JWT is valid and not expired
- Verify network connectivity to Mysten Labs

### "Session expired"

- Sessions expire at Sui epoch boundary (~24h)
- User must re-authenticate
- Consider implementing auto-refresh before expiration

### "Invalid nonce"

- Nonce mismatch between initiate and callback
- Check sessionStorage is persisting correctly
- Verify OAuth provider is not modifying nonce

## References

- [Sui zkLogin Documentation](https://docs.sui.io/guides/developer/cryptography/zklogin-integration)
- [Mysten Labs zkLogin GitHub](https://github.com/MystenLabs/sui/tree/main/sdk/zklogin)
- [zkLogin Research Paper](https://arxiv.org/abs/2401.11735)
