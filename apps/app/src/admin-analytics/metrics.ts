/** Measured value, or an explicit gap. Never coerce a gap to zero. */
export type Metric =
  | { state: 'measured'; value: bigint; coverage: number }
  | { state: 'estimated'; value: bigint; coverage: number; method: string }
  | { state: 'unavailable'; reason: string }

export interface PercentileSet {
  p50: bigint | null
  p90: bigint | null
  p99: bigint | null
  samples: number
  /** p99 from fewer than 20 samples is flagged, not hidden. */
  tailUnstable: boolean
}

const UNSTABLE_TAIL_SAMPLES = 20

export function percentile(values: bigint[], p: number): bigint | null {
  if (values.length === 0) return null
  if (p <= 0 || p > 100) throw new Error(`percentile out of range: ${p}`)
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const index = Math.max(0, Math.min(sorted.length - 1, rank))
  return sorted[index]
}

export function percentiles(values: bigint[]): PercentileSet {
  return {
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    samples: values.length,
    tailUnstable: values.length > 0 && values.length < UNSTABLE_TAIL_SAMPLES,
  }
}

export function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n)
}

/** Weighted overhead percent: ((num / den) - 1) * 100. Unavailable if den is 0 or missing. */
export function overheadPercent(numerator: Metric, denominator: Metric): Metric {
  if (numerator.state === 'unavailable') return numerator
  if (denominator.state === 'unavailable') return denominator
  if (denominator.value === 0n) {
    return { state: 'unavailable', reason: 'Zero denominator' }
  }
  const scaled = (numerator.value * 10000n) / denominator.value
  const points = scaled - 10000n
  const coverage = Math.min(numerator.coverage, denominator.coverage)
  if (numerator.state === 'estimated' || denominator.state === 'estimated') {
    return {
      state: 'estimated',
      value: points,
      coverage,
      method: 'Weighted sums on the shared measured cohort. Not a mean of row ratios.',
    }
  }
  return { state: 'measured', value: points, coverage }
}

export function formatBytes(value: bigint): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unit = 0
  let scaled = abs
  let remainder = 0n
  while (scaled >= 1024n && unit < units.length - 1) {
    remainder = scaled % 1024n
    scaled /= 1024n
    unit += 1
  }
  const fraction = unit === 0 ? '' : `.${((remainder * 10n) / 1024n).toString()}`
  return `${negative ? '-' : ''}${scaled.toString()}${fraction} ${units[unit]}`
}

export function formatMetric(metric: Metric, kind: 'bytes' | 'points' = 'bytes'): string {
  if (metric.state === 'unavailable') return 'Unavailable'
  const text = kind === 'bytes' ? formatBytes(metric.value) : formatPoints(metric.value)
  return metric.state === 'estimated' ? `Est. ${text}` : text
}

export function formatPoints(basisPoints: bigint): string {
  const negative = basisPoints < 0n
  const abs = negative ? -basisPoints : basisPoints
  const whole = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${frac} pp`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

/** Spreadsheet formula injection guard. */
export function csvCell(value: string): string {
  let cell = value
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`
  return cell
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function tzParts(timeZone: string, instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  const hour = get('hour') === '24' ? '0' : get('hour')
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(hour),
    minute: Number(get('minute')),
    second: Number(get('second')),
  }
}

function tzOffsetMs(timeZone: string, instant: Date): number {
  const parts = tzParts(timeZone, instant)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - instant.getTime()
}

export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const corrected = guess - tzOffsetMs(timeZone, new Date(guess))
  return new Date(guess - tzOffsetMs(timeZone, new Date(corrected)))
}

export function formatYmd(instant: Date, timeZone: string): string {
  const parts = tzParts(timeZone, instant)
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')
  return `${parts.year}-${month}-${day}`
}

/** Half-open local calendar day [start, end). */
export function calendarDayWindow(ymd: string, timeZone: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!match) throw new Error(`Invalid calendar day: ${ymd}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const start = zonedLocalToUtc(year, month, day, 0, 0, 0, timeZone)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const end = zonedLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, timeZone)
  return { start, end }
}

export function inWindow(iso: string, start: Date, end: Date): boolean {
  const time = Date.parse(iso)
  return time >= start.getTime() && time < end.getTime()
}
