import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { initAnalytics, trackEvent, trackPageView } from '../utils/analytics'

const SCROLL_THRESHOLDS = [25, 50, 75, 90] as const

interface PageSession {
    path: string
    startedAt: number
    reportedScrollDepths: Set<number>
}

export function useRouteAnalytics() {
    const location = useLocation()
    const pageSessionRef = useRef<PageSession | null>(null)

    const flushPageTime = useCallback(() => {
        const pageSession = pageSessionRef.current
        if (!pageSession) return

        const durationSeconds = Math.round((Date.now() - pageSession.startedAt) / 1000)
        if (durationSeconds <= 0) return

        trackEvent('page_time', {
            page_path: pageSession.path,
            duration_seconds: durationSeconds,
        })
        pageSession.startedAt = Date.now()
    }, [])

    useEffect(() => {
        initAnalytics()

        const path = `${location.pathname}${location.search}`
        flushPageTime()
        pageSessionRef.current = {
            path,
            startedAt: Date.now(),
            reportedScrollDepths: new Set<number>(),
        }
        trackPageView(path)
    }, [flushPageTime, location.pathname, location.search])

    useEffect(() => {
        const reportScrollDepth = () => {
            const pageSession = pageSessionRef.current
            if (!pageSession) return

            const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight
            const percentScrolled = scrollableHeight <= 0
                ? 100
                : Math.min(100, Math.round((window.scrollY / scrollableHeight) * 100))

            for (const threshold of SCROLL_THRESHOLDS) {
                if (percentScrolled < threshold || pageSession.reportedScrollDepths.has(threshold)) continue
                pageSession.reportedScrollDepths.add(threshold)
                trackEvent('scroll_depth', {
                    page_path: pageSession.path,
                    percent_scrolled: threshold,
                })
            }
        }

        window.addEventListener('scroll', reportScrollDepth, { passive: true })
        reportScrollDepth()

        return () => window.removeEventListener('scroll', reportScrollDepth)
    }, [location.pathname, location.search])

    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flushPageTime()
        }
        const onBeforeUnload = () => flushPageTime()

        document.addEventListener('visibilitychange', onVisibilityChange)
        window.addEventListener('beforeunload', onBeforeUnload)

        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange)
            window.removeEventListener('beforeunload', onBeforeUnload)
            flushPageTime()
        }
    }, [flushPageTime])
}
