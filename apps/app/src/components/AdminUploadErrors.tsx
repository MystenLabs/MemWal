import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from './Card'
import { fetchAdminErrors } from '../utils/admin-api'

interface AdminUploadErrorsProps {
  adminKey: string
}

interface ExpandedError {
  timestamp: string
  fullMessage: string
}

export function AdminUploadErrors({ adminKey }: AdminUploadErrorsProps) {
  const [limit, setLimit] = useState(20)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<ExpandedError | null>(null)
  const [copied, setCopied] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['adminErrors', adminKey, limit, offset],
    queryFn: () => fetchAdminErrors(adminKey, limit, offset),
    retry: (failureCount, error) => {
      const err = error as Error
      return err.message !== 'INVALID_KEY' && failureCount < 3
    },
  })

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const openError = (timestamp: string, message: string) => {
    setExpanded({ timestamp, fullMessage: message })
  }

  const closeError = () => {
    setExpanded(null)
  }

  const handlePrev = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit))
    }
  }

  const handleNext = () => {
    if (data && offset + limit < data.total) {
      setOffset(offset + limit)
    }
  }

  if (isLoading) {
    return (
      <Card title="Upload Errors" className="admin-errors-card">
        <div className="admin-loading">Loading error data...</div>
      </Card>
    )
  }

  if (error) {
    const err = error as Error
    return (
      <Card title="Upload Errors" className="admin-errors-card">
        <div className="admin-error">
          {err.message === 'INVALID_KEY' ? 'Invalid API key' : 'Failed to load errors'}
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card title="Upload Errors" className="admin-errors-card">
        <div className="admin-error">No data available</div>
      </Card>
    )
  }

  const startNum = offset + 1
  const endNum = Math.min(offset + limit, data.total)

  return (
    <>
      <Card title="Upload Errors" className="admin-errors-card">
        <div className="admin-errors-controls">
          <label htmlFor="error-limit" className="admin-limit-label">
            Show:
          </label>
          <select
            id="error-limit"
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value))
              setOffset(0)
            }}
            className="admin-limit-select"
          >
            <option value={20}>20 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>
        </div>

        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Owner</th>
                <th scope="col">Namespace</th>
                <th scope="col">Error Message</th>
              </tr>
            </thead>
            <tbody>
              {data.errors.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: '#999' }}>
                    No errors to display
                  </td>
                </tr>
              ) : (
                data.errors.map((error, idx) => (
                  <tr key={`${error.timestamp}-${idx}`} className="admin-table-row">
                    <td className="admin-table-monospace admin-error-timestamp">
                      {new Date(error.timestamp).toLocaleString()}
                    </td>
                    <td className="admin-table-monospace">
                      {error.owner.slice(0, 6)}
                    </td>
                    <td>{error.namespace}</td>
                    <td className="admin-error-message">
                      <button
                        className="admin-error-msg-btn"
                        onClick={() => openError(error.timestamp, error.errorMessage ?? '(no message)')}
                        title="View full error message"
                      >
                        {(error.errorMessage ?? '(no message)').length > 50
                          ? `${(error.errorMessage ?? '').slice(0, 50)}...`
                          : (error.errorMessage ?? '(no message)')}
                      </button>
                      <button
                        className="admin-copy-btn"
                        onClick={() => handleCopy(error.errorMessage ?? '(no message)')}
                        title="Copy error message"
                      >
                        <Copy size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="admin-pagination">
          <div className="admin-pagination-status">
            Showing {startNum}-{endNum} of {data.total}
          </div>
          <div className="admin-pagination-controls">
            <button
              onClick={handlePrev}
              disabled={offset === 0}
              className="admin-pagination-btn"
              title="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={handleNext}
              disabled={offset + limit >= data.total}
              className="admin-pagination-btn"
              title="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </Card>

      {expanded && (
        <div className="admin-error-modal-overlay" onClick={closeError}>
          <div className="admin-error-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-error-modal-header">
              <h3>Error Details</h3>
              <button
                onClick={closeError}
                className="admin-error-modal-close"
                aria-label="Close modal"
              >
                ×
              </button>
            </div>
            <div className="admin-error-modal-content">
              <p className="admin-error-modal-timestamp">
                {new Date(expanded.timestamp).toLocaleString()}
              </p>
              <pre className="admin-error-modal-message">
                {expanded.fullMessage}
              </pre>
            </div>
            <div className="admin-error-modal-footer">
              <button
                onClick={() => handleCopy(expanded.fullMessage)}
                className="admin-copy-full-btn"
              >
                <Copy size={14} />
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
