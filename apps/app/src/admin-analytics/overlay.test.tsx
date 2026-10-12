import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { nearestBucket } from './AdminAnalyticsApp'
import { Drawer } from './Drawer'
import { collectionStatus, measurementMethod, sampleStamp, sourceSummary } from './QualityPage'
import type { QualitySource } from '../utils/admin-api'

const emptyRetrieval: QualitySource = {
  id: 'retrieval_requests',
  name: 'Retrieval request records',
  capability: 'implemented',
  health: 'collection_path_unverified',
  coverage: 'historical_unavailable',
  classification: 'measured',
  population: 'logical retrieval requests recorded after collection began',
  observed: 0,
  expected: null,
  coveragePercent: null,
  since: null,
  lastSuccess: null,
  limitation: 'Collection is implemented and the table was read. No retrieval has been recorded yet.',
  detail: 'retrieval_requests',
  view: 'retrieval',
}

test('an empty implemented source is not described as healthy or as None', () => {
  expect(measurementMethod(emptyRetrieval)).toBe('Direct measurement')
  expect(collectionStatus(emptyRetrieval)).toBe('No samples recorded')
  expect(sourceSummary(emptyRetrieval)).toBe('Storage is available. Collection has not yet been verified by a sample.')
  expect(sampleStamp(null, emptyRetrieval)).toBe('Not yet observed')
  expect(collectionStatus(emptyRetrieval)).not.toMatch(/healthy|none/i)
})

test('a drawer puts the title and close action in one header and restores focus', async () => {
  const user = userEvent.setup()
  const onClose = vi.fn()
  render(
    <>
      <button type="button">Open</button>
      <Drawer title="Retrieval request records" onClose={onClose}>
        <p>Population</p>
      </Drawer>
    </>,
  )
  const close = screen.getByRole('button', { name: 'Close Retrieval request records' })
  const title = screen.getByRole('heading', { name: 'Retrieval request records' })
  expect(title.parentElement).toBe(close.parentElement)
  expect(close).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})

test('a tap on the right half selects the last bucket', () => {
  expect(nearestBucket(90, 0, 100, 5)).toBe(4)
  expect(nearestBucket(0, 0, 100, 5)).toBe(0)
  expect(nearestBucket(50, 0, 0, 5)).toBe(0)
})

test('tabbing from the last drawer control returns to Close', async () => {
  const user = userEvent.setup()
  render(
    <Drawer title="A very long retrieval request record title that must wrap beside Close" onClose={() => {}}>
      <button type="button">Open related page</button>
    </Drawer>,
  )
  const close = screen.getByRole('button', { name: /Close A very long/ })
  const action = screen.getByRole('button', { name: 'Open related page' })
  expect(close.parentElement).toBe(screen.getByRole('heading', { name: /A very long/ }).parentElement)
  action.focus()
  await user.tab()
  expect(close).toHaveFocus()
})
