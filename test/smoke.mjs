/**
 * Unit tests for dsh-session-workspace.
 *
 * These run without a DeepSeek Harness host: a fake Cordis context supplies the
 * two services the plugin injects, plus a fake `sessionController.create` that
 * records the requests the plugin forwards. Filesystem behavior is real (under
 * the OS temp directory) so directory allocation, realpath canonicalization and
 * cleanup are exercised, not mocked.
 *
 * Run: node test/smoke.mjs   (or npm test)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  apply,
  directoryPlan,
  internals,
  normalizeConfig,
  resolveBaseDir,
  shouldIsolate,
} from '../index.js'

/** Create a throwaway base directory for one test. */
async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * Build a fake Cordis context with a real-directory Workspace registry.
 *
 * @param {object} [options]
 * @param {string} [options.defaultWorkspacePath] - path of the stock default Workspace to register.
 * @param {Array<{id: string, path: string}>} [options.extraWorkspaces] - additional manual Workspaces.
 */
function fakeContext(options = {}) {
  const workspaces = new Map()
  let workspaceSeq = 0
  let sessionSeq = 0
  const calls = []
  const logs = []
  const disposers = []
  const failures = []
  const routes = []
  let nextFailure = undefined
  const state = {}

  const registry = {
    state,
    get: (id) => workspaces.get(id),
    list: () => [...workspaces.values()],
    async create(path, title) {
      const canonical = await realpath(path)
      for (const workspace of workspaces.values()) if (workspace.path === canonical) return workspace
      const workspace = { id: `workspace-${++workspaceSeq}`, path: canonical, title: title ?? basename(canonical), sessionIds: [] }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    async delete(id) {
      return workspaces.delete(id)
    },
  }

  const controller = {
    async create(request = {}) {
      calls.push(structuredClone(request))
      const failure = nextFailure
      nextFailure = undefined
      if (failure !== undefined) throw failure
      let cwd = request.cwd
      if (request.workspaceId !== undefined) {
        const workspace = workspaces.get(request.workspaceId)
        if (workspace === undefined) throw new Error(`workspace/not-found ${request.workspaceId}`)
        cwd = workspace.path
        workspace.sessionIds.unshift(`session-${sessionSeq + 1}`)
      }
      return { sessionId: `session-${++sessionSeq}`, cwd }
    },
  }

  // The control API registers through the Connection service's Fetch registry.
  const connection = 'connection' in options ? options.connection : { fetch: { register: () => () => {} } }

  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    workspaceRegistry: registry,
    sessionController: controller,
    get(name) {
      return name === 'connection' ? connection : undefined
    },
    /**
     * Cordis' service-readiness helper: run the callback once the declared
     * services exist. Tests model the `connection` dependency and its Fetch
     * route registry.
     */
    inject(dependencies, callback) {
      if (!dependencies.includes('connection')) return
      if ('connection' in options && options.connection === undefined) return
      const scoped = {
        connection: options.connection ?? {
          fetch: {
            register(route) {
              routes.push(route)
              return () => {
                const at = routes.indexOf(route)
                if (at >= 0) routes.splice(at, 1)
              }
            },
          },
        },
        effect(register) {
          disposers.push(register())
        },
      }
      callback(scoped)
    },
    effect(register, label) {
      disposers.push(register())
      failures.push(label)
    },
  }

  const fake = {
    ctx,
    registry,
    controller,
    calls,
    logs,
    state,
    disposers,
    routes,
    connection,
    failNext: (error) => { nextFailure = error },
    /** Register the initial Workspaces on disk (their directories must exist). */
    async seed() {
      if (options.defaultWorkspacePath !== undefined) {
        await mkdir(options.defaultWorkspacePath, { recursive: true })
        const workspace = await registry.create(options.defaultWorkspacePath, 'default-workspace')
        state.defaultWorkspaceId = workspace.id
      }
      for (const extra of options.extraWorkspaces ?? []) {
        await mkdir(extra.path, { recursive: true })
        await registry.create(extra.path, extra.title)
      }
      return fake
    },
  }
  return fake
}

/** Apply the plugin and return the fake context plus its dispose handle. */
async function plugin(t, config, options) {
  const fake = await fakeContext(options).seed()
  apply(fake.ctx, config)
  t.after(() => { for (const dispose of fake.disposers) dispose() })
  return fake
}

test('normalizeConfig defaults, overrides and rejections', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, mode: 'managed', baseDir: undefined })
  assert.deepEqual(normalizeConfig({ enabled: false, mode: 'all', baseDir: '/tmp/x' }), { enabled: false, mode: 'all', baseDir: '/tmp/x' })
  assert.throws(() => normalizeConfig({ mode: 'sometimes' }), /mode/)
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled/)
  assert.throws(() => normalizeConfig({ baseDir: 'relative/dir' }), /absolute/)
})

