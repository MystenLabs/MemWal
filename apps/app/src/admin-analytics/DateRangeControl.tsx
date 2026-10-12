import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { Chevron } from './Controls'
import { RANGE_PRESETS, type CompareId, type RangeId } from './range'

const GROUPS = ['Days', 'Calendar', 'Rolling', 'Custom'] as const
const COMPARES: { id: CompareId; label: string }[] = [
  { id: 'none', label: 'No comparison' },
  { id: 'previous', label: 'Previous equivalent period' },
  { id: 'week', label: 'Same period last week' },
  { id: 'month', label: 'Same period last month' },
  { id: 'year', label: 'Same period last year' },
]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface RangeCommit {
  range: RangeId
  day?: string
  month?: string
  year?: string
  from?: string
  to?: string
}

function useMenu(open: boolean, onClose: () => void, triggers: Array<HTMLButtonElement | null>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if (triggers.some((trigger) => trigger?.contains(target))) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open, onClose, triggers])
  return ref
}

function place(trigger: HTMLButtonElement | null) {
  if (!trigger) return { top: 8, left: 8, upward: false }
  const box = trigger.getBoundingClientRect()
  const width = 300
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))
  const below = window.innerHeight - box.bottom
  const upward = below < 280 && box.top > below
  return { top: upward ? Math.max(8, box.top - 8 - 360) : box.bottom + 6, left, upward }
}

