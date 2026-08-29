import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version?: unknown }

if (typeof manifest.version !== 'string' || !manifest.version) {
  throw new Error('The AI sidecar package version is missing.')
}

export const APP_VERSION = manifest.version
