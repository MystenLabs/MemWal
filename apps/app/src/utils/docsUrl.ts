import { config } from '../config'

const DEFAULT_DOCS_ROOT = 'https://docs.wal.app/walrus-memory'

/** Build a stable link into the published Walrus Memory documentation. */
export function docsUrl(path: string): string {
    const root = (config.docsUrl || DEFAULT_DOCS_ROOT).replace(/\/+$/, '')
    return `${root}/${path.replace(/^\/+/, '')}`
}
