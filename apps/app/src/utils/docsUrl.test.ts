import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    config: { docsUrl: '' },
}))

vi.mock('../config', () => ({ config: mocks.config }))

import { docsUrl } from './docsUrl'

describe('docsUrl', () => {
    beforeEach(() => {
        mocks.config.docsUrl = ''
    })

    it('falls back to the published Walrus Memory docs root', () => {
        expect(docsUrl('/guides/system-prompt-templates')).toBe(
            'https://docs.wal.app/walrus-memory/guides/system-prompt-templates',
        )
    })

    it('joins a configured root without duplicating boundary slashes', () => {
        mocks.config.docsUrl = 'https://docs.example/walrus-memory///'

        expect(docsUrl('///guides/system-prompt-templates')).toBe(
            'https://docs.example/walrus-memory/guides/system-prompt-templates',
        )
    })
})
