import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { docsUrl } from '../utils/docsUrl'

/**
 * Compatibility landing page for the short URL named in WALM-199.
 *
 * The canonical copy lives in the docs site. Keeping this route in the app
 * means old bookmarks and the public memory.walrus.xyz origin do not fall
 * through to the dashboard sign-in page.
 */
export default function PromptTemplatesRedirect() {
    const destination = docsUrl('guides/system-prompt-templates')

    useEffect(() => {
        window.location.replace(destination)
    }, [destination])

    return (
        <main style={{ maxWidth: 640, margin: '96px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
            <h1>System Prompt Templates</h1>
            <p>The template library is opening in the Walrus Memory documentation.</p>
            <p>
                <a href={destination}>Open the template library</a>
            </p>
            <p>
                <Link to="/">Return to Walrus Memory</Link>
            </p>
        </main>
    )
}