test('directoryPlan makes a sortable unique leaf and a minute-precision title', () => {
  const now = new Date(2026, 10, 6, 20, 15, 33)
  const a = directoryPlan(now)
  const b = directoryPlan(now)
  assert.match(a.leaf, /^20261106-201533-[0-9a-f]{4}$/)
  assert.equal(a.title, '2026-11-06 20:15')
  assert.notEqual(a.leaf, b.leaf)
})

test('resolveBaseDir: config wins, then the default workspace sibling, then home fallback', async (t) => {
  const root = await makeRoot(t)
  const fake = await fakeContext().seed()
  assert.equal(resolveBaseDir(fake.ctx, { baseDir: join(root, 'custom') }), join(await realpath(root), 'custom'))
  assert.equal(resolveBaseDir(fake.ctx, {}), join(process.env.HOME ?? '', 'Documents', 'deepseek-harness', 'session-workspaces'))

  const defaultPath = join(root, 'deepseek-harness', 'default-workspace')
  const withDefault = await fakeContext({ defaultWorkspacePath: defaultPath }).seed()
  assert.equal(resolveBaseDir(withDefault.ctx, {}), join(await realpath(root), 'deepseek-harness', 'session-workspaces'))
})

test('shouldIsolate: new conversations isolate, explicit targets are honoured', async (t) => {
  const root = await makeRoot(t)
  const baseDir = join(root, 'deepseek-harness', 'session-workspaces')
  const manualPath = join(root, 'projects', 'my-project')
  const defaultPath = join(root, 'deepseek-harness', 'default-workspace')
  const fake = await fakeContext({ defaultWorkspacePath: defaultPath, extraWorkspaces: [{ path: join(baseDir, '20260101-000000-abcd'), title: 'managed' }, { path: manualPath, title: 'my-project' }] }).seed()
  await mkdir(baseDir, { recursive: true })
  const settings = normalizeConfig({})
  const state = { baseDir: await realpath(baseDir) }
  const defaultId = fake.state.defaultWorkspaceId
  const canonicalManualPath = await realpath(manualPath)
  const managedId = fake.registry.list().find((workspace) => workspace.path.includes('session-workspaces'))?.id
  const manualId = fake.registry.list().find((workspace) => workspace.path === canonicalManualPath)?.id
  assert.ok(defaultId !== undefined && managedId !== undefined && manualId !== undefined)

  assert.equal(shouldIsolate(fake.ctx, settings, state, {}), true)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { agentPreset: 'chat' }), true)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { workspaceId: defaultId }), true)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { workspaceId: managedId }), true)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { workspaceId: manualId }), false)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { workspaceId: 'workspace-unknown' }), false)
  // Explicit locations and blanks are never rewritten.
  assert.equal(shouldIsolate(fake.ctx, settings, state, { cwd: manualPath }), false)
  assert.equal(shouldIsolate(fake.ctx, settings, state, { workspaceId: defaultId, sessionId: 'session-1' }), false)
  // mode=all isolates even an explicitly picked workspace.
  assert.equal(shouldIsolate(fake.ctx, normalizeConfig({ mode: 'all' }), state, { workspaceId: manualId }), true)
})

test('apply: a new conversation gets a fresh directory, a Workspace, and its own cwd', async (t) => {
  const root = await makeRoot(t)
  const baseDir = join(root, 'session-workspaces')
  const fake = await plugin(t, { baseDir })
  const result = await fake.ctx.sessionController.create({})

  assert.equal(fake.calls.length, 1)
  assert.ok(fake.calls[0].workspaceId !== undefined, 'original create receives the new workspace id')
  assert.equal(fake.calls[0].cwd, undefined)
  const workspaces = fake.registry.list()
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].path, result.cwd)
  assert.equal(basename(workspaces[0].path), basename(result.cwd))
  assert.match(basename(result.cwd), /^\d{8}-\d{6}-[0-9a-f]{4}$/)
  assert.equal((await stat(result.cwd)).isDirectory(), true)
  assert.equal(fake.registry.get(fake.calls[0].workspaceId).sessionIds.length, 1, 'the Host attaches the session to the new workspace')
})

test('apply: each conversation isolates again, even from a previous isolated workspace', async (t) => {
  const root = await makeRoot(t)
  const baseDir = join(root, 'session-workspaces')
  const fake = await plugin(t, { baseDir })
  const first = await fake.ctx.sessionController.create({})
  const firstWorkspaceId = fake.calls[0].workspaceId
  const second = await fake.ctx.sessionController.create({ workspaceId: firstWorkspaceId })
  assert.equal(fake.calls.length, 2)
  assert.notEqual(fake.calls[1].workspaceId, firstWorkspaceId)
  assert.notEqual(second.cwd, first.cwd)
  assert.equal(fake.registry.list().length, 2)
})

