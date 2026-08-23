import { constants } from 'node:fs'
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'ai-sidecar')
const stage = path.resolve(root, process.env.DUCS_AI_STAGE_DIR || path.join('node_modules', '.cache', 'ducs-table', 'ai-sidecar-stage'))

async function requirePath(candidate, hint) {
  try {
    await access(candidate, constants.F_OK)
  } catch {
    throw new Error(`${candidate} is missing. ${hint}`)
  }
}

await requirePath(path.join(source, 'dist', 'index.js'), 'Run npm run ai:build after installing the sidecar dependencies.')
await requirePath(path.join(source, 'node_modules'), 'Run npm run ai:install first.')

const nodeVersion = Number(process.versions.node.split('.')[0])
if (nodeVersion < 22) throw new Error(`Node 22 or newer is required; staging is running on ${process.version}.`)

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

await Promise.all([
  cp(path.join(source, 'dist'), path.join(stage, 'dist'), { recursive: true, verbatimSymlinks: true }),
  cp(path.join(source, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true }),
  copyFile(path.join(source, 'package.json'), path.join(stage, 'package.json')),
  copyFile(path.join(source, 'package-lock.json'), path.join(stage, 'package-lock.json')),
  copyFile(process.execPath, path.join(stage, 'node')),
])

const nodeMode = (await stat(process.execPath)).mode & 0o777
await chmod(path.join(stage, 'node'), nodeMode)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const prune = spawnSync(npm, ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: stage,
  encoding: 'utf8',
  stdio: 'inherit',
})
if (prune.error) throw prune.error
if (prune.status !== 0) throw new Error(`npm prune failed with exit code ${prune.status}.`)

const stagedModules = path.join(stage, 'node_modules')
await Promise.all([
  rm(path.join(stagedModules, '.vite'), { recursive: true, force: true }),
  rm(path.join(stagedModules, '.vite-temp'), { recursive: true, force: true }),
])

async function removeEmptyDirectories(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name))
  }
  if (directory !== stagedModules && (await readdir(directory)).length === 0) await rm(directory, { recursive: true })
}
await removeEmptyDirectories(stagedModules)

const launcher = `#!/bin/sh
set -eu
sidecar_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$sidecar_dir/node" "$sidecar_dir/dist/index.js" "$@"
`
await writeFile(path.join(stage, 'launch-ai-sidecar'), launcher, { mode: 0o755 })
await chmod(path.join(stage, 'launch-ai-sidecar'), 0o755)

// npm may normalize package metadata while pruning; retain the source lockfiles
// that describe the exact dependency graph shipped in this directory.
await Promise.all([
  copyFile(path.join(source, 'package.json'), path.join(stage, 'package.json')),
  copyFile(path.join(source, 'package-lock.json'), path.join(stage, 'package-lock.json')),
])

const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'))
for (const dependency of ['@openai/codex', '@anthropic-ai/claude-agent-sdk']) {
  if (!manifest.dependencies?.[dependency]) throw new Error(`Required production dependency ${dependency} is not declared.`)
}

console.log(`AI sidecar staged for ${process.platform}/${process.arch} at ${stage}`)
