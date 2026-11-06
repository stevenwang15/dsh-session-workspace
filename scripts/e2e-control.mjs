/**
 * Control-API end-to-end test for dsh-session-workspace.
 *
 * Boots a REAL, isolated DeepSeek Harness web Host (never the live desktop
 * profile), loads the plugin through the same bundle install the desktop uses,
 * then proves the browser-half contract end to end:
 *
 *   1. `GET  /api/session-workspace/state` is served, authenticated by the
 *      composition's own browser cookie;
 *   2. `POST /api/session-workspace/enabled {false}` makes the very next
 *      `session.create` pass through without a new workspace;
 *   3. `POST /api/session-workspace/enabled {true}` restores isolation and the
 *      next `session.create` creates + attaches a fresh workspace directory;
 *   4. the browser bundle for the client half is part of the boot graph and is
 *      served with the composer pill code.
 *
 * Dependency-free. Run: `node scripts/e2e-control.mjs` (or `npm run e2e:control`).
 * Exit code 0 with a final `E2E_CONTROL_RESULT {...}` line means every check ran.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PLUGIN_ROOT, '..')
const DSH_CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const HOME_DIR = process.env.DSH_E2E_HOME ?? join(WORKSPACE_ROOT, '.e2e-control')
const PROFILE = process.env.DSH_E2E_PROFILE ?? 'ws-control'
const KEEP = process.argv.includes('--keep')
const VERBOSE = process.argv.includes('--verbose')
const BOOT_TIMEOUT_MS = 180_000

const state = {
  checks: {},
  hostPid: undefined,
  url: undefined,
  home: HOME_DIR,
  profile: PROFILE,
  pluginMounted: false,
  endpoints: {},
}

/** Print one step heading. */
function step(title) {
  console.log(`\n[${title}]`)
}

/** Record one assertion. */
function check(name, ok, detail) {
  state.checks[name] = ok === true
  console.log(`    ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) throw new Error(`check failed: ${name}${detail === undefined ? '' : ` (${detail})`}`)
}

/** Run the dsh CLI synchronously and fail loudly on a non-zero exit. */
function dsh(args, options = {}) {
  const result = spawnSync(DSH_CLI, args, {
    cwd: options.cwd ?? WORKSPACE_ROOT,
    env: { ...process.env, DSH_HOME: HOME_DIR, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
  })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} failed (${result.status}):\n${(result.stderr || result.stdout).slice(-2000)}`)
  }
  return result.stdout
}

/** Resolve the cookie for the host's authenticated /api surface. */
async function authenticate(origin, token) {
  const url = new URL('/connect', origin)
  url.searchParams.set('token', token)
  url.searchParams.set('interactions', 'answer')
  const response = await fetch(url, { redirect: 'manual' })
  if (response.status !== 302) throw new Error(`/connect answered ${response.status}, expected 302`)
  return (response.headers.getSetCookie() ?? []).map((entry) => entry.split(';')[0]).join('; ')
}

/**
 * Exchange the launch token for the page (v1) cookie the way a browser does:
 * `GET /?token=…` answers 303 and sets the cookie the served index accepts.
 */
async function authorizePage(origin, token) {
  const response = await fetch(new URL(`/?token=${encodeURIComponent(token)}`, origin), { redirect: 'manual' })
  if (response.status !== 303 && response.status !== 302) throw new Error(`page token URL answered ${response.status}, expected 303`)
  return (response.headers.getSetCookie() ?? []).map((entry) => entry.split(';')[0]).join('; ')
}

