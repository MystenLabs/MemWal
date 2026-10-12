import { describe, expect, it } from 'vitest'
import { baselineChange, investigationWindows } from './range'

describe('investigation windows', () => {
  const during = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-08T00:00:00Z') }

  it('uses an equal duration immediately before a closed window', () => {
    const windows = investigationWindows(during, new Date('2026-10-20T00:00:00Z'))
    expect(windows.before.start.toISOString()).toBe('2026-09-24T00:00:00.000Z')
    expect(windows.before.end).toEqual(during.start)
    expect(windows.after?.start).toEqual(during.end)
    expect(windows.after?.end.toISOString()).toBe('2026-10-15T00:00:00.000Z')
    expect(windows.after?.partial).toBe(false)
    expect(windows.ongoing).toBe(false)
  })

  it('does not invent an after window for an open investigation', () => {
    const windows = investigationWindows(during, new Date('2026-10-08T00:00:00Z'))
    expect(windows.after).toBeNull()
    expect(windows.ongoing).toBe(true)
  })

  it('does not invent an after window from a few milliseconds of clock skew', () => {
    const end = new Date('2026-10-12T08:53:22.608Z')
    const windows = investigationWindows(
      { start: new Date('2026-10-11T17:00:00.000Z'), end },
      new Date('2026-10-12T08:53:22.611Z'),
    )
    expect(windows.after).toBeNull()
    expect(windows.ongoing).toBe(true)
  })


  it('marks a short after window as partial', () => {
    const windows = investigationWindows(during, new Date('2026-10-10T00:00:00Z'))
    expect(windows.after?.partial).toBe(true)
    expect(windows.after?.end.toISOString()).toBe('2026-10-10T00:00:00.000Z')
  })

  it('does not invent a percentage from a zero baseline', () => {
    expect(baselineChange(4, 0)).toBe('No baseline')
    expect(baselineChange(0, 0)).toBe('No baseline')
    expect(baselineChange(15, 10)).toBe('+50%')
  })
})
