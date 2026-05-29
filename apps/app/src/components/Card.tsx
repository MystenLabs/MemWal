import type { CSSProperties, ReactNode } from 'react'

interface CardProps {
    /** Extra class(es) appended to the base `card` class (e.g. `dashboard-keys-card`, `demo-step`). */
    className?: string
    style?: CSSProperties
    title?: ReactNode
    subtitle?: ReactNode
    /** Right-aligned header content (toggles, action buttons, etc.). */
    action?: ReactNode
    /** Content rendered before the title group (e.g. a step badge). */
    leading?: ReactNode
    /** When `leading` is set, the leading + title group are wrapped in a row with this class. */
    leadingRowClassName?: string
    children?: ReactNode
}

/**
 * Shared card shell used across the Dashboard and Playground.
 * Renders the same DOM the pages used inline (`.card` > `.card-header` > title group + action),
 * so existing CSS applies unchanged while keeping padding/margin/radius consistent in one place.
 */
export function Card({
    className,
    style,
    title,
    subtitle,
    action,
    leading,
    leadingRowClassName,
    children,
}: CardProps) {
    const titleGroup = title != null || subtitle != null ? (
        <div>
            {title != null && <div className="card-title">{title}</div>}
            {subtitle != null && <div className="card-subtitle">{subtitle}</div>}
        </div>
    ) : null

    const headerLeft = leading != null ? (
        <div className={leadingRowClassName}>
            {leading}
            {titleGroup}
        </div>
    ) : titleGroup

    const hasHeader = title != null || subtitle != null || action != null || leading != null

    return (
        <div className={className ? `card ${className}` : 'card'} style={style}>
            {hasHeader && (
                <div className="card-header">
                    {headerLeft}
                    {action}
                </div>
            )}
            {children}
        </div>
    )
}