/** POST one unary Remote method with the browser credential. */
async function rpc(origin, cookie, method, args) {
  const response = await fetch(new URL(`/api/${method}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: `${method}-${Date.now()}`, method, payload: { args } }),
  })
  const text = await response.text()
  const payload = JSON.parse(text)
  if (payload?.result?.ok !== true) throw new Error(`${method} failed: ${text.slice(0, 500)}`)
  return payload.result.value
}

/** Fetch one control-API path. */
async function control(origin, cookie, path, init) {
  const response = await fetch(new URL(`/api/session-workspace${path}`, origin), {
    ...init,
    headers: { cookie, origin, ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    payload = { raw: text.slice(0, 200) }
  }
  return { status: response.status, payload, text }
}

/** Read the durable workspace registry of the isolated host. */
function readWorkspaces() {
  const path = join(HOME_DIR, 'storages', 'workspace.json')
  if (!existsSync(path)) return { workspaceIds: [], workspaces: {} }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return { workspaceIds: parsed.global?.workspaceIds ?? [], workspaces: parsed.tables?.workspaces ?? {} }
}

/** Wait for the web host's startup URL on stdout. */
function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the dsh web URL')), BOOT_TIMEOUT_MS)
    let buffer = ''
    const onChunk = (chunk) => {
      buffer += chunk
      if (VERBOSE) process.stdout.write(chunk)
      const match = buffer.match(/dsh web:\s+(http:\/\/[^\s]+)/)
      if (match === undefined) return
      clearTimeout(timer)
      child.stdout.off('data', onChunk)
      const url = new URL(match[1])
      resolve({ origin: url.origin, token: url.searchParams.get('token') ?? '' })
    }
    child.stdout.on('data', onChunk)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the host exited before printing its URL (code ${code})`))
    })
  })
}

/** Stop the host's whole process group (the launcher execs Electron and forks). */
async function stopHost() {
  const pid = state.hostPid
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
  state.hostPid = undefined
}

/** Boot the isolated web host with the plugin installed and a patched composition. */
async function bootHost() {
  step('prepare isolated home and profile')
  rmSync(HOME_DIR, { recursive: true, force: true })
  mkdirSync(join(HOME_DIR, 'run-cwd'), { recursive: true })
  dsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  console.log(`    DSH_HOME  ${HOME_DIR}`)

  step('install the plugin into the isolated profile')
  const install = spawnSync('sh', [join(HERE, 'install-local.sh'), PROFILE], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, DSH_HOME: HOME_DIR, DSH_CLI },
    encoding: 'utf8',
    timeout: 240_000,
  })
  if (install.status !== 0) throw new Error(`install failed:\n${(install.stderr || install.stdout).slice(-2000)}`)
  console.log(`    ok        ${join(HOME_DIR, 'profiles', PROFILE, 'node_modules', 'dsh-session-workspace')}`)

  step('boot the web Host')
  const baseDir = join(HOME_DIR, 'workspaces')
  const overlay = join(HOME_DIR, 'control.patch.yml')
  const patch = `# isolated control-API e2e overlay
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
- id: session-workspace
  config:
    baseDir: ${baseDir}
`
  mkdirSync(HOME_DIR, { recursive: true })
  writeFileSync(overlay, patch)
  const child = spawn(DSH_CLI, ['--profile', PROFILE, '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: join(HOME_DIR, 'run-cwd'),
    env: { ...process.env, DSH_HOME: HOME_DIR },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk) => {
    if (VERBOSE) process.stderr.write(chunk)
  })
  state.hostPid = child.pid
  const { origin, token } = await waitForUrl(child)
  state.url = origin
  console.log(`    ✓ booted ${origin} (pid ${child.pid})`)
  return { origin, token, baseDir }
}

