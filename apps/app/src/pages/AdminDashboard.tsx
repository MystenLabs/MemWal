import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { AdminAnalyticsApp } from '../admin-analytics/AdminAnalyticsApp'
import { AdminKeyEntry } from '../components/AdminKeyEntry'
import { fetchAdminConfig } from '../utils/admin-api'

const ADMIN_KEY_STORAGE = 'admin_api_key'

export default function AdminDashboard() {
  const queryClient = useQueryClient()
  const [adminKey, setAdminKey] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)
  const [banner, setBanner] = useState<string | undefined>(undefined)
  const [navSolid, setNavSolid] = useState(false)

  useEffect(() => {
    const onScroll = () => setNavSolid(window.scrollY > 220)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE)
    if (!stored) {
      setIsRestoring(false)
      return
    }
    // A key restored from a previous session may since have been rotated
    // or was never valid to begin with — re-check it before trusting it.
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
      queryClient.removeQueries({ queryKey: ['admin'] })
      setBanner(undefined)
      setAdminKey(trimmedKey)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE)
    queryClient.removeQueries({ queryKey: ['admin'] })
    setBanner(undefined)
    setAdminKey(null)
  }

  const handleInvalidKey = () => {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE)
    queryClient.removeQueries({ queryKey: ['admin'] })
    setAdminKey(null)
    setBanner('Your admin API key is no longer valid. Please sign in again.')
  }

  if (!adminKey) {
    return (
      <div className="admin-dashboard-page dash-page">
        <nav className={`nav playground-nav dashboard-nav${navSolid ? ' dashboard-nav--solid' : ''}`}>
          <div className="nav-inner">
            <Link to="/" className="nav-brand">
              <img className="nav-brand-logo" src="/walrus-memory-logo.svg?v=3" alt="Walrus Memory" />
            </Link>
          </div>
        </nav>
        <main className="admin-dashboard-container dash-shell">
          <div className="dashboard-header">
            <h2>Admin Dashboard</h2>
            <p>Monitor spend, wallet balances, upload errors, and system configuration</p>
          </div>
          {isRestoring ? (
            <div className="admin-loading">Checking saved session...</div>
          ) : (
            <AdminKeyEntry
              onKeySubmit={handleKeySubmit}
              isLoading={isSubmitting}
              banner={banner}
            />
          )}
        </main>
      </div>
    )
  }

  return (
    <AdminAnalyticsApp
      adminKey={adminKey}
      demo={false}
      banner={banner}
      isSubmitting={isSubmitting}
      onSignIn={handleKeySubmit}
      onLogout={handleLogout}
      onInvalidKey={handleInvalidKey}
    />
  )
}
