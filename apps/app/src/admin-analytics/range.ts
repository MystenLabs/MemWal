import { calendarDayWindow, formatYmd, zonedLocalToUtc } from './metrics'

export const RANGE_PRESETS = [
  { group: 'Days', id: 'today', label: 'Today' },
  { group: 'Days', id: 'yesterday', label: 'Yesterday' },
  { group: 'Days', id: '24h', label: 'Last 24 hours' },
  { group: 'Days', id: '3d', label: 'Last 3 days' },
  { group: 'Days', id: '7d', label: 'Last 7 days' },
  { group: 'Days', id: '14d', label: 'Last 14 days' },
  { group: 'Days', id: '30d', label: 'Last 30 days' },
  { group: 'Calendar', id: 'week', label: 'This week' },
  { group: 'Calendar', id: 'last-week', label: 'Last week' },
  { group: 'Calendar', id: 'month', label: 'This month' },
  { group: 'Calendar', id: 'last-month', label: 'Last month' },
  { group: 'Calendar', id: 'quarter', label: 'This quarter' },
  { group: 'Calendar', id: 'last-quarter', label: 'Last quarter' },
  { group: 'Calendar', id: 'year', label: 'This year' },
  { group: 'Calendar', id: 'last-year', label: 'Last year' },
  { group: 'Rolling', id: '90d', label: 'Last 90 days' },
  { group: 'Rolling', id: '6m', label: 'Last 6 months' },
  { group: 'Rolling', id: '12m', label: 'Last 12 months' },
  { group: 'Custom', id: 'day', label: 'Selected day' },
  { group: 'Custom', id: 'month-pick', label: 'Selected month' },
  { group: 'Custom', id: 'year-pick', label: 'Selected year' },
  { group: 'Custom', id: 'custom', label: 'Custom range' },
] as const

export type RangeId = (typeof RANGE_PRESETS)[number]['id']
export type CompareId = 'none' | 'previous' | 'week' | 'month' | 'year'

export interface AppliedRange {
  preset: RangeId
  start: Date
  end: Date
  label: string
  partial: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isRangeId(value: string | null): value is RangeId {
  return RANGE_PRESETS.some((item) => item.id === value)
}

function parts(timeZone: string, instant: Date) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant)
  const get = (type: string) => formatted.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  }
}

