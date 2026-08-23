import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

interface Target {
  packageName: string
  triple: string
  executable: string
}

const TARGETS: Record<string, Target> = {
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' },
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' },
}

const require = createRequire(import.meta.url)

export async function resolveCodexBinary(override = process.env.DUCS_CODEX_BINARY): Promise<string> {
  if (override) {
    await access(override, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return override
  }
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) throw new Error(`Unsupported Codex platform: ${process.platform}/${process.arch}.`)
  const manifest = require.resolve(`${target.packageName}/package.json`)
  const executable = path.join(path.dirname(manifest), 'vendor', target.triple, 'bin', target.executable)
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  return executable
}
