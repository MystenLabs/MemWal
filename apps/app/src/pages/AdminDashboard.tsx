import { useState, useEffect } from 'react'
import { AdminKeyEntry } from '../components/AdminKeyEntry'
import { AdminWalletBalances } from '../components/AdminWalletBalances'
import { AdminUploadErrors } from '../components/AdminUploadErrors'
import { AdminConfig } from '../components/AdminConfig'
import { fetchAdminConfig } from '../utils/admin-api'

const ADMIN_KEY_STORAGE = 'admin_api_key'

export default function AdminDashboard() {
  const [adminKey, setAdminKey] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)

  useEffect(() => {
    const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE)
    if (!stored) {
      setIsRestoring(false)
      return
    }
    // A key restored from a previous session may since have been rotated
    // or was never valid to begin with (e.g. left over from before this
    // validation existed) — re-check it before trusting it, otherwise a
    // stale key sits in sessionStorage across reloads (it only clears on
    // tab close) and every panel fails with 401 on every future reload.
    fetchAdminConfig(stored)
      .then(() => setAdminKey(stored))
      .catch(() => sessionStorage.removeItem(ADMIN_KEY_STORAGE))
      .finally(() => setIsRestoring(false))
  }, [])

  const handleKeySubmit = async (key: string) => {
    setIsSubmitting(true)
    try {
      const trimmedKey = key.trim()
      await fetchAdminConfig(trimmedKey)
      sessionStorage.setItem(ADMIN_KEY_STORAGE, trimmedKey)
      setAdminKey(trimmedKey)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE)
    setAdminKey(null)
  }

  return (
    <div className="admin-dashboard-page">
      <div className="admin-dashboard-container">
        <div className="admin-page-header">
          <h1>Admin Dashboard</h1>
          <p className="admin-page-subtitle">Monitor wallet balances, upload errors, and system configuration</p>
        </div>

        {isRestoring ? (
          <div className="admin-loading">Checking saved session...</div>
        ) : !adminKey ? (
          <AdminKeyEntry
            onKeySubmit={handleKeySubmit}
            onLogout={handleLogout}
            isLoading={isSubmitting}
          />
        ) : (
          <div className="admin-panels">
            <AdminWalletBalances adminKey={adminKey} />
            <AdminUploadErrors adminKey={adminKey} />
            <AdminConfig adminKey={adminKey} />
            <div className="admin-logout-section">
              <button
                onClick={handleLogout}
                className="admin-logout-button"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
