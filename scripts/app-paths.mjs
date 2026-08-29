import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const appBundleName = "Duc's Table.app"
export const appBundle = path.resolve(
  projectRoot,
  process.env.DUCS_APP_BUNDLE || path.join('build', 'bin', appBundleName),
)
