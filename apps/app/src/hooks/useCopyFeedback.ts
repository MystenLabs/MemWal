import { useCallback, useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../components/CopyButton'

export type CopyStatus = 'idle' | 'copied' | 'error'

type CopyResult = { item: string; status: Exclude<CopyStatus, 'idle'> }

/**
 * Copy feedback for a group of copy buttons that share one page.
 * Only the most recently clicked item shows "copied" or "error"; a new
 * click restarts the timer, so an older click cannot cut it short.
 */
export function useCopyFeedback(timeout = 2000) {
    const [result, setResult] = useState<CopyResult | null>(null)
    const timer = useRef<number | undefined>(undefined)
    const mounted = useRef(false)

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            window.clearTimeout(timer.current)
        }
    }, [])

    const copy = useCallback(async (text: string, item: string) => {
        let ok = true
        try {
            await writeClipboard(text)
        } catch {
            ok = false
        }
        if (!mounted.current) return ok
        window.clearTimeout(timer.current)
        setResult({ item, status: ok ? 'copied' : 'error' })
        timer.current = window.setTimeout(() => setResult(null), timeout)
        return ok
    }, [timeout])

    const statusOf = useCallback(
        (item: string): CopyStatus => (result?.item === item ? result.status : 'idle'),
        [result],
    )

    return { copy, statusOf }
}
