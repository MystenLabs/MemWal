import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'

export function Drawer({
  title,
  label,
  onClose,
  children,
}: {
  title: string
  label?: string
  onClose: () => void
  children: ReactNode
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = focusable(panelRef)
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [])
  const name = label ?? title
  return (
    <>
      <button className="wa-drawer-back" type="button" aria-label="Dismiss" tabIndex={-1} onClick={onClose} />
      <aside ref={panelRef} className="wa-drawer" role="dialog" aria-modal="true" aria-label={name}>
        <div className="wa-overlay-head">
          <h3>{title}</h3>
          <button ref={closeRef} className="wa-icon-btn" type="button" aria-label={`Close ${name}`} onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </aside>
    </>
  )
}

function focusable(panelRef: RefObject<HTMLElement | null>) {
  if (!panelRef.current) return []
  return [...panelRef.current.querySelectorAll<HTMLElement>('button, a, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hasAttribute('disabled'))
}

export function useNarrow(query = '(max-width: 1100px)') {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}