/** Run every check, always stopping the host unless --keep. */
async function main() {
  let booted
  try {
    booted = await bootHost()

    step('authenticate')
    const cookie = await authenticate(booted.origin, booted.token)
    console.log(`    ✓ cookie ${cookie.slice(0, 24)}…`)

    step('prove the plugin mounted')
    const inventory = await rpc(booted.origin, cookie, 'pluginInventory/list', {})
    const rows = inventory?.entries ?? []
    const row = rows.find((entry) => String(entry.moduleName ?? '').includes('dsh-session-workspace'))
    check('pluginMounted', row?.fiberPhase === 'active', row === undefined ? 'row not found' : `entryId=${row.entryId}`)
    state.pluginMounted = state.checks.pluginMounted === true

    step('read the control state')
    const stateBefore = await control(booted.origin, cookie, '/state')
    check('stateServed', stateBefore.status === 200, `status=${stateBefore.status}`)
    check('stateEnabledInitially', stateBefore.payload?.enabled === true, JSON.stringify(stateBefore.payload))
    state.endpoints.state = stateBefore.payload

    step('toggle isolation off')
    const off = await control(booted.origin, cookie, '/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) })
    check('toggleOffAccepted', off.status === 200 && off.payload?.enabled === false, JSON.stringify(off.payload))

    step('a new conversation passes through while off')
    const before = readWorkspaces()
    const passThrough = await rpc(booted.origin, cookie, 'session/create', { request: {} })
    const listed = await rpc(booted.origin, cookie, 'session/list', { _request: {} })
    const listedRow = (listed?.items ?? []).find((item) => item.sessionId === passThrough.sessionId)
    const afterOff = readWorkspaces()
    check('passThroughCwd', listedRow?.cwd === join(HOME_DIR, 'run-cwd'), `cwd=${listedRow?.cwd}`)
    check('noWorkspaceCreatedWhileOff', afterOff.workspaceIds.length === before.workspaceIds.length, `workspaces=${afterOff.workspaceIds.length}`)

    step('toggle isolation back on')
    const on = await control(booted.origin, cookie, '/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) })
    check('toggleOnAccepted', on.status === 200 && on.payload?.enabled === true, JSON.stringify(on.payload))

    step('a new conversation is isolated again')
    const isolated = await rpc(booted.origin, cookie, 'session/create', { request: {} })
    const isolatedList = await rpc(booted.origin, cookie, 'session/list', { _request: {} })
    const isolatedRow = (isolatedList?.items ?? []).find((item) => item.sessionId === isolated.sessionId)
    const afterOn = readWorkspaces()
    const created = Object.entries(afterOn.workspaces).find(([, workspace]) => (workspace.sessionIds ?? []).includes(isolated.sessionId))
    check('workspaceCreatedWhileOn', created !== undefined, `workspaces=${afterOn.workspaceIds.length}`)
    check('isolatedCwdMatchesWorkspace', created !== undefined && isolatedRow?.cwd === created[1].path, `cwd=${isolatedRow?.cwd}`)
    check('isolatedDirectoryExists', created !== undefined && existsSync(created[1].path), created?.[1]?.path)
    state.workspace = created === undefined ? undefined : { id: created[0], path: created[1].path, title: created[1].title, sessionId: isolated.sessionId }

    step('the browser half is published and served')
    // Index bytes accept the page cookie (`GET /?token=` → 303), not the API cookie.
    const pageCookie = await authorizePage(booted.origin, booted.token)
    const page = await fetch(new URL('/', booted.origin), { headers: { cookie: pageCookie, origin: booted.origin } })
    const html = await page.text()
    check('indexServed', page.status === 200 && html.includes('__DSH_BOOT__'), `status=${page.status} bytes=${html.length}`)
    check('bootGraphListsBrowserHalf', html.includes('dsh-session-workspace'), 'boot manifest mentions the package')
    const bundleUrls = [...html.matchAll(/["']([^"']*plugins\/\?\?[^"']*dsh-session-workspace[^"']*)["']/g)]
      .map((match) => match[1])
    check('bundleUrlAdvertised', bundleUrls.length > 0, bundleUrls[0])
    let bundleText = ''
    let bundleUrl = ''
    for (const url of bundleUrls) {
      const response = await fetch(new URL(url, booted.origin), { headers: { cookie: pageCookie, origin: booted.origin } })
      const text = await response.text()
      if (response.ok && text.includes('dsws-pill')) {
        bundleText = text
        bundleUrl = url
        break
      }
    }
    state.endpoints.bundle = bundleUrl
    check('bundleServesPillCode', bundleText.includes('dsws-pill'), bundleUrl === '' ? 'no advertised bundle carried the pill' : `url=${bundleUrl} bytes=${bundleText.length}`)

    console.log('\nE2E_CONTROL_RESULT ' + JSON.stringify({ ok: Object.values(state.checks).every(Boolean), ...state }))
  } catch (error) {
    console.error(`\nE2E_CONTROL_RESULT ${JSON.stringify({ ok: false, error: String(error?.message ?? error), ...state })}`)
    process.exitCode = 1
  } finally {
    if (!KEEP) {
      await stopHost()
      rmSync(HOME_DIR, { recursive: true, force: true })
    } else {
      console.log(`\nkept host up: ${state.url} (pid ${state.hostPid}, DSH_HOME ${HOME_DIR})`)
    }
  }
}

main()
