import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const blockers = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(root))
    .filter((line) => /\bwails dev\b/.test(line) || line.includes('build/bin/ducs-table.app/Contents/MacOS/DucsTable'))

  if (blockers.length > 0) {
    console.error('Cannot build Duc\'s Table while the dev server or built app is running.')
    console.error('Close it first so Wails cannot remove or overwrite the production bundle:')
    for (const blocker of blockers) console.error(`  ${blocker}`)
    process.exit(1)
  }
}
