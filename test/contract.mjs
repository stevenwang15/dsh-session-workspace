/**
 * Distribution contract test for dsh-session-workspace.
 *
 * The unit tests prove behavior; this one proves the package is installable as a
 * DSH bundle: manifest fields, the bundle patch row that mounts it, and a plugin
 * entry with the Cordis contract (`name`, `inject`, `apply`) that imports only
 * Node built-ins (a profile-installed plugin has no dependency tree of its own).
 *
 * Run: node test/contract.mjs   (or npm test)
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read one UTF-8 file relative to the package root. */
const read = (relative) => readFile(join(ROOT, relative), 'utf8')

test('manifest declares a loadable DSH bundle with both halves', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.name, 'dsh-session-workspace')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web', 'the browser half is declared for the web shell')
  assert.equal(manifest.exports?.['.'], './index.js')
  assert.equal(manifest.exports?.['./client'], './client.js', 'the shell resolves the browser bundle through this export')
  assert.equal(manifest.license, 'MIT')
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(file), `files[] should ship ${file}`)
  }
  const shipped = await readdir(ROOT)
  for (const file of manifest.files.filter((file) => !file.includes('/'))) {
    assert.ok(shipped.includes(file), `files[] entry ${file} exists on disk`)
  }
})

test('the bundle patch inserts the plugin row by package name', async () => {
  const patch = await read('cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  const row = patch.split('\n').find((line) => line.trim().startsWith('- id: session-workspace'))
  assert.ok(row, 'patch contains the session-workspace row')
  assert.match(patch, /^\s+name: dsh-session-workspace$/m)
})

test('the plugin entry exposes the Cordis contract and imports no third-party code', async () => {
  const source = await read('index.js')
  const entry = await import(new URL('../index.js', import.meta.url))
  assert.equal(entry.name, 'session-workspace')
  assert.deepEqual(entry.inject, ['sessionController', 'workspaceRegistry'])
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.normalizeConfig, 'function')
  assert.equal(typeof entry.controlRoutes, 'function', 'the control API is testable through its route list')
  for (const match of source.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)) {
    assert.ok(match[1].startsWith('node:'), `only node: imports are allowed, found ${match[1]}`)
  }
  // The wrapper must restore the previous implementation on disposal.
  assert.match(source, /ctx\.effect\(/)
})

test('the browser half is a hand-written ModuleLoader bundle with no imports', async () => {
  const source = await read('client.js')
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/m)
  assert.match(source, /factory:\s*\(?require/)
  assert.doesNotMatch(source, /^\s*import\s/m, 'client bundles are lazy CJS, not ESM')
  assert.match(source, /exports\.name\s*=\s*'session-workspace'/)
  assert.match(source, /exports\.inject\s*=/, 'the browser half declares its client services')
  assert.match(source, /exports\.apply\s*=/, 'the shell mounts the browser half through apply')
  // The composer seat the pill occupies must stay in sync with the host-side doc.
  assert.match(source, /conversation\.input\.left/)
})

test('README documents every config key the plugin accepts', async () => {
  const readme = await read('README.md')
  for (const key of ['enabled', 'mode', 'baseDir', 'managed', 'all']) {
    assert.ok(readme.includes(key), `README documents ${key}`)
  }
  assert.ok(readme.includes('session-workspaces'), 'README names the default base directory')
})
