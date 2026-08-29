import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readlink, readdir, rm, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { appBundle, appBundleName, projectRoot } from './app-paths.mjs'

if (process.platform !== 'darwin') {
  throw new Error(`macOS disk images can only be created on macOS; current platform is ${process.platform}.`)
}

const output = path.resolve(process.argv[2] || path.join(projectRoot, 'build', 'bin', 'DucsTable.dmg'))
if (path.extname(output).toLowerCase() !== '.dmg') throw new Error(`DMG output must end in .dmg: ${output}`)

try {
  await access(appBundle, constants.F_OK)
} catch {
  throw new Error(`${appBundle} is missing. Build and sign the app before creating the disk image.`)
}

await mkdir(path.dirname(output), { recursive: true })
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ducs-table-dmg-'))
const stagingDirectory = path.join(temporaryDirectory, "Duc's Table")

try {
  await mkdir(stagingDirectory)
  run('ditto', [appBundle, path.join(stagingDirectory, appBundleName)])
  await symlink('/Applications', path.join(stagingDirectory, 'Applications'), 'dir')
  run('hdiutil', [
    'create',
    '-volname', "Duc's Table",
    '-srcfolder', stagingDirectory,
    '-format', 'UDZO',
    '-ov',
    output,
  ])
  await verifyDiskImage(output, path.join(temporaryDirectory, 'mount'))
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.log(`macOS drag-to-Applications disk image created at ${output}`)

async function verifyDiskImage(diskImage, mountDirectory) {
  await mkdir(mountDirectory)
  let mounted = false
  try {
    run('hdiutil', ['attach', diskImage, '-nobrowse', '-readonly', '-mountpoint', mountDirectory])
    mounted = true

    const mountedApp = path.join(mountDirectory, appBundleName)
    await access(mountedApp, constants.F_OK)
    const applicationsTarget = await readlink(path.join(mountDirectory, 'Applications'))
    if (applicationsTarget !== '/Applications') {
      throw new Error(`Applications shortcut targets ${applicationsTarget}; expected /Applications.`)
    }

    const visibleItems = (await readdir(mountDirectory)).filter((item) => !item.startsWith('.')).sort()
    const expectedItems = ['Applications', appBundleName].sort()
    if (JSON.stringify(visibleItems) !== JSON.stringify(expectedItems)) {
      throw new Error(`Unexpected DMG contents: ${visibleItems.join(', ')}`)
    }

    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', mountedApp])
  } finally {
    if (mounted) run('hdiutil', ['detach', mountDirectory])
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}.`)
}
