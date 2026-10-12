import type { CSSProperties } from 'react'
import type { CopyStatus } from '../hooks/useCopyFeedback'

const SVG_PROPS = {
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const

/**
 * Copy, check, and cross icons stacked in one cell. The active one fades and
 * scales in, the check draws its stroke, and screen readers hear the result.
 * Motion lives in index.css (`.copy-status-icon`) and honors reduced motion.
 */
export function CopyStatusIcon({ status, size = 14 }: { status: CopyStatus; size?: number }) {
    return (
        <>
            <span
                className={`copy-status-icon copy-status-icon--${status}`}
                style={{ '--copy-status-size': `${size}px` } as CSSProperties}
                aria-hidden="true"
            >
                <svg {...SVG_PROPS} data-icon="idle">
                    <path d="M9.6 5.1V3.7A1.7 1.7 0 0 0 7.9 2H3.7A1.7 1.7 0 0 0 2 3.7v4.2a1.7 1.7 0 0 0 1.7 1.7h1.4" />
                    <rect x="5.1" y="5.1" width="6.9" height="6.9" rx="1.7" />
                </svg>
                <svg {...SVG_PROPS} data-icon="copied">
                    <path pathLength={1} d="M2.9 7.4 5.6 10.1 11.1 4" />
                </svg>
                <svg {...SVG_PROPS} data-icon="error">
                    <path d="M3.6 3.6 10.4 10.4" />
                    <path d="M10.4 3.6 3.6 10.4" />
                </svg>
            </span>
            <span className="copy-btn-live" role="status" aria-live="polite">
                {status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : ''}
            </span>
        </>
    )
}

/**
 * Button text that blurs between its idle, copied, and error wording. All three
 * share one grid cell, so the button keeps the width of the longest one.
 */
export function CopyStatusLabel({
    status,
    idle,
    copied = 'Copied',
    error = 'Copy failed',
}: {
    status: CopyStatus
    idle: string
    copied?: string
    error?: string
}) {
    const labels: Array<[CopyStatus, string]> = [
        ['idle', idle],
        ['copied', copied],
        ['error', error],
    ]
    return (
        <span className="copy-status-label" aria-hidden="true">
            {labels.map(([key, text]) => (
                <span key={key} data-active={key === status || undefined}>
                    {text}
                </span>
            ))}
        </span>
    )
}
