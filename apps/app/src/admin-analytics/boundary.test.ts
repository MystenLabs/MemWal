import { boundaryCopy } from './OpsPages'
import { activityBuckets, afterCell, priorText } from './OpsPages'

test('an empty deployed collector is not called unsupported or zero traffic', () => {
  const copy = boundaryCopy({
    capability: 'implemented',
    health: 'collection_path_unverified',
    observed: 0,
    limitation: 'No retrieval has been recorded yet.',
  }, 'missing')
  expect(copy.status).toBe('No samples')
  expect(copy.samples).toBe(0)
  expect(copy.why).not.toMatch(/unsupported|not stored/i)
})

test('no comparison hides the prior label', () => {
  expect(priorText(false, 9)).toBe('No comparison')
  expect(priorText(true, 9)).toBe('Prior 9')
})

test('a week uses daily buckets even when hourly rows exist', () => {
  const buckets = activityBuckets(24 * 7, [{ hour: '2026-10-12T00:00:00Z', count: 1 }], [{ day: '2026-10-12', count: 10 }])
  expect(buckets.grain).toBe('Daily')
  expect(buckets.rows[0].label).toBe('2026-10-12')
})

test('a one-minute after window is still collecting, not zero', () => {
  expect(afterCell(true, 0.02, false, 0)).toBe('Still collecting')
  expect(afterCell(false, 24, false, 0)).toBe('0')
})

test('a failed inventory does not become a zero sample count', () => {
  const copy = boundaryCopy({
    capability: 'implemented',
    health: 'failed',
    observed: null,
    limitation: 'The inventory query failed.',
  }, 'missing')
  expect(copy.status).toBe('Query failed')
  expect(copy.samples).toBeNull()
})

test('an unsupported source stays unsupported', () => {
  expect(boundaryCopy({
    capability: 'unsupported_by_source',
    health: 'unsupported_by_source',
    observed: null,
    limitation: 'Node telemetry is not correlated.',
  }, 'missing').status).toBe('Unsupported')
})
