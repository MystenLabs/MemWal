import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateRangeControl } from './DateRangeControl'

test('Cancel closes the day picker without committing', async () => {
  const user = userEvent.setup()
  const onCommit = vi.fn()
  render(
    <DateRangeControl
      range="7d"
      label="Last 7 days"
      compare="previous"
      compareLabel="Previous equivalent period"
      selected={{}}
      onCommit={onCommit}
      onCompare={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: /Last 7 days/ }))
  await user.click(screen.getByRole('option', { name: 'Selected day' }))
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCommit).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: 'Date range' })).not.toBeInTheDocument()
})

test('Apply commits the selected month and closes the menu', async () => {
  const user = userEvent.setup()
  const onCommit = vi.fn()
  render(
    <DateRangeControl
      range="7d"
      label="Last 7 days"
      compare="none"
      compareLabel="No comparison"
      selected={{ month: '2026-09' }}
      onCommit={onCommit}
      onCompare={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: /Last 7 days/ }))
  await user.click(screen.getByRole('option', { name: 'Selected month' }))
  await user.click(screen.getByRole('button', { name: 'Sep' }))
  await user.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onCommit).toHaveBeenCalledWith({ range: 'month-pick', month: expect.stringMatching(/-09$/) })
  expect(screen.queryByRole('dialog', { name: 'Date range' })).not.toBeInTheDocument()
})