function daysIn(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function DateRangeControl({
  range,
  label,
  compare,
  compareLabel,
  selected,
  onCommit,
  onCompare,
  rangeTitle,
}: {
  range: RangeId
  label: string
  compare: CompareId
  compareLabel: string
  selected: { day?: string; month?: string; year?: string }
  onCommit: (patch: RangeCommit) => void
  onCompare: (id: CompareId) => void
  rangeTitle?: string
}) {
  const [open, setOpen] = useState<'range' | 'compare' | 'month' | 'day' | 'year' | 'custom' | null>(null)
  const [active, setActive] = useState(0)
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })
  const [draftDay, setDraftDay] = useState(selected.day ?? '')
  const [draftMonth, setDraftMonth] = useState(selected.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [draftYear, setDraftYear] = useState(selected.year ?? String(now.getFullYear()))
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [customError, setCustomError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const compareTrigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = () => {
    setOpen(null)
    setCustomError('')
    ;(open === 'compare' ? compareTrigger : trigger).current?.focus()
  }
  const ref = useMenu(open !== null, close, [trigger.current, compareTrigger.current])
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, ref])
  const box = place(open === 'compare' ? compareTrigger.current : trigger.current)

  const chooseRange = (id: RangeId) => {
    if (id === 'month-pick') {
      setOpen('month')
      return
    }
    if (id === 'day') {
      setOpen('day')
      return
    }
    if (id === 'year-pick') {
      setOpen('year')
      return
    }
    if (id === 'custom') {
      setOpen('custom')
      return
    }
    onCommit({ range: id })
    close()
  }

  useEffect(() => {
    if (open !== 'range' && open !== 'compare') return
    const count = open === 'compare' ? COMPARES.length : RANGE_PRESETS.length
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
      event.preventDefault()
      if (event.key === 'Enter') {
        if (open === 'compare') { onCompare(COMPARES[active]?.id ?? 'none'); close() }
        else chooseRange(RANGE_PRESETS[active]?.id ?? '7d')
        return
      }
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, active, onCompare])

  const applyCustom = () => {
    const from = new Date(draftFrom)
    const to = new Date(draftTo)
    if (!draftFrom || !draftTo || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      setCustomError('Start must be before end.')
      return
    }
    onCommit({ range: 'custom', from: from.toISOString(), to: to.toISOString() })
    close()
  }

  return (
    <>
      <button ref={trigger} className="wa-btn" type="button" title={rangeTitle} aria-haspopup="dialog" aria-expanded={open !== null && open !== 'compare'} aria-controls={menuId} onClick={() => { setActive(Math.max(0, RANGE_PRESETS.findIndex((item) => item.id === range))); setOpen(open && open !== 'compare' ? null : 'range') }}>
        <span>{label}</span>
        <Chevron />
      </button>
      <button ref={compareTrigger} className="wa-btn" type="button" aria-haspopup="listbox" aria-expanded={open === 'compare'} onClick={() => setOpen(open === 'compare' ? null : 'compare')}>
        <span>{compareLabel}</span>
        <Chevron />
      </button>
      {open && createPortal(
        <div ref={ref} id={menuId} className="wa-menu" role="dialog" aria-label="Date range" style={{ top: box.top, left: box.left, position: 'fixed' }}>
          {open === 'range' && GROUPS.map((group) => (
            <div key={group}>
              <div className="wa-menu-group">{group}</div>
              {RANGE_PRESETS.filter((item) => item.group === group).map((item) => {
                const index = RANGE_PRESETS.findIndex((candidate) => candidate.id === item.id)
                return (
                  <button key={item.id} type="button" role="option" aria-selected={range === item.id} className={active === index ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => chooseRange(item.id)}>
                    <Check size={14} aria-hidden="true" style={{ opacity: range === item.id ? 1 : 0 }} />
                    {item.label}
                  </button>
                )
              })}
            </div>
          ))}
          {open === 'compare' && COMPARES.map((item, index) => (
            <button key={item.id} type="button" role="option" aria-selected={compare === item.id} className={active === index ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => { onCompare(item.id); close() }}>
              <Check size={14} aria-hidden="true" style={{ opacity: compare === item.id ? 1 : 0 }} />
              {item.label}
            </button>
          ))}
          {open === 'month' && (
            <div className="wa-cal-panel">
              <div className="wa-flyout-head">
                <button type="button" onClick={() => setCursor((value) => ({ ...value, year: value.year - 1 }))}>Previous year</button>
                <b>{cursor.year}</b>
                <button type="button" onClick={() => setCursor((value) => ({ ...value, year: value.year + 1 }))}>Next year</button>
              </div>
              <div className="wa-months">
                {MONTHS.map((name, index) => {
                  const value = `${cursor.year}-${String(index + 1).padStart(2, '0')}`
                  return <button key={name} type="button" aria-pressed={draftMonth === value} onClick={() => setDraftMonth(value)}>{name}</button>
                })}
              </div>
              <div className="wa-flyout-head">
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" onClick={() => { onCommit({ range: 'month-pick', month: draftMonth }); close() }}>Apply</button>
              </div>
            </div>
          )}
          {open === 'day' && (
            <div className="wa-cal-panel">
              <div className="wa-flyout-head">
                <button type="button" onClick={() => setCursor((value) => value.month === 1 ? { year: value.year - 1, month: 12 } : { ...value, month: value.month - 1 })}>Previous</button>
                <b>{MONTHS[cursor.month - 1]} {cursor.year}</b>
                <button type="button" onClick={() => setCursor((value) => value.month === 12 ? { year: value.year + 1, month: 1 } : { ...value, month: value.month + 1 })}>Next</button>
              </div>
              <div className="wa-cal">
                {Array.from({ length: daysIn(cursor.year, cursor.month) }, (_, index) => {
                  const value = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
                  return <button key={value} type="button" aria-pressed={draftDay === value} onClick={() => setDraftDay(value)}>{index + 1}</button>
                })}
              </div>
              <div className="wa-flyout-head">
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" disabled={!draftDay} onClick={() => { onCommit({ range: 'day', day: draftDay }); close() }}>Apply</button>
              </div>
            </div>
          )}
          {open === 'year' && (
            <div className="wa-cal-panel">
              <div className="wa-months">
                {Array.from({ length: 12 }, (_, index) => String(cursor.year - 6 + index)).map((value) => (
                  <button key={value} type="button" aria-pressed={draftYear === value} onClick={() => setDraftYear(value)}>{value}</button>
                ))}
              </div>
              <div className="wa-flyout-head">
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" onClick={() => { onCommit({ range: 'year-pick', year: draftYear }); close() }}>Apply</button>
              </div>
            </div>
          )}
          {open === 'custom' && (
            <div className="wa-cal-panel">
              <label className="wa-note">Start<input className="wa-input" type="datetime-local" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} /></label>
              <label className="wa-note">End<input className="wa-input" type="datetime-local" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} /></label>
              {customError && <p className="wa-note">{customError}</p>}
              <div className="wa-flyout-head">
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" onClick={applyCustom}>Apply</button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
