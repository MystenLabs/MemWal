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

test('range and comparison triggers use the same chevron slot', () => {
  render(
    <DateRangeControl
      range="week"
      label="This week"
      compare="previous"
      compareLabel="11 Oct 2026"
      selected={{}}
      onCommit={() => {}}
      onCompare={() => {}}
    />,
  )
  const triggers = screen.getAllByRole('button').filter((button) => button.querySelector('.wa-chevron'))
  expect(triggers).toHaveLength(2)
  for (const trigger of triggers) {
    expect(trigger.className).toContain('wa-btn')
    expect(trigger.querySelector('.wa-chevron')).toHaveAttribute('aria-hidden', 'true')
  }
})

test('arrow keys move the preset and Enter commits it', async () => {
  const user = userEvent.setup()
  const onCommit = vi.fn()
  render(
    <DateRangeControl
      range="today"
      label="Today"
      compare="none"
      compareLabel="No comparison"
      selected={{}}
      onCommit={onCommit}
      onCompare={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: /Today/ }))
  await user.keyboard('{ArrowDown}{Enter}')
  expect(onCommit).toHaveBeenCalledWith({ range: 'yesterday' })
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
