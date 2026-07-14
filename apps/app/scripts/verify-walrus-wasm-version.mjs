import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function packageJsonFor(name, resolver = require) {
	let directory = dirname(resolver.resolve(name))
	for (;;) {
		try {
			const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
			if (packageJson.name === name) return packageJson
		} catch {}
		const parent = dirname(directory)
		if (parent === directory) throw new Error(`could not locate package.json for ${name}`)
		directory = parent
	}
}

const app = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const walrus = packageJsonFor('@mysten/walrus')
const appWasm = packageJsonFor('@mysten/walrus-wasm')
const walrusRequire = createRequire(require.resolve('@mysten/walrus'))
const walrusWasm = packageJsonFor('@mysten/walrus-wasm', walrusRequire)
const directPin = app.dependencies['@mysten/walrus-wasm']

if (directPin !== appWasm.version || appWasm.version !== walrusWasm.version) {
	throw new Error(
		`Walrus WASM ABI mismatch: app pins ${directPin} and resolves ${appWasm.version}, ` +
			`but @mysten/walrus@${walrus.version} resolves ${walrusWasm.version}. Update both dependencies in lockstep.`,
	)
}

console.log(`verified @mysten/walrus@${walrus.version} with @mysten/walrus-wasm@${appWasm.version}`)
