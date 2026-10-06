import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleX, Copy } from 'lucide-react'

type CopyStatus = 'idle' | 'done' | 'error'

interface CopyButtonProps {
  /** Text to copy, or a function that returns it at click time. */
  text: string | (() => string)
  /** Optional label beside the icon. Without it the button is icon-only. */
  children?: ReactNode
  /** Accessible name; also the hover title while idle. */
  ariaLabel?: string
  className?: string
  size?: 'icon' | 'sm'
  onCopySuccess?: (text: string) => void
  onCopyError?: (error: Error) => void
}

/** How long the done or error state stays before returning to idle. */
const RESET_MS = 1600

export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Clipboard API is unavailable on plain-HTTP origins other than localhost.
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('Copy command was rejected')
}

/**
 * Copies text and shows what happened: the icon swaps to a check (or a cross)
 * with a short pop, the label reads "Copied", and screen readers hear it.
 */
export function CopyButton({
  text,
  children,
  ariaLabel = 'Copy',
  className = '',
  size = 'icon',
  onCopySuccess,
  onCopyError,
}: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const handleClick = async (event: React.MouseEvent) => {
    // Rows and modals often have their own click handlers.
    event.stopPropagation()
    const value = typeof text === 'function' ? text() : text
    window.clearTimeout(timer.current)
    try {
      await writeClipboard(value)
      setStatus('done')
      onCopySuccess?.(value)
    } catch (err) {
      setStatus('error')
      onCopyError?.(err instanceof Error ? err : new Error(String(err)))
    }
    timer.current = window.setTimeout(() => setStatus('idle'), RESET_MS)
  }

  const icon =
    status === 'done' ? <Check size={14} /> : status === 'error' ? <CircleX size={14} /> : <Copy size={14} />
  const statusText = status === 'done' ? 'Copied' : status === 'error' ? 'Copy failed' : ''

  return (
    <button
      type="button"
      className={`copy-btn copy-btn--${size} copy-btn--${status} ${className}`.trim()}
      onClick={handleClick}
      aria-label={statusText ? `${ariaLabel}: ${statusText.toLowerCase()}` : ariaLabel}
      title={statusText || ariaLabel}
    >
      {/* Keyed so each state change remounts and replays the pop. */}
      <span className="copy-btn-icon" key={status} aria-hidden="true">
        {icon}
      </span>
      {children != null && <span className="copy-btn-label">{statusText || children}</span>}
      <span className="copy-btn-live" aria-live="polite">
        {statusText}
      </span>
    </button>
  )
}
