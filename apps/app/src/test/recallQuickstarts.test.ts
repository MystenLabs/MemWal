import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dashboardSource = readFileSync(resolve('src/pages/Dashboard.tsx'), 'utf8')
const playgroundSource = readFileSync(resolve('src/pages/Playground.tsx'), 'utf8')

test('Dashboard quickstarts use the preferred recall API', () => {
    expect(dashboardSource).toContain('memwal.recall({ query: "food allergies" })')
    expect(dashboardSource).toContain('memwal.recall(query="food allergies")')
    expect(dashboardSource).not.toContain('memwal.recall("food allergies")')
})

test('Playground calls and snippets use object-form recall', () => {
    expect(playgroundSource).toContain('memwal.recall({ query: recallQuery, limit: 5 })')
    expect(playgroundSource).toContain('memwal.recall({ query: askQuestion, limit: 5 })')
    expect(playgroundSource).toContain('memwal.recall({ query: "${recallQuery}", limit: 5 })')
    expect(playgroundSource).not.toContain('memwal.recall(recallQuery, 5)')
    expect(playgroundSource).not.toContain('memwal.recall(askQuestion, 5)')
    expect(playgroundSource).not.toContain('memwal.recall("${recallQuery}", 5)')
})
