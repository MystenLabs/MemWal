export interface RegistryObjectFields {
    accounts?: {
        fields?: {
            id?: { id?: string }
        }
    }
}

export interface DynamicFieldObjectFields {
    value?: string
}

export interface DelegateKeyFields {
    public_key?: number[]
    sui_address?: string
    label?: string
    created_at?: number | string
}

export interface DelegateKeyRecord extends DelegateKeyFields {
    fields?: DelegateKeyFields
}

export interface AccountObjectFields {
    delegate_keys?: DelegateKeyRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export function getMoveFields<T extends object>(content: unknown): T | null {
    if (!isRecord(content) || !('fields' in content)) return null
    return isRecord(content.fields) ? content.fields as T : null
}

export function getDelegateKeyFields(record: DelegateKeyRecord): DelegateKeyFields {
    return record.fields ?? record
}
