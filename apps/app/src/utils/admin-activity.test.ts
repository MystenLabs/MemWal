import { spendPace } from './admin-api'

test('spend pace ignores a top-up and only compares outflow', () => {
  expect(spendPace(true, 80n, 10n)).toBe('faster')
  expect(spendPace(true, 4n, 10n)).toBe('slower')
  expect(spendPace(true, 10n, 10n)).toBe('same')
  expect(spendPace(false, 80n, 10n)).toBe('unknown')
})
