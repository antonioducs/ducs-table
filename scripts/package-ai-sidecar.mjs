import { constants } from 'node:fs'
import { access, cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stage = path.resolve(root, process.env.DUCS_AI_STAGE_DIR || path.join('node_modules', '.cache', 'ducs-table', 'ai-sidecar-stage'))
const app = path.resolve(root, process.env.DUCS_APP_BUNDLE || path.join('build', 'bin', 'ducs-table.app'))
const resources = path.join(app, 'Contents', 'Resources')
const destination = path.join(resources, 'ai-sidecar')

for (const candidate of [path.join(stage, 'node'), path.join(stage, 'dist', 'index.js')]) {
  try {
    await access(candidate, constants.F_OK)
  } catch {
    throw new Error(`Staged sidecar is incomplete (${candidate}). Run npm run ai:build first.`)
  }
}
try {
  await access(resources, constants.F_OK)
} catch {
  throw new Error(`Wails app resources were not found at ${resources}. Build the app before packaging the sidecar.`)
}

await rm(destination, { recursive: true, force: true })
await mkdir(resources, { recursive: true })
await cp(stage, destination, { recursive: true, verbatimSymlinks: true })

console.log(`AI sidecar copied to ${destination}`)
