import { describe, expect, it } from 'vitest'
import { comparisonWindow, resolveRange } from './range'

describe('range resolution', () => {
  const now = new Date('2026-10-12T03:00:00.000Z')
  const timeZone = 'Asia/Ho_Chi_Minh'

  it('resolves Last month to the complete September calendar period', () => {
    const range = resolveRange('last-month', timeZone, now, {})
    expect(range.label).toBe('September 2026')
    expect(range.partial).toBe(false)
    expect(range.start.toISOString()).toBe('2026-08-31T17:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-09-30T17:00:00.000Z')
  })

  it('keeps This month partial through the fixed clock', () => {
    const range = resolveRange('month', timeZone, now, {})
    expect(range.label).toBe('October 2026')
    expect(range.partial).toBe(true)
    expect(range.end).toEqual(now)
  })

  it('applies a selected month instead of the current month', () => {
    const range = resolveRange('month-pick', timeZone, now, { month: '2026-09' })
    expect(range.label).toBe('September 2026')
    expect(range.start.toISOString()).toBe('2026-08-31T17:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-09-30T17:00:00.000Z')
  })
})

describe('comparison boundaries', () => {
  const now = new Date('2026-10-12T03:00:00.000Z')
  const timeZone = 'Asia/Ho_Chi_Minh'
  const applied = resolveRange('7d', timeZone, now, {})

  it('drops the comparison window when comparison is off', () => {
    expect(comparisonWindow('none', applied, timeZone)).toBeNull()
  })

  it('places the previous window immediately before the selected window', () => {
    const compared = comparisonWindow('previous', applied, timeZone)
    expect(compared?.end).toEqual(applied.start)
    expect(compared!.end.getTime() - compared!.start.getTime()).toBe(applied.end.getTime() - applied.start.getTime())
  })

  it('shifts a week comparison by seven days without changing duration', () => {
    const compared = comparisonWindow('week', applied, timeZone)
    expect(compared!.start.getTime()).toBe(applied.start.getTime() - 7 * 86400_000)
    expect(compared!.end.getTime()).toBe(applied.end.getTime() - 7 * 86400_000)
  })
})
