import { useState, useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { Card } from './Card'
import { CopyButton } from './CopyButton'
import { CopyableText } from './CopyableText'
import {
  fetchAdminErrors,
  shortAddress,
  suiExplorerAccountUrl,
  type UploadError,
} from '../utils/admin-api'

interface AdminUploadErrorsProps {
  adminKey: string
  onInvalidKey: () => void
}

/** "4m 12s" between two ISO times; null when either is unreadable. */
function describeDuration(fromIso: string, toIso: string): string | null {
  const ms = Date.parse(toIso) - Date.parse(fromIso)
  if (!Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Everything about one failed job, for pasting into a ticket or chat. */
function errorDetailsText(error: UploadError): string {
  return JSON.stringify(
    {
      job_id: error.id,
      owner: error.owner,
      namespace: error.namespace,
      status: error.status,
      created_at: error.createdAt,
      failed_at: error.timestamp,
      error_message: error.rawErrorMessage,
    },
    null,
    2,
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-error-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function AdminUploadErrors({ adminKey, onInvalidKey }: AdminUploadErrorsProps) {
  const [limit, setLimit] = useState(20)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<UploadError | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'errors', limit, offset],
    queryFn: () => fetchAdminErrors(adminKey, limit, offset),
    retry: (failureCount, error) => {
      const err = error as Error
      return err.message !== 'INVALID_KEY' && failureCount < 3
    },
  })

  const isInvalidKey = error instanceof Error && error.message === 'INVALID_KEY'

  useEffect(() => {
    if (isInvalidKey) onInvalidKey()
  }, [isInvalidKey, onInvalidKey])

  useEffect(() => {
    if (!expanded) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [expanded])

  const openError = (error: UploadError) => {
    setExpanded(error)
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
      <Card title="Upload Errors" className="dashboard-keys-card sept-section admin-errors-card">
        <div className="admin-loading">Loading error data...</div>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Upload Errors" className="dashboard-keys-card sept-section admin-errors-card">
        <div className="admin-error">
          {isInvalidKey ? 'Invalid API key — signing out...' : 'Failed to load errors'}
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card title="Upload Errors" className="dashboard-keys-card sept-section admin-errors-card">
        <div className="admin-error">No data available</div>
      </Card>
    )
  }

  const startNum = data.total === 0 ? 0 : offset + 1
  const endNum = Math.min(offset + limit, data.total)

  return (
    <>
      <Card title="Upload Errors" className="dashboard-keys-card sept-section admin-errors-card">
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
                  <td colSpan={4} className="admin-table-empty">
                    No errors to display
                  </td>
                </tr>
              ) : (
                data.errors.map((error) => (
                  <tr key={error.id} className="admin-table-row">
                    <td className="admin-table-monospace admin-error-timestamp">
                      {new Date(error.timestamp).toLocaleString()}
                    </td>
                    <td className="admin-table-monospace">
                      <CopyableText
                        value={error.owner}
                        display={shortAddress(error.owner)}
                        label="Copy owner address"
                      />
                    </td>
                    <td>{error.namespace}</td>
                    <td className="admin-error-message">
                      <button
                        className="admin-error-msg-btn"
                        onClick={() => openError(error)}
                        title="View error details"
                      >
                        {error.errorMessage.length > 50
                          ? `${error.errorMessage.slice(0, 50)}...`
                          : error.errorMessage}
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
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={handleNext}
              disabled={offset + limit >= data.total}
              className="admin-pagination-btn"
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </Card>

      {expanded && (
        <div className="admin-error-modal-overlay" onClick={closeError}>
          <div
            className="admin-error-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-error-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-error-modal-header">
              <h3 id="admin-error-dialog-title">Error Details</h3>
              <button
                onClick={closeError}
                className="admin-error-modal-close"
                aria-label="Close modal"
              >
                ×
              </button>
            </div>
            <div className="admin-error-modal-content">
              <dl className="admin-error-details">
                <DetailRow label="Job ID">
                  <CopyableText value={expanded.id} label="Copy job ID" className="admin-detail-mono" />
                </DetailRow>
                <DetailRow label="Owner">
                  <CopyableText
                    value={expanded.owner}
                    label="Copy owner address"
                    wrap
                    className="admin-detail-mono"
                  />
                  <a
                    className="admin-detail-link"
                    href={suiExplorerAccountUrl(expanded.owner)}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="Open owner on Sui explorer"
                    title="Open on Sui explorer"
                  >
                    <ExternalLink size={14} />
                  </a>
                </DetailRow>
                <DetailRow label="Namespace">
                  <CopyableText
                    value={expanded.namespace}
                    label="Copy namespace"
                    className="admin-detail-mono"
                  />
                </DetailRow>
                <DetailRow label="Status">
                  <span className="admin-status-badge admin-status-badge--critical">
                    {expanded.status}
                  </span>
                </DetailRow>
                <DetailRow label="Queued">
                  {new Date(expanded.createdAt).toLocaleString()}
                </DetailRow>
                <DetailRow label="Failed">
                  {new Date(expanded.timestamp).toLocaleString()}
                  {describeDuration(expanded.createdAt, expanded.timestamp) && (
                    <span className="admin-detail-muted">
                      {' '}
                      · after {describeDuration(expanded.createdAt, expanded.timestamp)}
                    </span>
                  )}
                </DetailRow>
              </dl>

              <div className="admin-error-detail-message-head">
                <span>Error message</span>
                {expanded.rawErrorMessage && (
                  <CopyButton text={expanded.rawErrorMessage} ariaLabel="Copy error message" />
                )}
              </div>
              {expanded.rawErrorMessage ? (
                <pre className="admin-error-modal-message">{expanded.rawErrorMessage}</pre>
              ) : (
                <p className="admin-error-modal-message admin-error-modal-message--empty">
                  The server recorded no error message for this job. Use the job ID to look it up
                  in the relayer logs.
                </p>
              )}
            </div>
            <div className="admin-error-modal-footer">
              <CopyButton
                text={() => errorDetailsText(expanded)}
                ariaLabel="Copy all details"
                size="sm"
                className="admin-copy-full-btn"
              >
                Copy all details
              </CopyButton>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
