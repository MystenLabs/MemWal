import { config } from '../config'

type AnalyticsValue = string | number | boolean
type AnalyticsParams = Record<string, AnalyticsValue | null | undefined>

declare global {
    interface Window {
        dataLayer?: unknown[]
        gtag?: (...args: unknown[]) => void
    }
}

const GA_SCRIPT_ID = 'memwal-ga4-script'

let initialized = false

function analyticsEnabled(): boolean {
    return typeof window !== 'undefined' && Boolean(config.gaMeasurementId)
}

function withDefaultParams(params: AnalyticsParams = {}): Record<string, AnalyticsValue> {
    const next: Record<string, AnalyticsValue> = {
        app: 'memwal_web_app',
        sui_network: config.suiNetwork,
    }

    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue
        next[key] = value
    }

    return next
}

export function initAnalytics() {
    if (!analyticsEnabled() || initialized) return

    window.dataLayer = window.dataLayer ?? []
    window.gtag = window.gtag ?? function gtag() {
        // Match Google's snippet exactly: gtag.js consumes the Arguments object.
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer?.push(arguments)
    }

    window.gtag('js', new Date())
    window.gtag('config', config.gaMeasurementId, {
        send_page_view: false,
    })

    if (!document.getElementById(GA_SCRIPT_ID)) {
        const script = document.createElement('script')
        script.id = GA_SCRIPT_ID
        script.async = true
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.gaMeasurementId)}`
        document.head.appendChild(script)
    }

    initialized = true
}

export function trackPageView(path: string) {
    if (!analyticsEnabled()) return
    initAnalytics()
    window.gtag?.('event', 'page_view', withDefaultParams({
        page_path: path,
        page_location: window.location.href,
        page_title: document.title,
    }))
}

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
    if (!analyticsEnabled()) return
    initAnalytics()
    window.gtag?.('event', eventName, withDefaultParams(params))
}

export function getAnalyticsErrorType(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    const lower = message.toLowerCase()

    if (lower.includes('maximum') || lower.includes('max') || lower.includes('abort code: 2')) return 'max_delegate_keys'
    if (lower.includes('reject') || lower.includes('denied') || lower.includes('cancel')) return 'user_rejected'
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout'
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) return 'network_error'
    if (lower.includes('unauthorized') || lower.includes('401')) return 'unauthorized'
    if (lower.includes('invalid')) return 'invalid_input'
    if (lower.includes('not found') || lower.includes('no walrus memory account')) return 'not_found'

    return 'unknown_error'
}
