import { useState, useEffect } from 'react'
import { AdminKeyEntry } from '../components/AdminKeyEntry'
import { AdminWalletBalances } from '../components/AdminWalletBalances'
import { AdminUploadErrors } from '../components/AdminUploadErrors'
import { AdminConfig } from '../components/AdminConfig'

const ADMIN_KEY_STORAGE = 'admin_api_key'

export default function AdminDashboard() {
  const [adminKey, setAdminKey] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(ADMIN_KEY_STORAGE)
    if (stored) {
      setAdminKey(stored)
    }
  }, [])

  const handleKeySubmit = async (key: string) => {
    setIsSubmitting(true)
    try {
      const trimmedKey = key.trim()
      localStorage.setItem(ADMIN_KEY_STORAGE, trimmedKey)
      setAdminKey(trimmedKey)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem(ADMIN_KEY_STORAGE)
    setAdminKey(null)
  }

  return (
    <div className="admin-dashboard-page">
      <div className="admin-dashboard-container">
        <div className="admin-page-header">
          <h1>Admin Dashboard</h1>
          <p className="admin-page-subtitle">Monitor wallet balances, upload errors, and system configuration</p>
        </div>

        {!adminKey ? (
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
