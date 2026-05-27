import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Ban,
    CheckCircle2,
    Copy,
    KeyRound,
    LogIn,
    LogOut,
    Plus,
    RefreshCw,
    RotateCcw,
    Save,
    ShieldCheck,
    Unlock,
} from 'lucide-react'
import { config } from '../config'

interface AdminSession {
    token: string
    expiresAt: number
}

interface AppAuthClient {
    client_id: string
    display_name: string
    allowed_redirect_uris: string[]
    fallback_uri: string | null
    allowed_fallback_uris: string[]
    status: 'active' | 'blocked'
    created_at: string
    updated_at: string
}

interface ClientFormState {
    displayName: string
    redirectUris: string
    fallbackUris: string
}

interface SecretResult {
    clientId: string
    clientSecret: string
}

const STORAGE_KEY = 'memwal_app_auth_admin_session'

const emptyForm: ClientFormState = {
    displayName: '',
    redirectUris: '',
    fallbackUris: '',
}

function loadSession(): AdminSession | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const session = JSON.parse(raw) as AdminSession
        if (!session.token || Date.now() > session.expiresAt) {
            localStorage.removeItem(STORAGE_KEY)
            return null
        }
        return session
    } catch {
        localStorage.removeItem(STORAGE_KEY)
        return null
    }
}

