import { describe, expect, it } from 'vitest'
import { shortDate, visibleTickIndexes } from './chartTicks'

describe('visibleTickIndexes', () => {
  it('keeps every label when the chart is wide enough', () => {
    expect(visibleTickIndexes(4, 400)).toEqual([0, 1, 2, 3])
  })

  it('keeps the first and last tick when labels would collide', () => {
    const ticks = visibleTickIndexes(30, 320)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBe(29)
    expect(ticks.length).toBeLessThan(8)
  })

  it('does not depend on how many points are plotted', () => {
    expect(visibleTickIndexes(30, 320).length).toBeLessThan(30)
  })
})

describe('shortDate', () => {
  it('formats a day bucket without the year', () => {
    expect(shortDate('2026-10-05')).toBe('5 Oct')
  })
})
