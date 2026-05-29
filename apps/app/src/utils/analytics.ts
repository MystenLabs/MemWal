import { config } from '../config'

type AnalyticsValue = string | number | boolean
type AnalyticsParams = Record<string, AnalyticsValue | null | undefined>
type PostHogInitOptions = {
    api_host: string
    ui_host?: string
    capture_pageview: boolean
    capture_pageleave: boolean
    capture_performance: boolean
    capture_heatmaps: boolean
    autocapture: boolean
    disable_session_recording: boolean
    person_profiles: 'identified_only'
    persistence: 'localStorage+cookie'
    defaults: '2026-01-30'
}
type PostHogClient = unknown[] & {
    [key: string]: unknown
    __SV?: number
    _i?: Array<[string, PostHogInitOptions, string]>
    init?: (projectApiKey: string, options: PostHogInitOptions, name?: string) => void
    capture?: (eventName: string, properties?: Record<string, unknown>) => void
    people?: PostHogClient
    toString?: (stub?: boolean) => string
}

declare global {
    interface Window {
        dataLayer?: unknown[]
        gtag?: (...args: unknown[]) => void
        posthog?: PostHogClient
    }
}

const GA_SCRIPT_ID = 'memwal-ga4-script'
const POSTHOG_SCRIPT_ID = 'memwal-posthog-script'
const POSTHOG_STUB_METHODS = [
    'capture',
    'register',
    'register_once',
    'register_for_session',
    'unregister',
    'opt_out_capturing',
    'has_opted_out_capturing',
    'opt_in_capturing',
    'reset',
    'isFeatureEnabled',
    'getFeatureFlag',
    'getFeatureFlagPayload',
    'reloadFeatureFlags',
    'group',
    'identify',
    'setPersonProperties',
    'setPersonPropertiesForFlags',
    'resetPersonPropertiesForFlags',
    'setGroupPropertiesForFlags',
    'resetGroupPropertiesForFlags',
    'resetGroups',
    'onFeatureFlags',
    'addFeatureFlagsHandler',
    'onSessionId',
] as const

let googleAnalyticsInitialized = false
let posthogInitialized = false

function normalizeAllowedHost(allowedHost: string): string {
    const normalizedHost = allowedHost.trim().toLowerCase()
    if (normalizedHost === '*') return normalizedHost
    return normalizedHost
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .split(':')[0]
}

function hostMatchesAllowed(currentHost: string, allowedHost: string): boolean {
    const normalizedAllowedHost = normalizeAllowedHost(allowedHost)
    if (normalizedAllowedHost === '*') return true
    if (normalizedAllowedHost.startsWith('*.')) {
        const suffix = normalizedAllowedHost.slice(1)
        return currentHost.endsWith(suffix) && currentHost !== suffix.slice(1)
    }

    return currentHost === normalizedAllowedHost
}

function analyticsHostAllowed(): boolean {
    if (typeof window === 'undefined') return false
    if (!config.analyticsAllowedHosts.length) return false

    const currentHost = window.location.hostname.toLowerCase()
    return config.analyticsAllowedHosts.some(host => hostMatchesAllowed(currentHost, host))
}

function googleAnalyticsEnabled(): boolean {
    return analyticsHostAllowed() && Boolean(config.gaMeasurementId)
}

function posthogEnabled(): boolean {
    return analyticsHostAllowed() && Boolean(config.posthogProjectApiKey)
}

function analyticsEnabled(): boolean {
    return googleAnalyticsEnabled() || posthogEnabled()
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

function initGoogleAnalytics() {
    if (!googleAnalyticsEnabled() || googleAnalyticsInitialized) return

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

    googleAnalyticsInitialized = true
}

function posthogAssetHost(apiHost: string): string {
    return apiHost
        .replace(/\/+$/, '')
        .replace('.i.posthog.com', '-assets.i.posthog.com')
}

function stubPostHogMethod(target: PostHogClient, method: string) {
    target[method] = (...args: unknown[]) => {
        target.push([method, ...args])
    }
}

function createPostHogQueue(): PostHogClient {
    return [] as unknown as PostHogClient
}

function installPostHogStub(): PostHogClient {
    if (window.posthog?.__SV) return window.posthog

    // PostHog's CDN loader consumes this init queue and any method calls made
    // before the downloaded SDK finishes loading.
    const root = (window.posthog ?? createPostHogQueue()) as PostHogClient
    window.posthog = root
    root._i = []

    root.init = (projectApiKey, options, name) => {
        const instanceName = name ?? 'posthog'
        const target = name
            ? ((root[name] as PostHogClient | undefined) ?? createPostHogQueue())
            : root
        if (name) root[name] = target

        target.people = target.people ?? createPostHogQueue()
        target.toString = (stub?: boolean) => `${instanceName}${stub ? ' (stub)' : ''}`
        target.people.toString = () => `${target.toString?.(true)}.people (stub)`

        for (const method of POSTHOG_STUB_METHODS) {
            if (typeof target[method] !== 'function') stubPostHogMethod(target, method)
        }

        if (!document.getElementById(POSTHOG_SCRIPT_ID)) {
            const script = document.createElement('script')
            script.id = POSTHOG_SCRIPT_ID
            script.async = true
            script.crossOrigin = 'anonymous'
            script.src = `${posthogAssetHost(options.api_host)}/static/array.js`
            document.head.appendChild(script)
        }

        root._i?.push([projectApiKey, options, instanceName])
    }
    root.__SV = 1

    return root
}

function initPostHog() {
    if (!posthogEnabled() || posthogInitialized) return

    const posthog = installPostHogStub()
    const uiHost = config.posthogUiHost || undefined
    posthog.init?.(config.posthogProjectApiKey, {
        api_host: config.posthogHost,
        ...(uiHost ? { ui_host: uiHost } : {}),
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        capture_heatmaps: false,
        autocapture: false,
        disable_session_recording: true,
        person_profiles: 'identified_only',
        persistence: 'localStorage+cookie',
        defaults: '2026-01-30',
    })

    posthogInitialized = true
}

export function initAnalytics() {
    initGoogleAnalytics()
    initPostHog()
}

export function trackPageView(path: string) {
    if (!analyticsEnabled()) return
    initAnalytics()
    const params = withDefaultParams({
        page_path: path,
        page_location: window.location.href,
        page_title: document.title,
    })

    if (googleAnalyticsEnabled()) {
        window.gtag?.('event', 'page_view', params)
    }

    if (posthogEnabled()) {
        window.posthog?.capture?.('$pageview', {
            ...params,
            $current_url: window.location.href,
        })
    }
}

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
    if (!analyticsEnabled()) return
    initAnalytics()
    const eventParams = withDefaultParams(params)

    if (googleAnalyticsEnabled()) {
        window.gtag?.('event', eventName, eventParams)
    }

    if (posthogEnabled()) {
        window.posthog?.capture?.(eventName, eventParams)
    }
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
