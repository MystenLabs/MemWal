export type SessionMemoryCredentials = {
  key: string;
  accountId: string;
};

/** Resolve only credentials loaded for this authenticated user; never use globals. */
export function sessionMemoryCredentials(user: {
  privateKey: string;
  accountId: string;
}): SessionMemoryCredentials | null {
  if (!user.privateKey || !user.accountId) return null;
  return { key: user.privateKey, accountId: user.accountId };
}
