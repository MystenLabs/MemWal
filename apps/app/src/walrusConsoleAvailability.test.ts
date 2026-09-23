import { describe, expect, it } from 'vitest'
import { isCalendarDateReached } from './config'

describe('isCalendarDateReached', () => {
    const today = new Date(2026, 8, 23)

    it('stays off when the date is missing or invalid', () => {
        expect(isCalendarDateReached('', today)).toBe(false)
        expect(isCalendarDateReached('September 23, 2026', today)).toBe(false)
        expect(isCalendarDateReached('2026-02-31', today)).toBe(false)
    })

    it('turns on on that local calendar day and stays on after', () => {
        expect(isCalendarDateReached('2026-09-24', today)).toBe(false)
        expect(isCalendarDateReached('2026-09-23', today)).toBe(true)
        expect(isCalendarDateReached('2026-09-01', today)).toBe(true)
    })
})
