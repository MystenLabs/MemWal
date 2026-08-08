import { render, screen } from '@testing-library/react'

test('rtl renders into jsdom', () => {
    render(<div role="status">ok</div>)
    expect(screen.getByRole('status')).toHaveTextContent('ok')
})
