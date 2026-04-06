/**
 * AUTH FEATURE - PUBLIC API
 * Client-safe exports for authentication feature
 */

// Constants
export {
  OAUTH_PROVIDERS,
  AUTH_ERRORS,
  WALLET_TYPES,
  WALLET_NAMES,
  WALLET_INSTALL_URLS,
  type OAuthProvider,
  type WalletType,
} from "./constant";

// Form Schemas
export {
  userProfileFormSchema,
  type UserProfileFormData,
} from "./api/form";

// API Input Schemas (if needed by external features)
export type {
  InitiateLoginInput,
  CompleteLoginInput,
  ValidateSessionInput,
  ConnectWalletInput,
} from "./api/input";

// Types
export type {
  AuthState,
  LoginResult,
  LoginButtonProps,
  UserMenuProps,
  AuthGuardProps,
  SessionData,
  ZkLoginSessionData,
  WalletSessionData,
  EphemeralKeyPair,
  JwtClaims,
} from "./domain/type";

// Domain utilities (client-safe)
export { truncateSuiAddress } from "./domain/zklogin";

// Hooks
export { useAuth } from "./hook/use-auth";

// UI Components
export { LoginButton } from "./ui/login-button";
export { AuthButtonGroup } from "./ui/auth-button-group";
export { AuthGuard } from "./ui/auth-guard";

// State atoms (for advanced usage)
export {
  authAtom,
  sessionAtom,
  isAuthenticatedAtom,
  currentUserAtom,
  suiAddressAtom,
} from "./state/atom";
