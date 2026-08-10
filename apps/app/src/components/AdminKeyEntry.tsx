import { useState } from 'react'
import { Card } from './Card'

export interface AdminKeyEntryProps {
  onKeySubmit: (key: string) => Promise<void>
  isLoading?: boolean
  banner?: string
}

export function AdminKeyEntry({
  onKeySubmit,
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
    <div className="admin-key-entry-shell">
      <Card
        className="dashboard-keys-card admin-key-entry-card"
        title="Admin sign in"
        subtitle="Enter your admin API key to continue"
      >
        {banner && <div className="admin-key-banner">{banner}</div>}

        <form onSubmit={handleSubmit} className="admin-key-entry-form">
          <div className="dashboard-add-key-field">
            <label htmlFor="admin-key" className="dashboard-add-key-label">API key</label>
            <input
              id="admin-key"
              type="password"
              placeholder="Enter admin API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={isSubmitting || isLoading}
              className={`dashboard-add-key-input admin-key-input${error ? ' admin-key-input-error' : ''}`}
              autoComplete="off"
            />
            {error && <div className="admin-key-error">{error}</div>}
          </div>

          <div className="dashboard-add-key-actions">
            <button
              type="submit"
              disabled={isSubmitting || isLoading || !key.trim()}
              className="dashboard-add-key-create admin-key-submit-btn"
            >
              {isSubmitting ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  )
}
