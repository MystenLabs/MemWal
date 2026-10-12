import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import { bucketInterval, shortDate, visibleTickIndexes } from './chartTicks'

export interface CountBucket {
  id: string
  label: string
  count: number
  region: 'before' | 'during' | 'after'
  partial?: boolean
}

const FILL = { before: '#6e6e6e', during: '#8055ff', after: '#c4b6ff' }

export function CountChart({
  title,
  unit,
  grain,
  timeZone,
  buckets,
  notice,
  showRegions = true,
  onOpen,
}: {
  title: string
  unit: string
  grain: string
  timeZone: string
  buckets: CountBucket[]
  notice?: string
  showRegions?: boolean
  onOpen?: (bucket: CountBucket) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const expandRef = useRef<HTMLButtonElement>(null)
  const savedScroll = useRef(0)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (expanded) { wasOpen.current = true; return }
    if (!wasOpen.current) return
    wasOpen.current = false
    expandRef.current?.focus({ preventScroll: true })
    window.scrollTo(0, savedScroll.current)
  }, [expanded])
  const plot = (tall: boolean) => (
    <CountPlot title={title} unit={unit} grain={grain} timeZone={timeZone} buckets={buckets} tall={tall} onOpen={onOpen} />
  )
  return (
    <section className="wa-count-chart">
      <div className="wa-chart-head">
        <div>
          <h2>{title}</h2>
          <p className="wa-note">{grain} · {unit} · {timeZone.replace(/_/g, ' ')}</p>
        </div>
        <button ref={expandRef} className="wa-btn" type="button" onClick={() => { savedScroll.current = window.scrollY; setExpanded(true) }}><Maximize2 size={14} aria-hidden="true" /> Expand chart</button>
      </div>
      {showRegions && <ChartLegend />}
      {plot(false)}
      {notice && <p className="wa-note">{notice}</p>}
      <details className="wa-disclosure">
        <summary>Values</summary>
        <CountTable buckets={buckets} unit={unit} timeZone={timeZone} onOpen={onOpen} />
      </details>
      {expanded && (
        <ChartDialog title={title} context={`${grain} · ${unit} · ${timeZone.replace(/_/g, ' ')}`} onClose={() => setExpanded(false)}>
          {showRegions && <ChartLegend />}
          {plot(true)}
          <CountTable buckets={buckets} unit={unit} timeZone={timeZone} onOpen={onOpen} />
        </ChartDialog>
      )}
    </section>
  )
}

function ChartLegend() {
  return (
    <div className="wa-legend" aria-hidden="false">
      <span><i className="wa-swatch" style={{ background: FILL.before }} /> Before</span>
      <span><i className="wa-swatch" style={{ background: FILL.during }} /> Selected period</span>
      <span><i className="wa-swatch" style={{ background: FILL.after }} /> After</span>
    </div>
  )
}

