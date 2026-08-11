import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export function BlobPreviewModal({ blobId, load, onClose }: { blobId: string; load: () => Promise<string>; onClose: () => void }) {
    const [text, setText] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    const closeButton = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        let current = true
        void load().then(value => { if (current) setText(value) }).catch(err => {
            if (current) setError(err instanceof Error ? err.message : 'Preview failed.')
        }).finally(() => { if (current) setLoading(false) })
        return () => { current = false }
    }, [blobId, load])

    useEffect(() => {
        closeButton.current?.focus()
        const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', keydown)
        return () => window.removeEventListener('keydown', keydown)
    }, [onClose])

    return <div className="dashboard-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
        <section className="dashboard-confirm-dialog sd-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="sd-preview-title">
            <div className="dashboard-confirm-copy">
                <h3 id="sd-preview-title">Memory preview</h3>
                {loading && <p role="status">Decrypting in your browser…</p>}
                {error && <p role="alert" className="dashboard-cleanup-error">{error}</p>}
                {!loading && !error && <pre className="sd-preview-content">{text}</pre>}
            </div>
            <div className="dashboard-confirm-actions"><button ref={closeButton} className="btn btn-secondary" onClick={onClose}><X size={16}/> Close</button></div>
        </section>
    </div>
}