function saveSession(token: string, expiresAt: string) {
    const parsed = Date.parse(expiresAt)
    const session: AdminSession = {
        token,
        expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + 2 * 60 * 60 * 1000,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    return session
}

function parseUriList(value: string): string[] {
    return value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

function formFromClient(client: AppAuthClient): ClientFormState {
    return {
        displayName: client.display_name,
        redirectUris: client.allowed_redirect_uris.join('\n'),
        fallbackUris: client.allowed_fallback_uris.join('\n'),
    }
}

function shortId(value: string) {
    return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value
}

export default function AppAuthClientManager() {
    const [session, setSession] = useState<AdminSession | null>(() => loadSession())
    const [adminToken, setAdminToken] = useState('')
    const [clients, setClients] = useState<AppAuthClient[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [copied, setCopied] = useState<string | null>(null)
    const [showCreate, setShowCreate] = useState(false)
    const [createForm, setCreateForm] = useState<ClientFormState>(emptyForm)
    const [editingClientId, setEditingClientId] = useState<string | null>(null)
    const [editForm, setEditForm] = useState<ClientFormState>(emptyForm)
    const [secretResult, setSecretResult] = useState<SecretResult | null>(null)

    const activeClients = useMemo(
        () => clients.filter((client) => client.status === 'active').length,
        [clients],
    )

    const logout = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY)
        setSession(null)
        setClients([])
        setSecretResult(null)
        setError('')
    }, [])

    const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
        if (!session?.token) throw new Error('admin login required')
        const res = await fetch(`${config.memwalServerUrl}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${session.token}`,
                ...(init.headers || {}),
            },
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
            if (res.status === 401) logout()
            throw new Error(typeof data?.error === 'string' ? data.error : `request failed (${res.status})`)
        }
        return data as T
    }, [logout, session?.token])

    const loadClients = useCallback(async () => {
        if (!session?.token) return
        setLoading(true)
        setError('')
        try {
            const data = await api<{ clients: AppAuthClient[] }>('/api/admin/app-auth/clients')
            setClients(data.clients)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to load app clients')
        } finally {
            setLoading(false)
        }
    }, [api, session?.token])

    useEffect(() => {
        void loadClients()
    }, [loadClients])

    const login = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
            const res = await fetch(`${config.memwalServerUrl}/api/admin/app-auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ admin_token: adminToken }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(typeof data?.error === 'string' ? data.error : 'admin login failed')
            }
            const next = saveSession(data.token, data.expires_at)
            setSession(next)
            setAdminToken('')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'admin login failed')
        } finally {
            setLoading(false)
        }
    }, [adminToken])

    const copy = useCallback(async (text: string, label: string) => {
        await navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(null), 1600)
    }, [])

    const createClient = useCallback(async () => {
        setLoading(true)
        setError('')
        setSecretResult(null)
        try {
            const data = await api<{
                client_id: string
                client_secret: string
            }>('/api/admin/app-auth/clients', {
                method: 'POST',
                body: JSON.stringify({
                    display_name: createForm.displayName,
                    redirect_uris: parseUriList(createForm.redirectUris),
                    fallback_uris: parseUriList(createForm.fallbackUris),
                }),
            })
            setSecretResult({ clientId: data.client_id, clientSecret: data.client_secret })
            setCreateForm(emptyForm)
            setShowCreate(false)
            await loadClients()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to create app client')
        } finally {
            setLoading(false)
        }
    }, [api, createForm, loadClients])

    const updateClient = useCallback(async (client: AppAuthClient) => {
        setLoading(true)
        setError('')
        try {
            await api(`/api/admin/app-auth/clients/${encodeURIComponent(client.client_id)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    display_name: editForm.displayName,
                    redirect_uris: parseUriList(editForm.redirectUris),
                    fallback_uris: parseUriList(editForm.fallbackUris),
                    status: client.status,
                }),
            })
            setEditingClientId(null)
            await loadClients()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to update app client')
        } finally {
            setLoading(false)
        }
    }, [api, editForm, loadClients])

    const setClientStatus = useCallback(async (client: AppAuthClient, status: 'active' | 'blocked') => {
        setLoading(true)
        setError('')
        try {
            const action = status === 'blocked' ? 'block' : 'unblock'
            await api(`/api/admin/app-auth/clients/${encodeURIComponent(client.client_id)}/${action}`, {
                method: 'POST',
            })
            await loadClients()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to update app client status')
        } finally {
            setLoading(false)
        }
    }, [api, loadClients])

    const rotateSecret = useCallback(async (client: AppAuthClient) => {
        if (!confirm(`rotate secret for ${client.display_name}? existing backend env values will stop working.`)) return
        setLoading(true)
        setError('')
        setSecretResult(null)
        try {
            const data = await api<{ client_id: string; client_secret: string }>(
                `/api/admin/app-auth/clients/${encodeURIComponent(client.client_id)}/rotate-secret`,
                { method: 'POST' },
            )
            setSecretResult({ clientId: data.client_id, clientSecret: data.client_secret })
            await loadClients()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to rotate client secret')
        } finally {
            setLoading(false)
        }
    }, [api, loadClients])

    const beginEdit = (client: AppAuthClient) => {
        setEditingClientId(client.client_id)
        setEditForm(formFromClient(client))
    }

    return (
        <div className="card app-auth-manager" style={{ marginBottom: 40 }}>
            <div className="card-header">
                <div>
                    <div className="card-title">hosted app clients</div>
                    <div className="card-subtitle">
                        admin-managed credentials for third-party apps connecting to Walrus Memory
                    </div>
                </div>
                {session && (
                    <div className="card-header-actions">
                        <button className="btn btn-secondary btn-sm" onClick={loadClients} disabled={loading}>
                            <RefreshCw size={12} /> refresh
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={logout}>
                            <LogOut size={12} /> logout
                        </button>
                    </div>
                )}
            </div>

            <div className="warning-box" style={{ marginBottom: 16 }}>
                <p>
                    production posture: app clients are created by an authenticated operator. end users only click connect from a dapp.
                </p>
            </div>

            {error && <div className="app-auth-error">{error}</div>}

            {!session ? (
                <div className="app-auth-login">
                    <div className="app-auth-login-icon"><ShieldCheck size={24} /></div>
                    <div className="app-auth-login-copy">
                        <div className="app-auth-login-title">sign in to manage clients</div>
                        <div className="app-auth-login-subtitle">
                            use the operator token to create a short-lived admin session
                        </div>
                    </div>
                    <div className="app-auth-login-controls">
                        <input
                            className="input"
                            type="password"
                            autoComplete="off"
                            placeholder="APP_AUTH_ADMIN_TOKEN"
                            value={adminToken}
                            onChange={(event) => setAdminToken(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && adminToken.trim()) void login()
                            }}
                        />
                        <button className="lp-nav-cta" onClick={login} disabled={loading || !adminToken.trim()}>
                            <LogIn size={14} /> sign in
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="app-auth-summary">
                        <div>
                            <span>{clients.length}</span>
                            <small>total apps</small>
                        </div>
                        <div>
                            <span>{activeClients}</span>
                            <small>active</small>
                        </div>
                        <button className="lp-nav-cta" onClick={() => setShowCreate((value) => !value)}>
                            <Plus size={14} /> new app
                        </button>
                    </div>

                    {secretResult && (
                        <div className="key-display key-display--white app-auth-secret">
                            <div className="key-label">client secret shown once</div>
                            <div className="key-value">
                                MEMWAL_CLIENT_ID={secretResult.clientId}
                                <br />
                                MEMWAL_CLIENT_SECRET={secretResult.clientSecret}
                            </div>
                            <div className="key-actions">
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copy(`MEMWAL_CLIENT_ID=${secretResult.clientId}\nMEMWAL_CLIENT_SECRET=${secretResult.clientSecret}`, 'client-secret')}
                                >
                                    <Copy size={12} /> {copied === 'client-secret' ? 'copied!' : 'copy env'}
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setSecretResult(null)}>
                                    done
                                </button>
                            </div>
                        </div>
                    )}

                    {showCreate && (
                        <ClientForm
                            title="create hosted app"
                            form={createForm}
                            setForm={setCreateForm}
                            loading={loading}
                            primaryLabel="create client"
                            onCancel={() => setShowCreate(false)}
                            onSubmit={createClient}
                        />
                    )}

                    {loading && clients.length === 0 ? (
                        <div className="empty-state">loading hosted app clients...</div>
                    ) : clients.length === 0 ? (
                        <div className="empty-state">no hosted app clients yet</div>
                    ) : (
                        <div className="app-auth-client-list">
                            {clients.map((client) => (
                                <div className="app-auth-client" key={client.client_id}>
                                    <div className="app-auth-client-main">
                                        <div>
                                            <div className="app-auth-client-title">
                                                {client.display_name}
                                                <span className={`app-auth-status app-auth-status--${client.status}`}>
                                                    {client.status === 'active' ? <CheckCircle2 size={12} /> : <Ban size={12} />}
                                                    {client.status}
                                                </span>
                                            </div>
                                            <div className="app-auth-client-id">
                                                {shortId(client.client_id)}
                                            </div>
                                        </div>
                                        <div className="app-auth-client-actions">
                                            <button className="btn btn-secondary btn-sm" onClick={() => copy(client.client_id, client.client_id)}>
                                                <Copy size={12} /> {copied === client.client_id ? 'copied!' : 'copy id'}
                                            </button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => rotateSecret(client)} disabled={loading}>
                                                <RotateCcw size={12} /> rotate
                                            </button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => beginEdit(client)}>
                                                <KeyRound size={12} /> edit
                                            </button>
                                            {client.status === 'active' ? (
                                                <button className="btn btn-danger btn-sm" onClick={() => setClientStatus(client, 'blocked')} disabled={loading}>
                                                    <Ban size={12} /> block
                                                </button>
                                            ) : (
                                                <button className="btn btn-secondary btn-sm" onClick={() => setClientStatus(client, 'active')} disabled={loading}>
                                                    <Unlock size={12} /> unblock
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="app-auth-uri-block">
                                        <div>
                                            <strong>redirect</strong>
                                            {client.allowed_redirect_uris.map((uri) => <code key={uri}>{uri}</code>)}
                                        </div>
                                        <div>
                                            <strong>fallback</strong>
                                            {client.allowed_fallback_uris.length > 0
                                                ? client.allowed_fallback_uris.map((uri) => <code key={uri}>{uri}</code>)
                                                : <code>none</code>}
                                        </div>
                                    </div>

                                    {editingClientId === client.client_id && (
                                        <ClientForm
                                            title="edit client"
                                            form={editForm}
                                            setForm={setEditForm}
                                            loading={loading}
                                            primaryLabel="save changes"
                                            onCancel={() => setEditingClientId(null)}
                                            onSubmit={() => updateClient(client)}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

function ClientForm({
    title,
    form,
    setForm,
    loading,
    primaryLabel,
    onCancel,
    onSubmit,
}: {
    title: string
    form: ClientFormState
    setForm: (next: ClientFormState) => void
    loading: boolean
    primaryLabel: string
    onCancel: () => void
    onSubmit: () => void
}) {
    return (
        <div className="app-auth-form">
            <div className="app-auth-form-title">{title}</div>
            <div className="input-group">
                <label>display name</label>
                <input
                    className="input"
                    value={form.displayName}
                    maxLength={80}
                    placeholder="Demo App"
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
            </div>
            <div className="input-group">
                <label>redirect URIs</label>
                <textarea
                    className="input app-auth-textarea"
                    value={form.redirectUris}
                    placeholder="https://your-dapp.example.com/api/memwal/callback"
                    onChange={(event) => setForm({ ...form, redirectUris: event.target.value })}
                />
            </div>
            <div className="input-group">
                <label>fallback URIs</label>
                <textarea
                    className="input app-auth-textarea"
                    value={form.fallbackUris}
                    placeholder="https://your-dapp.example.com/memwal/error"
                    onChange={(event) => setForm({ ...form, fallbackUris: event.target.value })}
                />
            </div>
            <div className="app-auth-form-actions">
                <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={loading}>
                    cancel
                </button>
                <button className="btn btn-primary btn-sm" onClick={onSubmit} disabled={loading}>
                    <Save size={12} /> {primaryLabel}
                </button>
            </div>
        </div>
    )
}
