import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { RANGE_PRESETS, type CompareId, type RangeId } from './range'

const GROUPS = ['Days', 'Calendar', 'Rolling', 'Custom'] as const
const COMPARES: { id: CompareId; label: string }[] = [
  { id: 'none', label: 'No comparison' },
  { id: 'previous', label: 'Previous equivalent period' },
  { id: 'week', label: 'Same period last week' },
  { id: 'month', label: 'Same period last month' },
  { id: 'year', label: 'Same period last year' },
]

function useMenu(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open, onClose])
  return ref
}

function place(trigger: HTMLButtonElement | null) {
  if (!trigger) return { top: 0, left: 0 }
  const box = trigger.getBoundingClientRect()
  const width = 280
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))
  const below = window.innerHeight - box.bottom
  const top = below < 220 && box.top > below ? box.top - 8 : box.bottom + 6
  return { top, left, upward: below < 220 && box.top > below }
}

export function DateRangeControl({
  range,
  label,
  onRange,
  compare,
  compareLabel,
  onCompare,
}: {
  range: RangeId
  label: string
  onRange: (id: RangeId) => void
  compare: CompareId
  compareLabel: string
  onCompare: (id: CompareId) => void
}) {
  const [open, setOpen] = useState<'range' | 'compare' | null>(null)
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const compareTrigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = () => {
    setOpen(null)
    ;(open === 'compare' ? compareTrigger : trigger).current?.focus()
  }
  const ref = useMenu(open !== null, close)
  const options = open === 'compare' ? COMPARES : RANGE_PRESETS
  const box = place(open === 'compare' ? compareTrigger.current : trigger.current)

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((value) => Math.min(options.length - 1, value + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((value) => Math.max(0, value - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = options[active]
      if (!item) return
      if (open === 'compare') onCompare(item.id as CompareId)
      else onRange(item.id as RangeId)
      close()
    }
  }

  return (
    <>
      <button ref={trigger} className="wa-btn" type="button" aria-haspopup="listbox" aria-expanded={open === 'range'} aria-controls={menuId} onClick={() => { setOpen(open === 'range' ? null : 'range'); setActive(Math.max(0, RANGE_PRESETS.findIndex((item) => item.id === range))) }}>
        {label}
      </button>
      <button ref={compareTrigger} className="wa-btn" type="button" aria-haspopup="listbox" aria-expanded={open === 'compare'} onClick={() => { setOpen(open === 'compare' ? null : 'compare'); setActive(Math.max(0, COMPARES.findIndex((item) => item.id === compare))) }}>
        {compareLabel}
      </button>
      {open && createPortal(
        <div ref={ref} id={menuId} className={`wa-menu${box.upward ? ' up' : ''}`} role="listbox" style={{ top: box.top, left: box.left }} onKeyDown={onMenuKey}>
          {open === 'range' ? GROUPS.map((group) => (
            <div key={group}>
              <div className="wa-menu-group">{group}</div>
              {RANGE_PRESETS.filter((item) => item.group === group).map((item) => {
                const index = RANGE_PRESETS.findIndex((candidate) => candidate.id === item.id)
                return (
                  <button key={item.id} type="button" role="option" aria-selected={range === item.id} className={active === index ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => { onRange(item.id); close() }}>
                    <Check size={14} aria-hidden="true" style={{ opacity: range === item.id ? 1 : 0 }} />
                    {item.label}
                  </button>
                )
              })}
            </div>
          )) : COMPARES.map((item, index) => (
            <button key={item.id} type="button" role="option" aria-selected={compare === item.id} className={active === index ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => { onCompare(item.id); close() }}>
              <Check size={14} aria-hidden="true" style={{ opacity: compare === item.id ? 1 : 0 }} />
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