test('apply: agentPreset is forwarded while cwd and sessionId are dropped', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'base') })
  await fake.ctx.sessionController.create({ agentPreset: 'chat', sessionId: 'session-old', cwd: '/elsewhere' })
  // sessionId/cwd mean "reuse this Session here", so the request passes through untouched.
  assert.deepEqual(fake.calls[0], { agentPreset: 'chat', sessionId: 'session-old', cwd: '/elsewhere' })
  await fake.ctx.sessionController.create({ agentPreset: 'chat' })
  assert.equal(fake.calls[1].agentPreset, 'chat')
  assert.equal(fake.calls[1].sessionId, undefined)
  assert.equal(fake.calls[1].cwd, undefined)
  assert.ok(fake.calls[1].workspaceId !== undefined)
})

test('apply: an explicitly picked manual workspace is left alone', async (t) => {
  const root = await makeRoot(t)
  const manualPath = join(root, 'projects', 'manual')
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') }, { extraWorkspaces: [{ path: manualPath, title: 'manual' }] })
  const manual = fake.registry.list()[0]
  await fake.ctx.sessionController.create({ workspaceId: manual.id })
  assert.deepEqual(fake.calls[0], { workspaceId: manual.id })
  assert.equal(fake.registry.list().length, 1)
})

test('apply: failed creation removes the unused workspace and empty directory', async (t) => {
  const root = await makeRoot(t)
  const baseDir = join(root, 'session-workspaces')
  const fake = await plugin(t, { baseDir })
  fake.failNext(new Error('agent preset exploded'))
  await assert.rejects(() => fake.ctx.sessionController.create({}), /agent preset exploded/)
  assert.equal(fake.registry.list().length, 0, 'unused workspace registration is removed')
  assert.deepEqual(await readdir(baseDir), [], 'empty directory is removed')
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && /could not remove/.test(entry.message)) === false)
})

test('apply: a failure that published a Session keeps its directory and workspace', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') })
  const failure = new Error('attach failed')
  failure.details = { sessionId: 'session-published' }
  fake.failNext(failure)
  await assert.rejects(() => fake.ctx.sessionController.create({}), /attach failed/)
  assert.equal(fake.registry.list().length, 1, 'workspace is kept for the published Session')
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && /keeping that directory/.test(entry.message)))
})

test('apply: an unusable base directory falls back to stock creation', async (t) => {
  const root = await makeRoot(t)
  const filePath = join(root, 'not-a-directory')
  await writeFile(filePath, 'x')
  const fake = await plugin(t, { baseDir: filePath })
  const result = await fake.ctx.sessionController.create({})
  assert.equal(result.sessionId, 'session-1')
  assert.deepEqual(fake.calls[0], {}, 'the original request is forwarded unchanged')
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && /falling back/.test(entry.message)))
})

test('apply: disposal restores the original create, and reloading re-wraps once', async (t) => {
  const root = await makeRoot(t)
  const fake = await fakeContext().seed()
  const original = fake.controller.create
  const beforeFirst = fake.disposers.length
  apply(fake.ctx, { baseDir: join(root, 'a') })
  const firstDisposers = fake.disposers.slice(beforeFirst)
  const once = fake.ctx.sessionController.create
  assert.notEqual(once, original)
  const beforeSecond = fake.disposers.length
  apply(fake.ctx, { baseDir: join(root, 'b') })
  const secondDisposers = fake.disposers.slice(beforeSecond)
  const twice = fake.ctx.sessionController.create
  assert.notEqual(twice, once)
  // Disposing the older instance must not resurrect a stale wrapper.
  for (const dispose of firstDisposers.reverse()) dispose()
  assert.equal(fake.ctx.sessionController.create, twice)
  for (const dispose of secondDisposers.reverse()) dispose()
  assert.equal(fake.ctx.sessionController.create, original)
})

test('apply: enabled=false leaves the service untouched', async (t) => {
  const root = await makeRoot(t)
  const fake = await fakeContext().seed()
  const original = fake.controller.create
  apply(fake.ctx, { enabled: false, baseDir: join(root, 'x') })
  assert.equal(fake.ctx.sessionController.create, original)
})

test('internals: default workspace detection prefers the recorded id', async (t) => {
  const root = await makeRoot(t)
  const fake = await fakeContext({ defaultWorkspacePath: join(root, 'deepseek-harness', 'default-workspace') }).seed()
  const stock = fake.registry.list()[0]
  assert.equal(internals.isDefaultWorkspace(fake.ctx, stock), true)
  // The path fallback also recognizes a workspace whose directory leaf is canonical.
  const legacy = { id: 'legacy', path: join(root, 'custom', 'default-workspace') }
  assert.equal(internals.isDefaultWorkspace({ workspaceRegistry: { state: {} } }, legacy), true)
  assert.equal(internals.isDefaultWorkspace({ workspaceRegistry: { state: {} } }, { id: 'x', path: join(root, 'other') }), false)
})

