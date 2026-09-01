import { constants } from 'node:fs'
import { access, open, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { appBundle as app, projectRoot } from './app-paths.mjs'

const sidecar = path.join(app, 'Contents', 'Resources', 'ai-sidecar')
const node = path.join(sidecar, 'node')
const appEntitlements = path.join(projectRoot, 'build', 'darwin', 'entitlements-app.plist')
const runtimeEntitlements = path.join(projectRoot, 'build', 'darwin', 'entitlements-ai-runtime.plist')
const identity = process.env.DUCS_CODESIGN_IDENTITY || '-'

if (process.platform !== 'darwin' || process.env.DUCS_SKIP_CODESIGN === '1') {
  console.log(`macOS code signing skipped on ${process.platform}`)
  process.exit(0)
}

await requirePath(app, 'Build the Wails app before signing it.')
await requirePath(sidecar, 'Package the AI sidecar before signing the app.')
await requirePath(appEntitlements, 'The app entitlements are required for DuckDB extensions.')

if (identity === '-') {
  runCodesign(['--force', '--deep', '--sign', '-', '--entitlements', appEntitlements, app])
  verifyLibraryValidationEntitlement(app)
  console.log(`Development bundle signed ad hoc at ${app}`)
  process.exit(0)
}

if (!identity.startsWith('Developer ID Application: ')) {
  throw new Error('DUCS_CODESIGN_IDENTITY must be a full "Developer ID Application: Name (TEAMID)" identity.')
}

await requirePath(runtimeEntitlements, 'The release runtime entitlements are required for bundled Node.')

const nestedBinaries = (await findMachOBinaries(sidecar)).sort((left, right) => pathDepth(right) - pathDepth(left))
if (!nestedBinaries.includes(node)) throw new Error(`Bundled Node was not found among the Mach-O files in ${sidecar}.`)

for (const binary of nestedBinaries) {
  if (binary === node) {
    sign(binary, runtimeEntitlements)
    continue
  }

  const signature = inspectSignature(binary)
  if (signature.distributable) {
    console.log(`Preserving valid third-party Developer ID signature: ${path.relative(app, binary)}`)
    continue
  }

  if (signature.developerId) {
    throw new Error(`${binary} has a non-distributable third-party signature: ${distributionFailure(signature)}.`)
  }

  sign(binary)
}

sign(app, appEntitlements)

for (const binary of nestedBinaries) verifyDistributionSignature(binary)
verifyDistributionSignature(app, { deep: true, requireLibraryValidationDisabled: true })

console.log(`Developer ID bundle signed inside-out at ${app}`)

async function requirePath(candidate, hint) {
  try {
    await access(candidate, constants.F_OK)
  } catch {
    throw new Error(`${candidate} is missing. ${hint}`)
  }
}

async function findMachOBinaries(directory) {
  const binaries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      binaries.push(...await findMachOBinaries(candidate))
      continue
    }
    if (!entry.isFile()) continue

    const metadata = await stat(candidate)
    if ((metadata.mode & 0o111) === 0 && !/\.(?:dylib|node)$/.test(entry.name)) continue
    if (await isMachO(candidate)) binaries.push(candidate)
  }
  return binaries
}

async function isMachO(candidate) {
  const handle = await open(candidate, 'r')
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) return false
    return new Set([
      0xfeedface,
      0xcefaedfe,
      0xfeedfacf,
      0xcffaedfe,
      0xcafebabe,
      0xbebafeca,
      0xcafebabf,
      0xbfbafeca,
    ]).has(header.readUInt32BE(0))
  } finally {
    await handle.close()
  }
}

function pathDepth(candidate) {
  return candidate.split(path.sep).length
}

function sign(candidate, entitlements) {
  const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime']
  if (entitlements) args.push('--entitlements', entitlements)
  args.push(candidate)
  runCodesign(args)
}

function inspectSignature(candidate) {
  const verification = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', candidate], { encoding: 'utf8' })
  const details = spawnSync('codesign', ['-d', '--verbose=4', candidate], { encoding: 'utf8' })
  const entitlements = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', candidate], { encoding: 'utf8' })
  for (const result of [verification, details, entitlements]) {
    if (result.error) throw result.error
  }

  const detailText = `${details.stdout || ''}\n${details.stderr || ''}`
  const entitlementText = `${entitlements.stdout || ''}\n${entitlements.stderr || ''}`
  const forbiddenDebugEntitlement = /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(entitlementText)
  const libraryValidationDisabled = /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(entitlementText)

  const signature = {
    valid: verification.status === 0,
    developerId: /^Authority=Developer ID Application:/m.test(detailText),
    hardenedRuntime: /flags=.*\bruntime\b/m.test(detailText),
    secureTimestamp: /^Timestamp=/m.test(detailText),
    forbiddenDebugEntitlement,
    libraryValidationDisabled,
  }
  return {
    ...signature,
    distributable:
      signature.valid &&
      signature.developerId &&
      signature.hardenedRuntime &&
      signature.secureTimestamp &&
      !signature.forbiddenDebugEntitlement,
  }
}

function verifyDistributionSignature(candidate, { deep = false, requireLibraryValidationDisabled = false } = {}) {
  const args = ['--verify']
  if (deep) args.push('--deep')
  args.push('--strict', '--verbose=2', candidate)
  runCodesign(args)

  const signature = inspectSignature(candidate)
  if (!signature.distributable) throw new Error(`${candidate} is not distribution-ready: ${distributionFailure(signature)}.`)
  if (requireLibraryValidationDisabled) verifyLibraryValidationEntitlement(candidate, signature)
}

function verifyLibraryValidationEntitlement(candidate, inspectedSignature) {
  const signature = inspectedSignature || inspectSignature(candidate)
  if (!signature.libraryValidationDisabled) throw new Error(`${candidate} is missing the DuckDB library-validation entitlement.`)
}

function distributionFailure(signature) {
  if (!signature.valid) return 'signature verification failed'
  if (!signature.developerId) return 'Developer ID authority is missing'
  if (!signature.hardenedRuntime) return 'hardened runtime is missing'
  if (!signature.secureTimestamp) return 'secure timestamp is missing'
  if (signature.forbiddenDebugEntitlement) return 'get-task-allow is enabled'
  return 'unknown signature policy failure'
}

function runCodesign(args) {
  const result = spawnSync('codesign', args, { encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`codesign ${args[0]} failed with exit code ${result.status ?? 1}.`)
}
