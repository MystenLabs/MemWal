import { describe, expect, it } from 'vitest'
import { resolveRange } from './range'

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
