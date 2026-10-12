import { boundaryCopy } from './OpsPages'

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