test('apply: the Typert gateway dispatch (Reflect.get + Reflect.apply) resolves the wrapper', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') })
  // dsh-api-gateway resolves the business method per invocation with
  // `Reflect.get(callReceiver, implementation)` and calls it with
  // `Reflect.apply(method, receiver, args)`; an own-property override must win.
  const method = Reflect.get(fake.ctx.sessionController, 'create')
  const value = await Reflect.apply(method, fake.ctx.sessionController, [{}])
  assert.equal(fake.calls.length, 1)
  assert.ok(fake.calls[0].workspaceId !== undefined)
  assert.equal(value.cwd, fake.registry.get(fake.calls[0].workspaceId).path)
})

/** Build a node:http-shaped request for the control-API tests. */
function fakeRequest(method, url, body) {
  const handlers = new Map()
  const request = {
    method,
    url,
    destroyed: false,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return request
    },
    destroy() {
      request.destroyed = true
    },
  }
  setImmediate(() => {
    if (body !== undefined) for (const handler of handlers.get('data') ?? []) handler(Buffer.from(body))
    for (const handler of handlers.get('end') ?? []) handler()
  })
  return request
}

/** Build a node:http-shaped response that records status, headers and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(text) {
      this.body = text ?? ''
    },
  }
}

/** Wait until the handler writes its response. */
async function settle(response) {
  for (let attempt = 0; attempt < 200 && response.status === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return response
}

/** Call the mounted control route and return the recorded response. */
async function callControl(fake, method, suffix, body) {
  const route = fake.routes.find((entry) => entry.kind === 'prefix' && entry.path === internals.CONTROL_PATH)
  assert.ok(route, 'the control API route is registered once a webServer exists')
  const response = fakeResponse()
  route.handler(fakeRequest(method, `${route.path}${suffix}`, body), response)
  return settle(response)
}

test('control API: mounts two authenticated Fetch routes under /api', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') })
  assert.equal(fake.routes.length, 2)
  const paths = fake.routes.map((route) => `${route.methods.join(',')} ${route.path}`).sort()
  assert.deepEqual(paths, [
    `GET ${internals.CONTROL_PATH}/state`,
    `POST ${internals.CONTROL_PATH}/enabled`,
  ])
  for (const route of fake.routes) {
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
})

test('control API: reports the runtime state over its Fetch route', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') })
  const route = fake.routes.find((entry) => entry.path === `${internals.CONTROL_PATH}/state`)
  const response = await route.fetch(new Request('http://dsh.invalid' + route.path, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    enabled: true,
    mode: 'managed',
    baseDir: join(await realpath(root), 'session-workspaces'),
  })
})

test('control API: runtime toggle disables and restores automatic isolation', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'session-workspaces') })
  const toggle = fake.routes.find((entry) => entry.path === `${internals.CONTROL_PATH}/enabled`)
  const call = async (body) => toggle.fetch(new Request('http://dsh.invalid' + toggle.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const off = await call({ enabled: false })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).enabled, false)

  // With automatic isolation off a new conversation passes through untouched.
  await fake.ctx.sessionController.create({ agentPreset: 'standard' })
  assert.deepEqual(fake.calls[0], { agentPreset: 'standard' })
  assert.equal(fake.registry.list().length, 0)

  const on = await call({ enabled: true })
  assert.equal(on.status, 200)
  await fake.ctx.sessionController.create({ agentPreset: 'standard' })
  assert.ok(fake.calls[1].workspaceId !== undefined)
  assert.equal(fake.registry.list().length, 1)
})

test('control API: rejects malformed bodies', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'base') })
  const toggle = fake.routes.find((entry) => entry.path === `${internals.CONTROL_PATH}/enabled`)
  const call = (body) => toggle.fetch(new Request('http://dsh.invalid' + toggle.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
  assert.equal((await call('{not json')).status, 400)
  assert.equal((await call(JSON.stringify({ enabled: 'yes' }))).status, 400)
})

test('control API: a composition without a Connection service stays host-only', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'base') }, { connection: undefined })
  assert.equal(fake.routes.length, 0)
})

test('control API: a Connection without a Fetch registry degrades to host-only', async (t) => {
  const root = await makeRoot(t)
  const fake = await plugin(t, { baseDir: join(root, 'base') }, { connection: {} })
  assert.equal(fake.routes.length, 0)
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && /no Fetch route registry/.test(entry.message)))
})
