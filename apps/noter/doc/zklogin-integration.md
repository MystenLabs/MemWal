# Noter authentication

Noter is an example app. It authenticates users through one of three paths, all served by the
auth tRPC router (`package/feature/auth/api/route.ts`) and consumed by the `useAuth` hook:

1. **Enoki zkLogin** (`connectEnoki`) — the primary sign-in. The Enoki flow runs client-side
   (`app/components/enoki-login-card.tsx` / `sui-providers.tsx`); on completion the app registers or
   looks up the user by Sui address and creates a session. This is the login the UI drives.
2. **Sui wallet** (`connectWallet`) — sign-in with a Sui wallet (e.g. Slush). The server verifies the
   personal-message signature before creating a session.
3. **Delegate key** (`connectDelegateKey`) — manual login with a delegate private key + account id.

Sessions are stored in the `wallet_sessions` table (Enoki reuses it with `walletType = "enoki"`).
Authentication resolves sessions from `wallet_sessions` only; the legacy `zklogin_sessions` table is
no longer trusted for session lookup (logout still deletes any leftover row, and a one-time cleanup
script is provided). See the removal note below.

> **Removed:** an earlier custom OAuth→JWT→prover→salt zkLogin flow (`initiateLogin` / `completeLogin`)
> was never wired into the UI (no `/auth/callback` page, no callers) and has been removed. It did not
> verify JWT signatures and derived the zkLogin salt locally without a secret, so it is not a pattern to
> reintroduce. Enoki is the supported zkLogin path.

## Usage

### Protect routes

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

### Read auth state

```tsx
import { useAuth } from "@/feature/auth";

function MyComponent() {
  const { isAuthenticated, user, connectEnoki, logout } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={() => connectEnoki(/* ... */)}>Sign In</button>;
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

## Environment variables

```bash
# Sui network (used for explorer links, address derivation)
NEXT_PUBLIC_SUI_NETWORK=testnet

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## References

- [Sui zkLogin Documentation](https://docs.sui.io/guides/developer/cryptography/zklogin-integration)
- [Enoki](https://docs.enoki.mystenlabs.com/)
