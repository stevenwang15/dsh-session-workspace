/**
 * Browser-half smoke test for dsh-session-workspace.
 *
 * Loads `client.js` the way the shell does — through the `__ModuleLoader__`
 * facade with a stub `react` — and checks the static client-plugin contract
 * (`name`, `inject`, `apply`) plus the slot registration the composer pill
 * depends on. This does not render React; it proves the bundle parses, executes
 * its factory, declares only the baseline module, registers dictionaries, and
 * contributes one entry to `conversation.input.left`.
 *
 * Run: node test/client.mjs   (or npm test)
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** React stub with just enough surface for the module body and the pill hooks. */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
  }
}

/**
 * Evaluate client.js in a browser-shaped sandbox.
 *
 * @returns {{ row: any, exports: any, required: string[] }} the registered loader row, its exports, and required specifiers.
 */
async function loadClientBundle() {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const required = []
  let row
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    document: {
      baseURI: 'http://127.0.0.1:39123/',
      createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
      head: { appendChild() {} },
    },
    window: {
      __ModuleLoader__: {
        load(registered) {
          row = registered
        },
      },
    },
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(row, 'the bundle registers one ModuleLoader row')
  const exports = row.factory((specifier) => {
    required.push(specifier)
    assert.equal(specifier, 'react', 'client bundles may only require baseline modules')
    return reactStub()
  })
  return { row, exports, required }
}

test('client bundle declares the plugin contract without extra modules', async () => {
  const { row, exports, required } = await loadClientBundle()
  assert.equal(row.id, 'dsh-session-workspace')
  assert.equal(exports.name, 'session-workspace')
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(required, ['react'])
})

test('client bundle registers one composer control and both dictionaries', async () => {
  const { exports } = await loadClientBundle()
  const registrations = []
  const dictionaries = []
  const effects = []
  const locale = {
    bind: (namespace) => (key) => `t:${namespace}.${key}`,
    register: (namespace, dict) => {
      dictionaries.push({ namespace, dict })
      return () => {}
    },
  }
  const ctx = {
    locale,
    effect(register) {
      effects.push(register())
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.input.left')
        return callback()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.equal(registrations.length, 1, 'exactly one composer entry is registered')
  const [{ options, Component }] = registrations
  assert.equal(options.name, 'conversation.input.left')
  assert.equal(options.id, 'session-workspace')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'sessionWorkspace')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), 't:sessionWorkspace.label')

  // The locale registration carries both baseline dictionaries with the keys
  // the pill renders and the tooltips it explains itself with.
  assert.equal(dictionaries.length, 1)
  const [{ namespace, dict }] = dictionaries
  assert.equal(namespace, 'sessionWorkspace')
  for (const language of ['zh', 'en']) {
    for (const key of ['label', 'on', 'off', 'hintOn', 'hintOff']) {
      assert.equal(typeof dict[language][key], 'string', `${language}.${key} is a string`)
    }
  }

  // The registered component builds an element; the actual pill renders null
  // until its control-API read resolves (the stub hooks return that state).
  const element = Component({})
  assert.ok(element !== null && element !== undefined, 'the entry renders an element container')
  assert.equal(typeof effects.length, 'number')
})
