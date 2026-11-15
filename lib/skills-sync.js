/**
 * dsh-session-api — bundled skill synchronization.
 *
 * The plugin ships one skill (`skills/dsh-session-status`) that teaches an agent
 * to answer state questions through this plugin's HTTP surface instead of
 * poking at the on-disk projection cache. It has to be present without the user
 * installing anything extra, and it has to survive an upgrade or a restart.
 *
 * Why copy into the skill library instead of mounting `customSkillDirs`:
 * the web-app layer disables the host `skill-filesystem` row on purpose
 * (`presets own local discovery`), so a host-layer override is inert — verified
 * against this installation. The library directory that *is* scanned is
 * `<agents home>/skills`, which is what this module writes to. Copying also
 * means the skill shows up in the skill manager, so the user can disable it.
 *
 * What is written is owned by the plugin:
 *   - a marker file records the version this plugin last installed
 *   - a directory whose SKILL.md still carries the plugin's own `x-provider`
 *     is treated as ours and may be replaced
 *   - anything else (the user edited it, another plugin owns the name) is left
 *     alone
 *
 * Removal is symmetric: `removeBundledSkills` deletes only directories that are
 * still recognisably ours, so an uninstall does not take a user's file with it.
 *
 * @module dsh-session-api/skills-sync
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Provider name stamped into every skill this plugin installs. */
export const PROVIDER = 'dsh-session-api'

/** Directory names (also skill names) this plugin owns. */
export const BUNDLED_SKILLS = ['dsh-session-status']

/** Marker recording which version was installed, so an upgrade overwrites. */
const MARKER = '.dsh-session-api-synced.json'

/**
 * Locate the directory holding this module's bundled skills.
 * @returns absolute path to `<package>/skills`.
 */
export function bundledSkillsDir() {
  // import.meta.url points at lib/skills-sync.js
  return join(fileURLToPath(new URL('../skills', import.meta.url)))
}

/**
 * Resolve the shared agent config root the same way the skill provider does.
 * @returns absolute path to the agents home (default `~/.agents`).
 */
export function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.agents')
}

/**
 * Read the `x-provider` frontmatter field of one skill file.
 * @param skillFile - absolute path to a SKILL.md.
 * @returns the provider name, or undefined when absent/unreadable.
 */
function providerOf(skillFile) {
  let text
  try {
    text = readFileSync(skillFile, 'utf8')
  } catch {
    return undefined
  }
  // Frontmatter is the leading `---` block; the provider is a scalar in it.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return undefined
  const line = /^x-provider\s*:\s*(.+)$/m.exec(match[1])
  if (line === null) return undefined
  return line[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * Whether a skill directory at `target` is still the copy this plugin wrote.
 * @param target - absolute directory to test.
 * @returns true when the plugin owns it and may replace or delete it.
 */
function isOurs(target) {
  try {
    if (!readdirSync(target).length) return true
  } catch {
    return false
  }
  return providerOf(join(target, 'SKILL.md')) === PROVIDER
}

/**
 * Copy every bundled skill into the skill library.
 *
 * Best effort by design: a failure here must never stop the control surface
 * from starting, so each skill is attempted independently and problems are
 * logged rather than thrown.
 * @param options - library root, log sink, and whether to force an overwrite.
 * @returns the names actually written.
 */
export function syncBundledSkills(options = {}) {
  const { log } = options
  const source = options.sourceDir ?? bundledSkillsDir()
  const target = options.targetDir ?? join(agentsHome(), 'skills')
  if (!existsSync(source)) {
    log?.warn?.('dsh-session-api: bundled skills missing at %s', source)
    return []
  }
  const written = []
  try {
    mkdirSync(target, { recursive: true })
  } catch (error) {
    log?.warn?.('dsh-session-api: cannot create the skill library at %s: %s', target, error)
    return []
  }

  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? version
  } catch {
    // Version is only used to decide re-copying; the file copy below is safe.
  }
  const markerPath = join(target, MARKER)
  let installed
  try {
    installed = JSON.parse(readFileSync(markerPath, 'utf8'))?.version
  } catch {
    installed = undefined
  }
  const upToDate = installed === version && !options.force

  for (const name of BUNDLED_SKILLS) {
    const from = join(source, name)
    const to = join(target, name)
    if (!existsSync(from)) continue
    if (existsSync(to) && !isOurs(to)) {
      // Either the user edited it or another plugin owns the name. Both are
      // valid reasons to leave it exactly as it is.
      log?.warn?.('dsh-session-api: leaving %s alone (not written by this plugin)', to)
      continue
    }
    if (upToDate && existsSync(join(to, 'SKILL.md'))) continue
    try {
      if (existsSync(to)) rmSync(to, { recursive: true, force: true })
      cpSync(from, to, { recursive: true })
      written.push(name)
    } catch (error) {
      log?.warn?.('dsh-session-api: could not install skill %s: %s', name, error)
    }
  }

  try {
    writeFileSync(markerPath, `${JSON.stringify({ version, at: new Date().toISOString() }, null, 2)}\n`)
  } catch {
    // The marker only saves a re-copy on the next boot.
  }
  if (written.length > 0) log?.info?.('dsh-session-api: installed skill(s) %s into %s', written.join(', '), target)
  return written
}

/**
 * Remove the skills this plugin installed, leaving any the user adopted.
 * @param options - library root and log sink.
 * @returns the names actually removed.
 */
export function removeBundledSkills(options = {}) {
  const { log } = options
  const target = options.targetDir ?? join(agentsHome(), 'skills')
  const removed = []
  for (const name of BUNDLED_SKILLS) {
    const dir = join(target, name)
    if (!existsSync(dir)) continue
    if (!isOurs(dir)) {
      log?.warn?.('dsh-session-api: not removing %s (edited or owned elsewhere)', dir)
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      log?.warn?.('dsh-session-api: could not remove skill %s: %s', name, error)
    }
  }
  try {
    rmSync(join(target, MARKER), { force: true })
  } catch {
    // Absent already.
  }
  return removed
}
