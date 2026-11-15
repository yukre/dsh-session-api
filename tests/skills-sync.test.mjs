/**
 * dsh-session-api — bundled skill synchronization.
 *
 * Every case writes to a throwaway library root, so the user's real
 * `~/.agents/skills` is never touched by a test run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm as rmDir, writeFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  syncBundledSkills, removeBundledSkills, bundledSkillsDir, BUNDLED_SKILLS, PROVIDER,
} from '../lib/skills-sync.js'

/**
 * One throwaway skill library.
 * @returns its root directory.
 */
async function library() {
  return mkdtemp(join(tmpdir(), 'dsa-skills-'))
}

/** Collect warnings so "left it alone" is observable. */
function recorder() {
  const warnings = []
  const notices = []
  return {
    warnings,
    notices,
    log: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: (...args) => notices.push(args.map(String).join(' ')),
    },
  }
}

test('the package ships the skill it advertises', async () => {
  const source = bundledSkillsDir()
  assert.equal(existsSync(source), true, `missing skills dir at ${source}`)
  for (const name of BUNDLED_SKILLS) {
    const file = join(source, name, 'SKILL.md')
    assert.equal(existsSync(file), true, `missing ${file}`)
    const text = readFileSync(file, 'utf8')
    // The trigger description and the provider marker are what make the skill
    // discoverable and re-synchronisable; both are part of the contract.
    assert.match(text, /^---\r?\n/)
    assert.match(text, new RegExp(`x-provider:\\s*${PROVIDER}`))
    assert.match(text, /^description:/m)
    assert.match(text, /任务|会话|审批/)
  }
})

test('a first sync installs every bundled skill', async () => {
  const root = await library()
  const { log, notices } = recorder()
  const written = syncBundledSkills({ targetDir: root, log })
  assert.deepEqual(written, BUNDLED_SKILLS)
  for (const name of BUNDLED_SKILLS) {
    assert.equal(existsSync(join(root, name, 'SKILL.md')), true)
  }
  // And the marker records what was installed.
  const marker = JSON.parse(await readFile(join(root, '.dsh-session-api-synced.json'), 'utf8'))
  assert.equal(typeof marker.version, 'string')
  assert.equal(notices.length > 0, true)
  await rmDir(root, { recursive: true, force: true })
})

test('a second sync is a no-op', async () => {
  const root = await library()
  syncBundledSkills({ targetDir: root })
  const second = syncBundledSkills({ targetDir: root })
  assert.deepEqual(second, [])
  await rmDir(root, { recursive: true, force: true })
})

test('a version bump re-installs the skill', async () => {
  const root = await library()
  syncBundledSkills({ targetDir: root })
  // Simulate an older install by rewriting the marker.
  await writeFile(join(root, '.dsh-session-api-synced.json'), '{"version":"0.0.1"}\n')
  const again = syncBundledSkills({ targetDir: root })
  assert.deepEqual(again, BUNDLED_SKILLS)
  await rmDir(root, { recursive: true, force: true })
})

test('a directory the plugin did not write is left untouched', async () => {
  const root = await library()
  const name = BUNDLED_SKILLS[0]
  await mkdir(join(root, name), { recursive: true })
  const userFile = join(root, name, 'SKILL.md')
  await writeFile(userFile, '---\nname: mine\nx-provider: someone-else\ndescription: my own\n---\n\nkeep me\n')

  const { log, warnings } = recorder()
  const written = syncBundledSkills({ targetDir: root, log, force: true })
  assert.deepEqual(written, [])
  // The user's content must survive a forced sync.
  assert.match(await readFile(userFile, 'utf8'), /keep me/)
  assert.equal(warnings.some(w => w.includes('leaving')), true)
  await rmDir(root, { recursive: true, force: true })
})

test('removal deletes only what the plugin wrote', async () => {
  const root = await library()
  syncBundledSkills({ targetDir: root })
  const removed = removeBundledSkills({ targetDir: root })
  assert.deepEqual(removed, BUNDLED_SKILLS)
  for (const name of BUNDLED_SKILLS) {
    assert.equal(existsSync(join(root, name)), false)
  }
  assert.equal(existsSync(join(root, '.dsh-session-api-synced.json')), false)
  await rmDir(root, { recursive: true, force: true })
})

test('removal keeps an adopted skill', async () => {
  const root = await library()
  syncBundledSkills({ targetDir: root })
  // The user edits it away from our provider marker.
  const file = join(root, BUNDLED_SKILLS[0], 'SKILL.md')
  const edited = (await readFile(file, 'utf8')).replace(`x-provider: ${PROVIDER}`, 'x-provider: my-own-fork')
  await writeFile(file, edited)

  const { log, warnings } = recorder()
  const removed = removeBundledSkills({ targetDir: root, log })
  assert.deepEqual(removed, [])
  assert.equal(existsSync(file), true, 'an adopted skill must survive removal')
  assert.equal(warnings.some(w => w.includes('not removing')), true)
  await rmDir(root, { recursive: true, force: true })
})

test('an unwritable library does not throw', async () => {
  const { log, warnings } = recorder()
  // A path under a regular file can never be a directory.
  const parent = await library()
  const blocker = join(parent, 'blocker')
  await writeFile(blocker, 'x')
  const written = syncBundledSkills({ targetDir: join(blocker, 'skills'), log })
  assert.deepEqual(written, [])
  assert.equal(warnings.length > 0, true)
  await rmDir(parent, { recursive: true, force: true })
})

test('the synced copy keeps its frontmatter intact', async () => {
  const root = await library()
  syncBundledSkills({ targetDir: root })
  const target = join(root, BUNDLED_SKILLS[0], 'SKILL.md')
  const source = join(bundledSkillsDir(), BUNDLED_SKILLS[0], 'SKILL.md')
  assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'))
  await rmDir(root, { recursive: true, force: true })
})
