// Install dsh-rewind into a DSH profile.
//
//   node tools/install.mjs [--profile desktop] [--dry-run]
//
// Two changes, the same two every hand-installed DSH plugin makes:
//   1. a junction at <profile>/node_modules/dsh-rewind -> this package
//   2. one `- insert:` row appended to <profile>/cordis.patch.yml
//
// Node rather than PowerShell because cordis.patch.yml is UTF-8 without a BOM and
// other rows in it carry Chinese; Windows PowerShell 5.1 decodes that as the
// system ANSI codepage and a read-modify-write round trip turns it into mojibake.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-rewind'
const ROW_ID = 'rewind'
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const profileIndex = argv.indexOf('--profile')
const profileName = profileIndex === -1 ? (process.env.DSH_PROFILE || 'desktop') : argv[profileIndex + 1]
const uninstall = argv.includes('--uninstall')

function fail(message) {
  console.error(`FAILED: ${message}`)
  process.exit(2)
}

if (!existsSync(join(SRC, 'package.json')) || !existsSync(join(SRC, 'entry.js'))) {
  fail(`'${SRC}' does not look like the plugin (no package.json / entry.js).`)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = join(dshHome, 'profiles', profileName)
const patchFile = join(profile, 'cordis.patch.yml')
const linkPath = join(profile, 'node_modules', PKG)

if (!existsSync(join(profile, 'package.json'))) fail(`no profile at '${profile}'.`)
if (!existsSync(patchFile)) fail(`no cordis.patch.yml at '${patchFile}'.`)

console.log(`  source  : ${SRC}`)
console.log(`  profile : ${profile}`)
console.log(`  mode    : ${uninstall ? 'uninstall' : dryRun ? 'dry-run' : 'install'}`)

const manifestFile = join(profile, 'package.json')
let manifest
try {
  // A leading BOM is legal on disk and fatal to JSON.parse, and a profile manifest
  // that was touched by an editor rather than by DSH can carry one.
  manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''))
} catch (error) {
  fail(`cannot parse '${manifestFile}': ${error.message}`)
}

// Both manifest entries are required for the plugin to load at all:
//   * `dependencies` lets the profile resolve the package at all
//   * `dsh.profile.bundles` makes the web client build the browser half into EVERY
//     conversation. A `cordis.patch.yml` insert row on its own loads the Host half
//     but leaves the browser half out, which shows up as a rewind button that is
//     missing, or that only appears in some conversations and not others.
const depSpec = `link:${SRC.replace(/\\/g, '/')}`
const depPresent = manifest.dependencies !== undefined && manifest.dependencies[PKG] !== undefined
const bundleList = manifest.dsh?.profile?.bundles
const bundlePresent = Array.isArray(bundleList) && bundleList.includes(PKG)

const patchText = readFileSync(patchFile, 'utf8')
// Matched as `id: <row>` plus the package name, never as `<row>:`. The row spans
// three lines, so a search for `rewind:` would match nothing and a re-run would
// append a second copy.
const rowPresent = patchText.includes(`id: ${ROW_ID}`) && patchText.includes(PKG)

let linkState = 'absent'
const linkedManifest = join(linkPath, 'package.json')
if (existsSync(linkedManifest)) {
  try {
    const linked = JSON.parse(readFileSync(linkedManifest, 'utf8'))
    linkState = linked.name === PKG ? 'present' : 'present-but-foreign'
  } catch {
    linkState = 'present-but-unreadable'
  }
} else if (existsSync(linkPath)) {
  linkState = 'present-but-unreadable'
}

console.log(`  link    : ${linkState}`)
console.log(`  patch   : ${rowPresent ? 'row already present' : 'row will be appended'}`)
console.log(`  dep     : ${depPresent ? 'already registered' : `will be set to ${depSpec}`}`)
console.log(`  bundle  : ${bundlePresent ? 'already registered' : 'will be added to dsh.profile.bundles'}`)

if (dryRun) {
  console.log('\nDRY RUN: nothing written.')
  process.exit(0)
}

if (uninstall) {
  if (linkState === 'present') {
    rmSync(linkPath, { recursive: true, force: true })
    console.log('  removed the junction')
  }
  if (rowPresent) {
    // Remove the exact three-line row this installer appends, keeping the rest of
    // the file byte-identical.
    const eol = patchText.includes('\r\n') ? '\r\n' : '\n'
    const row = `- insert:${eol}    - id: ${ROW_ID}${eol}      name: ${PKG}${eol}`
    const next = patchText.split(eol + row).join(eol).split(row).join('')
    if (next === patchText) {
      fail('the patch row was found by id but not in the exact shape this installer writes; remove it by hand.')
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
    const backupDir = join(dshHome, `.dsh-rollback-${PKG}-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(patchFile, join(backupDir, 'cordis.patch.yml'))
    writeFileSync(patchFile, next, 'utf8')
    console.log(`  removed the patch row (backup: ${backupDir})`)
  }
  if (depPresent || bundlePresent) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
    const backupDir = join(dshHome, `.dsh-rollback-${PKG}-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(manifestFile, join(backupDir, 'package.json'))
    if (manifest.dependencies !== undefined) delete manifest.dependencies[PKG]
    if (Array.isArray(bundleList)) {
      manifest.dsh.profile.bundles = bundleList.filter((name) => name !== PKG)
    }
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`  removed the manifest entries (backup: ${backupDir})`)
  }
  console.log('\nDONE. Restart DSH for the row to disappear.')
  process.exit(0)
}

// --- back up -----------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
const backupDir = join(dshHome, `.dsh-rollback-${PKG}-${stamp}`)
mkdirSync(backupDir, { recursive: true })
copyFileSync(patchFile, join(backupDir, 'cordis.patch.yml'))
console.log(`  backup  : ${backupDir}`)

// --- 1. the link -------------------------------------------------------------
if (linkState === 'present') {
  console.log('  link already present; leaving it alone')
} else if (linkState === 'present-but-foreign' || linkState === 'present-but-unreadable') {
  fail(`${linkPath} exists but does not resolve to ${PKG}. Remove it and re-run.`)
} else {
  mkdirSync(dirname(linkPath), { recursive: true })
  // 'junction' rather than 'dir': a junction needs no elevation on Windows, which
  // a directory symlink does, and DSH is not normally run elevated.
  symlinkSync(SRC, linkPath, 'junction')
  console.log(`  linked  : ${linkPath} -> ${SRC}`)
}

// --- 2. the patch row --------------------------------------------------------
if (rowPresent) {
  console.log('  patch row already present; leaving it alone')
} else {
  const current = readFileSync(patchFile, 'utf8')
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const lead = current.length > 0 && !current.endsWith('\n') ? eol : ''
  const row = `${lead}${eol}- insert:${eol}    - id: ${ROW_ID}${eol}      name: ${PKG}${eol}`
  appendFileSync(patchFile, row, 'utf8')
  console.log('  appended the insert row')
}

// --- 3. the profile manifest -------------------------------------------------
if (depPresent && bundlePresent) {
  console.log('  manifest: already registered; leaving it alone')
} else {
  copyFileSync(manifestFile, join(backupDir, 'package.json'))
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[PKG] = depSpec
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(PKG)) bundles.push(PKG)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log('  manifest: registered the dependency and the bundle')
}

console.log('')
console.log('DONE. Restart DSH for it to load, then refresh the page.')
console.log(`Backup: ${backupDir}`)
