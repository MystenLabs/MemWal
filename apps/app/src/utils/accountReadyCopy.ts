/**
 * Copy for the dashboard's Back to Console dialog (WALM-675, WALM-743).
 *
 * The dialog opens for three Console arrivals, and each needs its own words:
 * a user who minted or revoked a key from /keys is already linked, so the
 * new-account "Finish connecting" copy reads wrong for them. Mint and revoke
 * copy lines up with Console's return banner ("N agents added/removed",
 * COMG-1093).
 */
export type LastKeyAction =
    | { kind: 'mint'; label: string }
    | { kind: 'revoke'; count: number }

export interface AccountReadyCopy {
    title: string
    description: string
}

export function accountReadyCopy(action: LastKeyAction | null): AccountReadyCopy {
    if (action?.kind === 'mint') {
        return {
            title: `"${action.label}" is ready`,
            description: 'Head back to Walrus Console. It will show up under Connected agents.',
        }
    }
    if (action?.kind === 'revoke') {
        return {
            title: action.count === 1 ? 'Key removed' : `${action.count} keys removed`,
            description: 'Head back to Walrus Console to see the change.',
        }
    }
    return {
        title: 'Your account is ready',
        description: 'Finish connecting your account in Walrus Console.',
    }
}
