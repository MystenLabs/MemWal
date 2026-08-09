import { useState } from 'react'
import { LogOut } from 'lucide-react'

export interface AdminKeyEntryProps {
  onKeySubmit: (key: string) => Promise<void>
  onLogout: () => void
  isLoading?: boolean
  banner?: string
}

export function AdminKeyEntry({
  onKeySubmit,
  onLogout,
  isLoading = false,
  banner,
}: AdminKeyEntryProps) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsSubmitting(true)

    try {
      if (!key.trim()) {
        setError('Please enter an admin API key')
        setIsSubmitting(false)
        return
      }

      await onKeySubmit(key)
      setKey('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to authenticate'
      if (message === 'INVALID_KEY') {
        setError('Invalid admin API key')
      } else {
        setError('An error occurred. Please try again.')
      }
      setIsSubmitting(false)
    }
  }

  return (
    <div className="admin-key-entry-modal">
      <div className="admin-key-entry-card">
        <div className="admin-key-entry-header">
          <h2>Admin Dashboard</h2>
          <p className="admin-key-entry-subtitle">Enter your admin API key to continue</p>
        </div>

        {banner && <div className="admin-key-banner">{banner}</div>}

        <form onSubmit={handleSubmit} className="admin-key-entry-form">
          <div className="admin-key-entry-field">
            <label htmlFor="admin-key">API Key</label>
            <input
              id="admin-key"
              type="password"
              placeholder="Enter admin API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={isSubmitting || isLoading}
              className={error ? 'admin-key-input admin-key-input-error' : 'admin-key-input'}
              autoComplete="off"
            />
            {error && <div className="admin-key-error">{error}</div>}
          </div>

          <button
            type="submit"
            disabled={isSubmitting || isLoading || !key.trim()}
            className="admin-key-submit-btn"
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <button
          onClick={onLogout}
          className="admin-key-logout-btn"
          title="Log out of admin dashboard"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </div>
  )
}
