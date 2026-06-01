import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(appDir, 'dist')
const distAssetsDir = path.join(distDir, 'assets')
const referencePattern = /["'(`]\s*(\/[^"'`)\s]+\.(?:css|gif|ico|jpe?g|js|png|svg|ttf|wasm|webmanifest|webp|woff2?))(?:[?#][^"'`)\s]*)?/g

async function collectTextFiles() {
  const files = [path.join(distDir, 'index.html')]

  try {
    const assetEntries = await readdir(distAssetsDir, { withFileTypes: true })
    for (const entry of assetEntries) {
      if (!entry.isFile()) {
        continue
      }

      if (/\.(css|js)$/.test(entry.name)) {
        files.push(path.join(distAssetsDir, entry.name))
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  return files
}

function resolveReference(assetPath) {
  return path.join(distDir, assetPath.replace(/^\/+/, ''))
}

const references = new Set()

for (const file of await collectTextFiles()) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(referencePattern)) {
    references.add(match[1])
  }
}

const missing = []
for (const reference of references) {
  const resolvedPath = resolveReference(reference)
  try {
    const assetStat = await stat(resolvedPath)
    if (!assetStat.isFile()) {
      missing.push(reference)
    }
  } catch {
    missing.push(reference)
  }
}

if (missing.length > 0) {
  console.error('[verify-dist-assets] missing asset references:')
  for (const reference of missing) {
    console.error(`  - ${reference}`)
  }
  process.exit(1)
}

console.log(`[verify-dist-assets] verified ${references.size} static asset references`)