function addDays(year: number, month: number, day: number, days: number) {
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function clampDay(year: number, month: number, day: number) {
  return Math.min(day, lastDay(year, month))
}

function localMidnight(year: number, month: number, day: number, timeZone: string) {
  return zonedLocalToUtc(year, month, day, 0, 0, 0, timeZone)
}

function rolling(now: Date, ms: number, label: string, preset: RangeId): AppliedRange {
  return { preset, start: new Date(now.getTime() - ms), end: now, label, partial: true }
}

export function formatDay(instant: Date, timeZone: string): string {
  const local = parts(timeZone, instant)
  return `${local.day} ${MONTHS[local.month - 1]} ${local.year}`
}

export function formatSpan(start: Date, end: Date, timeZone: string): string {
  const left = parts(timeZone, start)
  const right = parts(timeZone, new Date(end.getTime() - 1))
  if (left.year === right.year && left.month === right.month && left.day === right.day) {
    return formatDay(start, timeZone)
  }
  if (left.year === right.year && left.month === right.month) {
    return `${left.day}–${right.day} ${MONTHS[left.month - 1]} ${left.year}`
  }
  return `${formatDay(start, timeZone)} – ${formatDay(new Date(end.getTime() - 1), timeZone)}`
}

export function resolveRange(
  preset: RangeId,
  timeZone: string,
  now: Date,
  selected: { day?: string; month?: string; year?: string; from?: string; to?: string },
): AppliedRange {
  const local = parts(timeZone, now)
  const today = calendarDayWindow(formatYmd(now, timeZone), timeZone)
  if (preset === 'today') {
    return { preset, start: today.start, end: now, label: `Today, ${formatDay(now, timeZone)}`, partial: true }
  }
  if (preset === 'yesterday') {
    const ymd = formatYmd(new Date(now.getTime() - 24 * 3600_000), timeZone)
    const bounds = calendarDayWindow(ymd, timeZone)
    return { preset, start: bounds.start, end: bounds.end, label: `Yesterday, ${formatDay(bounds.start, timeZone)}`, partial: false }
  }
  if (preset === '24h') return rolling(now, 24 * 3600_000, 'Last 24 hours', preset)
  if (preset === '3d' || preset === '7d' || preset === '14d' || preset === '30d' || preset === '90d') {
    const days = Number(preset.replace('d', ''))
    return rolling(now, days * 24 * 3600_000, `Last ${days} days`, preset)
  }
  if (preset === 'week' || preset === 'last-week') {
    const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(local.weekday)
    const monday = addDays(local.year, local.month, local.day, -Math.max(0, index))
    const start = localMidnight(monday.year, monday.month, monday.day, timeZone)
    if (preset === 'week') {
      return { preset, start, end: now, label: 'This week', partial: true }
    }
    const previous = addDays(monday.year, monday.month, monday.day, -7)
    const previousEnd = addDays(monday.year, monday.month, monday.day, 0)
    return {
      preset,
      start: localMidnight(previous.year, previous.month, previous.day, timeZone),
      end: localMidnight(previousEnd.year, previousEnd.month, previousEnd.day, timeZone),
      label: 'Last week',
      partial: false,
    }
  }
  if (preset === 'month' || preset === 'last-month' || preset === 'month-pick') {
    const picked = preset === 'month-pick' && selected.month ? selected.month.split('-').map(Number) : [local.year, local.month]
    const year = picked[0]
    const month = picked[1]
    const start = localMidnight(year, month, 1, timeZone)
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
    const end = localMidnight(next.year, next.month, 1, timeZone)
    const current = preset === 'month' || (preset === 'month-pick' && year === local.year && month === local.month)
    return {
      preset,
      start,
      end: current && end > now ? now : end,
      label: `${MONTHS[month - 1]} ${year}`,
      partial: current && end > now,
    }
  }
  if (preset === 'quarter' || preset === 'last-quarter') {
    const quarter = Math.floor((local.month - 1) / 3)
    const shift = preset === 'last-quarter' ? quarter - 1 : quarter
    const year = local.year + Math.floor(shift / 4)
    const month = ((shift % 4) + 4) % 4 * 3 + 1
    const start = localMidnight(year, month, 1, timeZone)
    const endMonth = month + 3
    const end = localMidnight(endMonth > 12 ? year + 1 : year, endMonth > 12 ? endMonth - 12 : endMonth, 1, timeZone)
    return {
      preset,
      start,
      end: preset === 'quarter' && end > now ? now : end,
      label: preset === 'quarter' ? 'This quarter' : 'Last quarter',
      partial: preset === 'quarter',
    }
  }
  if (preset === 'year' || preset === 'last-year' || preset === 'year-pick') {
    const year = preset === 'year-pick' && selected.year ? Number(selected.year) : preset === 'last-year' ? local.year - 1 : local.year
    const start = localMidnight(year, 1, 1, timeZone)
    const end = localMidnight(year + 1, 1, 1, timeZone)
    const current = year === local.year
    return { preset, start, end: current && end > now ? now : end, label: String(year), partial: current && end > now }
  }
  if (preset === '6m' || preset === '12m') {
    const months = preset === '6m' ? 6 : 12
    const shifted = local.month - months
    const year = local.year + Math.floor((shifted - 1) / 12)
    const month = ((shifted - 1) % 12 + 12) % 12 + 1
    const day = clampDay(year, month, local.day)
    return {
      preset,
      start: zonedLocalToUtc(year, month, day, local.day === day ? partsHour(now, timeZone) : 0, 0, 0, timeZone),
      end: now,
      label: preset === '6m' ? 'Last 6 months' : 'Last 12 months',
      partial: true,
    }
  }
  if (preset === 'day') {
    const ymd = selected.day || formatYmd(now, timeZone)
    const bounds = calendarDayWindow(ymd, timeZone)
    const end = bounds.end > now && ymd === formatYmd(now, timeZone) ? now : bounds.end
    return { preset, start: bounds.start, end, label: formatDay(bounds.start, timeZone), partial: end < bounds.end }
  }
  const from = selected.from ? new Date(selected.from) : today.start
  const to = selected.to ? new Date(selected.to) : now
  return { preset: 'custom', start: from, end: to > now ? now : to, label: formatSpan(from, to > now ? now : to, timeZone), partial: to > now }
}

function partsHour(instant: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).formatToParts(instant)
  const hour = formatted.find((part) => part.type === 'hour')?.value ?? '0'
  return hour === '24' ? 0 : Number(hour)
}

export function comparisonWindow(compare: CompareId, applied: AppliedRange, timeZone: string): { start: Date; end: Date; label: string } | null {
  if (compare === 'none') return null
  const duration = applied.end.getTime() - applied.start.getTime()
  if (compare === 'previous') {
    const start = new Date(applied.start.getTime() - duration)
    return { start, end: applied.start, label: 'Previous equivalent period' }
  }
  if (compare === 'week') {
    return { start: new Date(applied.start.getTime() - 7 * 86400_000), end: new Date(applied.end.getTime() - 7 * 86400_000), label: 'Same period last week' }
  }
  const local = parts(timeZone, applied.start)
  if (compare === 'year') {
    const day = clampDay(local.year - 1, local.month, local.day)
    const start = zonedLocalToUtc(local.year - 1, local.month, day, 0, 0, 0, timeZone)
    return { start, end: new Date(start.getTime() + duration), label: 'Same period last year' }
  }
  const month = local.month === 1 ? 12 : local.month - 1
  const year = local.month === 1 ? local.year - 1 : local.year
  const day = clampDay(year, month, local.day)
  const start = zonedLocalToUtc(year, month, day, 0, 0, 0, timeZone)
  return { start, end: new Date(start.getTime() + duration), label: 'Same period last month' }
}
