import { constants } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultBundle = path.join(root, 'build', 'bin', 'ducs-table.app', 'Contents', 'Resources', 'ai-sidecar')
const bundle = path.resolve(process.argv[2] || process.env.DUCS_AI_BUNDLE || defaultBundle)
const node = path.join(bundle, 'node')
const entrypoint = path.join(bundle, 'dist', 'index.js')
const launcher = path.join(bundle, 'launch-ai-sidecar')
const bundledNotices = [
  path.join(bundle, 'DUCS_TABLE_LICENSE'),
  path.join(bundle, 'DUCS_TABLE_NOTICE'),
  path.join(bundle, 'THIRD_PARTY_NOTICES.md'),
  path.join(bundle, 'NODE_LICENSE'),
]

async function requireFile(candidate, executable = false) {
  await access(candidate, executable && process.platform !== 'win32' ? constants.X_OK : constants.F_OK)
  if (!(await stat(candidate)).isFile()) throw new Error(`${candidate} is not a file.`)
}

function platformPackage(prefix) {
  const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'])
  const target = `${process.platform}-${process.arch}`
  if (!supported.has(target)) throw new Error(`Unsupported sidecar platform: ${process.platform}/${process.arch}.`)
  return `${prefix}-${target}`
}

async function containsExecutable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory() && await containsExecutable(candidate)) return true
    if (entry.isFile()) {
      if (process.platform === 'win32' ? entry.name.endsWith('.exe') : ((await stat(candidate)).mode & 0o111) !== 0) return true
    }
  }
  return false
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function smoke(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, [], {
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir(), DUCS_AI_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('AI sidecar smoke test timed out.'))
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`AI sidecar exited with ${code}: ${stderr}`))
      try {
        const responses = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        const ping = responses.find((response) => response.id === 'verify:ping')
        const shutdown = responses.find((response) => response.id === 'verify:shutdown')
        if (ping?.result?.ok !== true || shutdown?.result?.ok !== true) throw new Error(`Unexpected smoke responses: ${stdout}`)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end([
      JSON.stringify({ id: 'verify:ping', method: 'ping', params: {} }),
      JSON.stringify({ id: 'verify:shutdown', method: 'shutdown', params: {} }),
      '',
    ].join('\n'))
  })
}

await Promise.all([
  requireFile(node, true),
  requireFile(entrypoint),
  requireFile(launcher, true),
  ...bundledNotices.map((notice) => requireFile(notice)),
])

const manifest = JSON.parse(await readFile(path.join(bundle, 'package.json'), 'utf8'))
for (const dependency of ['@openai/codex', '@anthropic-ai/claude-agent-sdk']) {
  if (!manifest.dependencies?.[dependency]) throw new Error(`Bundle manifest is missing ${dependency}.`)
  await access(path.join(bundle, 'node_modules', ...dependency.split('/')), constants.F_OK)
}
for (const dependency of Object.keys(manifest.devDependencies || {})) {
  const candidate = path.join(bundle, 'node_modules', ...dependency.split('/'))
  try {
    await access(candidate, constants.F_OK)
    throw new Error(`Development dependency ${dependency} was included in the production bundle.`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const nativePackages = [
  platformPackage('@openai/codex'),
  platformPackage('@anthropic-ai/claude-agent-sdk'),
]
for (const packageName of nativePackages) {
  const directory = path.join(bundle, 'node_modules', ...packageName.split('/'))
  await access(path.join(directory, 'package.json'), constants.F_OK)
  if (!await containsExecutable(directory)) throw new Error(`${packageName} does not contain an executable.`)
}

const runtime = await run(node, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'])
if (runtime.code !== 0) throw new Error(`Bundled Node failed: ${runtime.stderr}`)
const runtimeInfo = JSON.parse(runtime.stdout)
if (Number(runtimeInfo.version.split('.')[0]) < 22) throw new Error(`Bundled Node ${runtimeInfo.version} is too old.`)
if (runtimeInfo.platform !== process.platform || runtimeInfo.arch !== process.arch) {
  throw new Error(`Bundled Node targets ${runtimeInfo.platform}/${runtimeInfo.arch}, expected ${process.platform}/${process.arch}.`)
}

const smokeHome = await mkdtemp(path.join(os.tmpdir(), 'ducs-ai-verify-'))
try {
  await smoke(smokeHome)
} finally {
  await rm(smokeHome, { recursive: true, force: true })
}

console.log(`AI sidecar verified offline with Node ${runtimeInfo.version} at ${bundle}`)