function CountPlot({
  title,
  unit,
  grain,
  timeZone,
  buckets,
  tall,
  onOpen,
}: {
  title: string
  unit: string
  grain: string
  timeZone: string
  buckets: CountBucket[]
  tall: boolean
  onOpen?: (bucket: CountBucket) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [plotHeight, setPlotHeight] = useState(tall ? 480 : 280)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const node = host.current
    if (!node) return
    const measure = () => {
      setWidth(Math.max(280, Math.floor(node.clientWidth)))
      if (tall) setPlotHeight(Math.max(280, Math.floor(node.clientHeight)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const height = tall ? plotHeight : 280
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.count))
  const scaleMax = peak === 0 ? 1 : Math.ceil(peak * 1.15)
  const ticks = visibleTickIndexes(buckets.length, width - 56).filter((index, position, all) => position === 0 || shortDate(buckets[index].label) !== shortDate(buckets[all[position - 1]].label))
  const plotLeft = 44
  const plotRight = width - 12
  const plotTop = 16
  const plotBottom = height - 28
  const slot = buckets.length ? (plotRight - plotLeft) / buckets.length : 0
  const y = (value: number) => plotBottom - (value / scaleMax) * (plotBottom - plotTop)
  const selected = hover != null ? buckets[hover] : null
  const inspect = (index: number) => setHover(index)
  return (
    <div ref={host} className="wa-count-host">
      <svg className={tall ? 'wa-chart wa-chart-tall' : 'wa-chart'} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0} aria-label={`${title}, ${grain}, ${buckets.length} buckets, peak ${peak} ${unit}. Arrow keys inspect a bucket.`} onKeyDown={(event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); setHover((index) => Math.min(buckets.length - 1, (index ?? -1) + 1)) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); setHover((index) => Math.max(0, (index ?? 1) - 1)) }
        if (event.key === 'Enter' && hover != null && onOpen) onOpen(buckets[hover])
        if (event.key === 'Escape') setHover(null)
      }}>
        {[0, 0.5, 1].map((step) => {
          const value = Math.round(scaleMax * (1 - step))
          return (
            <g key={step}>
              <line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)} stroke="#2e2e2e" />
              <text x="4" y={y(value) + 4} fill="#8d8d8d" fontSize="11">{value}</text>
            </g>
          )
        })}
        {buckets.map((bucket, index) => {
          const barWidth = Math.max(2, slot - 4)
          const x = plotLeft + index * slot + 2
          const barHeight = bucket.count === 0 ? 0 : Math.max(1, y(0) - y(bucket.count))
          return (
            <g key={bucket.id}>
              <rect x={x} y={y(bucket.count)} width={barWidth} height={barHeight} rx="2" fill={FILL[bucket.region]} onPointerEnter={() => inspect(index)} onPointerLeave={() => setHover(null)} onClick={() => onOpen?.(bucket)} />
              {ticks.includes(index) && <text x={x + barWidth / 2} y={height - 8} fill="#bdbdbd" fontSize="12" textAnchor="middle">{shortDate(bucket.label)}</text>}
            </g>
          )
        })}
      </svg>
      {selected && (
        <div className="wa-tip" role="status">{bucketInterval(selected.label)} · {timeZone.replace(/_/g, ' ')} · {selected.count} {unit} · {selected.region === 'during' ? 'Selected period' : selected.region}{selected.partial ? ' · partial bucket' : ''}</div>
      )}
    </div>
  )
}

export function ChartDialog({ title, context, onClose, children }: { title: string; context: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const scrollRef = useRef(0)
  useEffect(() => {
    const overflow = document.body.style.overflow
    const root = document.querySelector('.wa')
    scrollRef.current = window.scrollY
    document.body.style.overflow = 'hidden'
    root?.setAttribute('inert', '')
    closeRef.current?.focus()
    const finish = () => {
      root?.removeAttribute('inert')
      document.body.style.overflow = overflow
      onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); return }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>('button, a, summary, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.hasAttribute('disabled'))
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.addEventListener('click', finish)
    return () => {
      root?.removeAttribute('inert')
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey)
      closeRef.current?.removeEventListener('click', finish)
    }
  }, [])
  return createPortal(
    <div className="wa-chart-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div ref={panelRef} className="wa-chart-dialog-panel">
        <div className="wa-overlay-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="wa-note">{context}</p>
          </div>
          <button ref={closeRef} className="wa-icon-btn" type="button" aria-label="Close chart"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function CountTable({ buckets, unit, timeZone, onOpen }: { buckets: CountBucket[]; unit: string; timeZone: string; onOpen?: (bucket: CountBucket) => void }) {
  return (
    <div className="wa-table-wrap">
      <table className="wa-table">
        <caption className="wa-sr">{unit} by {timeZone}</caption>
        <thead><tr><th>Bucket</th><th>Window</th><th className="wa-num">{unit}</th></tr></thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.id} onClick={() => onOpen?.(bucket)}>
              <td>{bucket.label}</td>
              <td>{bucket.region === 'during' ? 'Selected period' : bucket.region}{bucket.partial ? ' · partial' : ''}</td>
              <td className="wa-num">{bucket.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

