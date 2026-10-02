import { useEffect, useRef, useState } from 'react'
import { Check, CircleX, Copy } from 'lucide-react'

import { writeClipboard } from './CopyButton'

type CopyStatus = 'idle' | 'done' | 'error'

interface CopyableTextProps {
  /** The full value that goes on the clipboard. */
  value: string
  /** What is shown; defaults to the value itself. */
  display?: string
  /** Accessible name, e.g. "Copy owner address". */
  label: string
  /** Let long values (a full address) wrap instead of overflowing. */
  wrap?: boolean
  className?: string
}

const RESET_MS = 1600

/**
 * A value you click to copy. No box around it: the text itself is the button.
 * A small copy icon shows on hover or focus; after a click the text turns
 * green, the icon pops to a check, and a "Copied" chip floats up and fades.
 */
export function CopyableText({ value, display, label, wrap = false, className = '' }: CopyableTextProps) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const handleClick = async (event: React.MouseEvent) => {
    event.stopPropagation()
    window.clearTimeout(timer.current)
    try {
      await writeClipboard(value)
      setStatus('done')
    } catch {
      setStatus('error')
    }
    timer.current = window.setTimeout(() => setStatus('idle'), RESET_MS)
  }

  const statusText = status === 'done' ? 'Copied' : status === 'error' ? 'Copy failed' : ''

  return (
    <button
      type="button"
      className={`copy-text copy-text--${status}${wrap ? ' copy-text--wrap' : ''} ${className}`.trim()}
      onClick={handleClick}
      title={statusText || `${label}: ${value}`}
      aria-label={statusText ? `${label}: ${statusText.toLowerCase()}` : label}
    >
      <span className="copy-text-value">{display ?? value}</span>
      <span className="copy-text-icon" key={status} aria-hidden="true">
        {status === 'done' ? <Check size={13} /> : status === 'error' ? <CircleX size={13} /> : <Copy size={13} />}
      </span>
      {statusText && (
        <span className="copy-text-chip" key={`chip-${status}`} aria-hidden="true">
          {statusText}
        </span>
      )}
      <span className="copy-btn-live" aria-live="polite">
        {statusText}
      </span>
    </button>
  )
}
