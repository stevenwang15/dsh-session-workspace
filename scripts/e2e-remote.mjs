#!/usr/bin/env node
/**
 * e2e-remote.mjs — end-to-end proof harness for a DSH Host plugin.
 *
 * Boots a REAL DeepSeek Harness web Host in an isolated DSH_HOME (never the
 * live `desktop` profile under ~/.dsh), loads the plugin under test through a
 * generated `--patch` overlay, authenticates against the Host's own `/connect`
 * token exchange, invokes the `session.create` Remote RPC over plain HTTP
 * (`POST /api/session/create`) — the exact call the GUI's "New Session" makes —
 * and then asserts on durable Host state under `$DSH_HOME/storages/`.
 *
 * No external dependencies, no LLM tokens: it never calls `session.prompt`.
 *
 * Usage:
 *   node scripts/e2e-remote.mjs [options]
 *   DSH_HOME=/tmp/x node scripts/e2e-remote.mjs --profile ws-e2e --keep
 *
 * Options (env var in brackets):
 *   --home <dir>          isolated DSH_HOME      [DSH_E2E_HOME]   default <workspace>/.e2e/home
 *   --profile <name>      profile to boot        [DSH_E2E_PROFILE] default ws-e2e
 *   --template <name>     shipped profile copied when creating it   default web
 *   --plugin <path>       plugin dir or entry file [DSH_E2E_PLUGIN] default <workspace>/dsh-session-workspace
 *   --plugin-name <name>  package name when package.json is unavailable
 *   --entry-id <id>       row id for the inserted patch entry (default: the package name)
 *   --plugin-config <json> config object for the inserted patch row
 *   --port <n>            listen port, 0 = OS picks [DSH_E2E_PORT]  default 0
 *   --dsh <path>          dsh CLI               [DSH_CLI]        default the shipped app CLI
 *   --install <mode>      copy | symlink | file-url | skip          default copy
 *   --mode <mode>         bare | workspace | cwd | raw              default bare
 *   --workspace-id <id>   use this Workspace id instead of the default one
 *   --cwd <dir>           cwd for --mode cwd (default: a fresh temp dir)
 *   --args <json>         full RPC args object for --mode raw (e.g. '{"request":{}}')
 *   --expect <what>       auto | created | attached | isolated       default auto
 *   --attach <url>        skip boot; drive an already-running host URL (with token)
 *   --keep                leave the Host running after the run
 *   --log <file>          host log path (default <home>/logs/host-<ts>.log)
 *   --boot-timeout <ms>   default 180000
 *   --rpc-timeout <ms>    default 30000
 *   --verbose             stream the Host log to stdout
 *   --no-preflight        skip the `--dump-config` composition check
 *   --help
 *
 * Output: human-readable progress, then one machine-readable last line:
 *   E2E_RESULT {"ok":true,"sessionId":"session-…","workspaceId":"…","workspacePath":"…"}
 *
 * Exit code: 0 when every assertion passed, 1 otherwise (and on any failure).
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ────────────────────────────────────────────────────────────────────────────
// constants and helpers
// ────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..')
const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const paint = (code) => (text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const bold = paint('1')
const dim = paint('2')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')

let STEP = 0
function section(title) {
  STEP += 1
  process.stdout.write(`\n${bold(`[${STEP}]`)} ${bold(title)}\n`)
}
function info(label, value) {
  process.stdout.write(`    ${dim(label.padEnd(18))} ${value}\n`)
}
function ok(label, value = '') {
  process.stdout.write(`    ${green('✓')} ${label}${value === '' ? '' : ` ${dim(value)}`}\n`)
}
function bad(label, value = '') {
  process.stdout.write(`    ${red('✗')} ${label}${value === '' ? '' : ` ${dim(value)}`}\n`)
}
function note(text) {
  process.stdout.write(`    ${dim(text)}\n`)
}

function fail(message, extra) {
  const error = new Error(message)
  if (extra !== undefined) error.details = extra
  throw error
}

/** Last `n` lines of a text blob, for error reporting. */
function tailOf(text, n = 40) {
  const lines = String(text ?? '').split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/** Run a child to completion synchronously and return {status, stdout, stderr}. */
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env: options.env ?? process.env,
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) {
    return { status: -1, stdout: result.stdout ?? '', stderr: `${result.error.message}`, error: result.error }
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Signal a whole process group.
 *
 * `dsh` is a shell launcher that `exec`s an Electron binary, which can fork a
 * helper with the same command line. Killing only the direct child therefore
 * leaks a Host, so the harness spawns the Host `detached` (making it its own
 * process-group leader) and signals the group.
 */
function signalTree(pid, signal) {
  if (pid === undefined) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/** Single-quote a scalar for YAML. */
function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Resolve a package's entry module from its manifest. */
function resolveEntry(dir, manifest) {
  const exportsField = manifest?.exports
  let relative
  if (typeof exportsField === 'string') relative = exportsField
  else if (exportsField?.['.'] !== undefined) {
    const dot = exportsField['.']
    relative = typeof dot === 'string' ? dot : (dot.import ?? dot.default ?? dot.node)
  }
  relative ??= manifest?.main ?? 'index.js'
  return path.resolve(dir, relative)
}

// ────────────────────────────────────────────────────────────────────────────
// command line
// ────────────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['keep', 'verbose', 'help', 'no-preflight', 'json'])

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) fail(`unexpected argument ${JSON.stringify(token)} (every option starts with --)`)
    let key = token.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq !== -1) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(key)) value = true
      else {
        value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) fail(`--${key} needs a value`)
        i += 1
      }
    }
    opts[key] = value
  }
  return opts
}

const USAGE = `e2e-remote.mjs — boot an isolated DSH web Host, load a plugin, call session.create, assert state.
Run with --help to see every option (this file's header comment is the full reference).`

function buildConfig(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    // The file header is the single source of truth for the option list.
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const header = source.match(/^(?:#![^\n]*\n)?\/\*\*([\s\S]*?)\*\//u)
    process.stdout.write(
      header === null
        ? `${USAGE}\n`
        : `${header[1]
            .split('\n')
            .map((line) => line.replace(/^\s*\* ?/u, ''))
            .join('\n')
            .trim()}\n`,
    )
    process.exit(0)
  }
  const env = process.env
  const home = path.resolve(opts.home ?? env.DSH_E2E_HOME ?? path.join(WORKSPACE_ROOT, '.e2e', 'home'))
  const plugin = path.resolve(opts.plugin ?? env.DSH_E2E_PLUGIN ?? path.join(WORKSPACE_ROOT, 'dsh-session-workspace'))
  const port = Number(opts.port ?? env.DSH_E2E_PORT ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be an integer 0..65535, got ${opts.port}`)

  return {
    home,
    profile: opts.profile ?? env.DSH_E2E_PROFILE ?? 'ws-e2e',
    template: opts.template ?? 'web',
    plugin,
    pluginName: opts['plugin-name'] ?? env.DSH_E2E_PLUGIN_NAME,
    entryId: opts['entry-id'],
    pluginConfig: opts['plugin-config'],
    port,
    dsh: opts.dsh ?? env.DSH_CLI ?? DEFAULT_DSH,
    install: opts.install ?? 'copy',
    mode: opts.mode ?? 'bare',
    workspaceId: opts['workspace-id'],
    cwd: opts.cwd,
    argsJson: opts.args,
    expect: opts.expect ?? 'auto',
    attach: opts.attach,
    keep: opts.keep === true,
    log: opts.log,
    bootTimeoutMs: Number(opts['boot-timeout'] ?? 180000),
    rpcTimeoutMs: Number(opts['rpc-timeout'] ?? 30000),
    verbose: opts.verbose === true,
    preflight: opts['no-preflight'] !== true,
    workRoot: path.join(home, '..'),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// host log follower (file-backed: the Host keeps running even after we exit)
// ────────────────────────────────────────────────────────────────────────────

class LogTail {
  constructor(file, verbose) {
    this.file = file
    this.verbose = verbose
    this.offset = 0
    this.text = ''
  }

  /** Read whatever the Host appended since the last call. */
  pump() {
    let stat
    try {
      stat = fs.statSync(this.file)
    } catch {
      return ''
    }
    if (stat.size <= this.offset) return ''
    const length = stat.size - this.offset
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(this.file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, this.offset)
    } finally {
      fs.closeSync(fd)
    }
    this.offset = stat.size
    const chunk = buffer.toString('utf8')
    this.text += chunk
    if (this.verbose) process.stdout.write(chunk)
    return chunk
  }

  /** Wait for a regex match in the accumulated log, failing on timeout or child exit. */
  async waitFor(patterns, { timeoutMs, label, child }) {
    const list = Array.isArray(patterns) ? patterns : [patterns]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      this.pump()
      for (const pattern of list) {
        const match = this.text.match(pattern)
        if (match !== null) return match
      }
      if (child !== undefined && child.exitCode !== null) {
        fail(`the Host exited (code ${child.exitCode}) before ${label}.\n--- host log tail ---\n${tailOf(this.text)}`)
      }
      await sleep(120)
    }
    fail(`timed out after ${timeoutMs}ms waiting for ${label}.\n--- host log tail ---\n${tailOf(this.text)}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// steps
// ────────────────────────────────────────────────────────────────────────────

/** Read-only plugin identity, for `--attach` runs that install nothing. */
function readPluginIdentity(cfg) {
  const stat = fs.existsSync(cfg.plugin) ? fs.statSync(cfg.plugin) : undefined
  if (stat === undefined) return cfg.pluginName ?? null
  const dir = stat.isDirectory() ? cfg.plugin : path.dirname(cfg.plugin)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) return cfg.pluginName ?? null
  return readJson(manifestPath).name ?? cfg.pluginName ?? null
}

/** Create the isolated profile from a shipped template when it does not exist yet. */
function ensureProfile(cfg) {
  const profDir = path.join(cfg.home, 'profiles', cfg.profile)
  const manifestPath = path.join(profDir, 'package.json')
  if (fs.existsSync(manifestPath)) {
    info('profile', `${profDir} ${dim('(exists)')}`)
    return { created: false, dir: profDir }
  }
  fs.mkdirSync(cfg.home, { recursive: true })
  const args = [cfg.profile, '--from-default-profile', cfg.template, '--dump-config']
  const result = runSync(cfg.dsh, args, { env: { ...process.env, DSH_HOME: cfg.home }, timeout: 180000 })
  if (result.status !== 0 || !fs.existsSync(manifestPath)) {
    fail(
      `could not create profile '${cfg.profile}' from template '${cfg.template}'.\n` +
        `command: ${cfg.dsh} ${args.join(' ')} (DSH_HOME=${cfg.home})\n` +
        `exit: ${result.status}\n--- stdout ---\n${tailOf(result.stdout, 30)}\n--- stderr ---\n${tailOf(result.stderr, 30)}`,
    )
  }
  info('profile', `${profDir} ${dim(`(created from '${cfg.template}' template)`)}`)
  return { created: true, dir: profDir }
}

/**
 * Make the plugin importable from the profile.
 *
 * DSH resolves a patch row's `name` against the profile directory, and Node
 * resolves the plugin's own bare imports from the plugin's real path. A plugin
 * living outside the profile therefore cannot import `@deepseek-ai/*` — the
 * `copy` install (profile `node_modules/<pkg>` + a `file:` dependency entry) is
 * the arrangement that gives both.
 */
function installPlugin(cfg, profileDir) {
  const stat = fs.existsSync(cfg.plugin) ? fs.statSync(cfg.plugin) : undefined
  if (stat === undefined) fail(`plugin path does not exist: ${cfg.plugin}`)
  const pluginDir = stat.isDirectory() ? cfg.plugin : path.dirname(cfg.plugin)
  const manifestPath = path.join(pluginDir, 'package.json')
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {}
  const name = manifest.name ?? cfg.pluginName
  if (typeof name !== 'string' || name.length === 0) fail(`cannot determine the plugin package name; pass --plugin-name. Looked in ${manifestPath}`)
  const entry = resolveEntry(pluginDir, manifest)
  if (!fs.existsSync(entry)) fail(`plugin entry module not found: ${entry}`)

  const facts = { name, dir: pluginDir, entry, manifest, installedPath: undefined, specifier: name }

  if (cfg.install === 'file-url') {
    facts.specifier = pathToFileURL(entry).href
    note(`install: file-url — the row names ${facts.specifier}`)
    note('bare imports inside the plugin will NOT resolve from there; use --install copy for that.')
    return facts
  }
  if (cfg.install === 'skip') {
    note('install: skip — assuming the plugin is already resolvable from the profile')
    return facts
  }

  const nodeModules = path.join(profileDir, 'node_modules')
  const dest = path.join(nodeModules, name)
  // Guard: dest must be exactly <profile>/node_modules/<pkg>, never a computed surprise.
  if (path.dirname(dest) !== nodeModules || path.basename(dest) !== name) fail(`refusing to install into ${dest}`)
  fs.mkdirSync(nodeModules, { recursive: true })

  if (cfg.install === 'symlink') {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.symlinkSync(pluginDir, dest, 'dir')
    note('install: symlink — rewrites in place, but the plugin cannot then resolve bare imports')
  } else if (cfg.install === 'copy') {
    const staging = `${dest}.e2e-staging`
    fs.rmSync(staging, { recursive: true, force: true })
    fs.cpSync(pluginDir, staging, {
      recursive: true,
      dereference: false,
      filter: (source) => {
        const leaf = path.basename(source)
        return leaf !== '.git' && leaf !== '.DS_Store'
      },
    })
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(staging, dest)
  } else {
    fail(`unknown --install mode ${JSON.stringify(cfg.install)} (copy | symlink | file-url | skip)`)
  }
  facts.installedPath = dest

  // Record it as a dependency so the profile stays self-describing.
  const profManifestPath = path.join(profileDir, 'package.json')
  const profManifest = fs.existsSync(profManifestPath) ? readJson(profManifestPath) : { name: `dsh-profile-${cfg.profile}`, private: true }
  profManifest.dependencies ??= {}
  profManifest.dependencies[name] = `file:${pluginDir}`
  writeJson(profManifestPath, profManifest)

  info('plugin', `${name}@${manifest.version ?? '0.0.0'}`)
  info('source', pluginDir)
  info('installed', `${dest} ${dim(`(${cfg.install})`)}`)
  return facts
}

/** Write the `--patch` overlay that inserts the plugin row. */
function writePatch(cfg, facts, home) {
  const id = cfg.entryId ?? facts.name
  const patchPath = cfg.patchPath ?? path.join(home, 'e2e.patch.yml')
  let config = cfg.pluginConfig
  if (config !== undefined && typeof config === 'string') {
    try {
      config = JSON.parse(config)
    } catch (error) {
      fail(`--plugin-config is not valid JSON: ${error.message}`)
    }
  }
  const lines = [
    `# Generated by scripts/e2e-remote.mjs at ${new Date().toISOString()}.`,
    '# Applied after the profile layer, so this row mounts in addition to whatever',
    '# the profile already composes. Safe to delete: regenerated on every run.',
    '- insert:',
    `    - id: ${id}`,
    `      name: ${yamlString(facts.specifier)}`,
  ]
  if (config !== undefined && config !== null && Object.keys(config).length > 0) {
    lines.push(`      config: ${JSON.stringify(config)}`)
  }
  fs.mkdirSync(path.dirname(patchPath), { recursive: true })
  fs.writeFileSync(patchPath, `${lines.join('\n')}\n`)
  info('patch', patchPath)
  info('row', `id=${id} name=${facts.specifier}`)
  if (config !== undefined && Object.keys(config).length > 0) info('config', JSON.stringify(config))
  return { patchPath, entryId: id }
}

/** Verify the composed profile tree actually contains our row before booting. */
function preflight(cfg, patchPath, entryId) {
  const args = [cfg.profile, '--patch', patchPath, '--dump-config']
  const result = runSync(cfg.dsh, args, { env: { ...process.env, DSH_HOME: cfg.home }, timeout: 120000 })
  if (result.status !== 0) {
    fail(
      `--dump-config failed, the patch overlay is not loadable.\n` +
        `command: ${cfg.dsh} ${args.join(' ')}\n` +
        `exit: ${result.status}\n--- stderr ---\n${tailOf(result.stderr, 30)}`,
    )
  }
  const present = new RegExp(`^- id: ${entryId.replaceAll('.', '\\.')}$`, 'm').test(result.stdout)
  if (!present) {
    fail(
      `the composed profile does not list the row '${entryId}'; the patch was ignored.\n` +
        `--- dump-config tail ---\n${tailOf(result.stdout, 20)}`,
    )
  }
  const entries = (result.stdout.match(/^- id: /gm) ?? []).length
  ok('composition', `row '${entryId}' present, ${entries} entries composed`)
}

/** Spawn the Host and wait for its printed authenticated URL. */
async function bootHost(cfg, patchPath) {
  const logFile = cfg.log ?? path.join(cfg.home, 'logs', `host-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.log`)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')

  const args = [cfg.profile, '--patch', patchPath, '--no-open', '--port', String(cfg.port)]
  info('command', `${path.basename(cfg.dsh)} ${args.join(' ')}`)
  info('DSH_HOME', cfg.home)
  info('log', logFile)

  const child = spawn(cfg.dsh, args, {
    // Own process group, so cleanup can signal the launcher AND any helper it forks.
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, DSH_HOME: cfg.home },
  })
  fs.closeSync(fd)
  child.on('error', (error) => info('spawn-error', error.message))

  const tail = new LogTail(logFile, cfg.verbose)
  const match = await tail.waitFor([/dsh web:\s+(\S+)/], {
    timeoutMs: cfg.bootTimeoutMs,
    label: 'the authenticated URL line ("dsh web: http://…/?token=…")',
    child,
  })
  const url = match[1]
  const parsed = new URL(url)
  const token = parsed.searchParams.get('token')
  if (token === null) fail(`the URL printed by the Host carries no ?token=: ${url}`)
  ok('booted', `${parsed.origin} (pid ${child.pid})`)
  return { child, logFile, tail, url, origin: parsed.origin, token }
}

/** Exchange the launch token for a signed browser-session cookie. */
async function authenticate(baseUrl, token) {
  const url = new URL('/connect', baseUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('interactions', 'answer')
  let last = 'no attempt'
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
      const location = response.headers.get('location') ?? ''
      if (response.status === 302 && location.includes('api/remote.mux')) {
        const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
        const raw = cookies.length > 0 ? cookies : [response.headers.get('set-cookie') ?? '']
        const cookie = raw.map((value) => value.split(';')[0]).filter((value) => value.length > 0).join('; ')
        if (cookie === '') fail('the /connect redirect carried no Set-Cookie header')
        return cookie
      }
      last = `status ${response.status} location ${JSON.stringify(location)}`
    } catch (error) {
      last = error.message
    }
    await sleep(250)
  }
  fail(`/connect did not issue a session cookie (last: ${last})`)
}

/** POST one unary Remote RPC to /api/<namespace>/<method>. */
async function rpc(cfg, session, method, args) {
  const endpoint = new URL(`/api/${method}`, session.baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      origin: new URL(session.baseUrl).origin,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, method, payload: { args } }),
    signal: AbortSignal.timeout(cfg.rpcTimeoutMs),
  })
  const text = await response.text()
  if (response.status === 404) fail(`${method}: 404 — no Remote endpoint is registered at ${endpoint.pathname} for this composition`)
  if (!text.startsWith('{')) fail(`${method}: HTTP ${response.status} with a non-JSON body: ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

/** Call a method whose generated parameter name we may not know (`{}` vs `{_request:{}}`). */
async function callWithArgs(cfg, session, method, candidates) {
  let envelope
  for (const args of candidates) {
    envelope = await rpc(cfg, session, method, args)
    if (envelope.result?.ok === true) return envelope
    const message = envelope.result?.error?.message ?? ''
    if (!/args fields do not match|missing "/u.test(message)) return envelope
  }
  return envelope
}

/** Read `$DSH_HOME/storages/workspace.json`. */
function readWorkspaceState(home) {
  const file = path.join(home, 'storages', 'workspace.json')
  if (!fs.existsSync(file)) return undefined
  const data = readJson(file)
  const ids = data.global?.workspaceIds ?? []
  const tables = data.tables?.workspaces ?? {}
  const workspaces = ids.map((id) => {
    const row = tables[id] ?? {}
    return {
      id,
      path: row.path,
      title: row.title,
      sessionIds: Array.isArray(row.sessionIds) ? [...row.sessionIds] : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  })
  // Tolerate a table row that exists but is missing from workspaceIds.
  for (const [id, row] of Object.entries(tables)) {
    if (!ids.includes(id)) workspaces.push({ id, path: row.path, title: row.title, sessionIds: [...(row.sessionIds ?? [])] })
  }
  return {
    file,
    initialized: data.global?.initialized === true,
    defaultWorkspaceId: data.global?.defaultWorkspaceId,
    archivedSessionIds: data.global?.archivedSessionIds ?? [],
    workspaces,
  }
}

/** Read the per-session projection caches under storages/session_projcache/sessions/. */
function readProjectionCaches(home) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const leaf of fs.readdirSync(dir)) {
    if (!leaf.endsWith('.json')) continue
    const file = path.join(dir, leaf)
    try {
      const data = readJson(file)
      const identity = data.record?.identity ?? {}
      out.push({
        file,
        leaf,
        sessionId: leaf.replace(/\.json$/u, ''),
        cwd: identity.cwd,
        createdAt: identity.createdAt,
        sizeBytes: fs.statSync(file).size,
      })
    } catch (error) {
      out.push({ file, leaf, sessionId: leaf.replace(/\.json$/u, ''), parseError: error.message })
    }
  }
  return out
}

/** Locate the durable per-session log directory under `$DSH_HOME/sessions/`. */
function readSessionLogs(home, sessionId) {
  const root = path.join(home, 'sessions')
  if (!fs.existsSync(root)) return undefined
  for (const group of fs.readdirSync(root)) {
    const dir = path.join(root, group, sessionId)
    if (!fs.existsSync(dir)) continue
    const files = fs
      .readdirSync(dir)
      .map((leaf) => ({ leaf, bytes: fs.statSync(path.join(dir, leaf)).size }))
      .sort((a, b) => a.leaf.localeCompare(b.leaf))
    return { group, dir, files }
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = buildConfig(process.argv.slice(2))
  const outcome = {
    ok: false,
    sessionId: null,
    workspaceId: null,
    workspacePath: null,
    error: null,
    home: cfg.home,
    profile: cfg.profile,
    plugin: null,
    pluginMounted: null,
    sessionCwd: null,
    expect: null,
    mode: cfg.mode,
    attached: null,
    isolated: null,
    url: null,
    hostPid: null,
    log: null,
    sessionLog: null,
    checks: {},
  }
  let child

  const cleanup = async () => {
    if (child === undefined) return
    if (cfg.keep) {
      child.unref()
      info('kept', `host stays up: pid ${child.pid}, ${outcome.url}`)
      note(`stop it later with: kill -- -${child.pid}  (its process group; plain 'kill ${child.pid}' also works)`)
      return
    }
    if (child.exitCode !== null) return
    signalTree(child.pid, 'SIGTERM')
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && child.exitCode === null) await sleep(100)
    if (child.exitCode === null) {
      signalTree(child.pid, 'SIGKILL')
      const hardDeadline = Date.now() + 3000
      while (Date.now() < hardDeadline && child.exitCode === null) await sleep(100)
      if (child.exitCode === null) note(`warning: process group ${child.pid} did not exit`)
      else note(`stopped process group ${child.pid} (SIGKILL)`)
    } else {
      note(`stopped process group ${child.pid} (SIGTERM)`)
    }
  }

  // Interrupts must not leave a stray Host behind.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void cleanup().finally(() => {
        process.stdout.write(`E2E_RESULT ${JSON.stringify({ ...outcome, ok: false, error: `interrupted by ${signal}` })}\n`)
        process.exit(130)
      })
    })
  }

  try {
    if (cfg.attach !== undefined) {
      // Nothing is installed in attach mode, but the inventory check still needs
      // the package name to recognise the mounted row.
      outcome.plugin = readPluginIdentity(cfg)
      outcome.url = cfg.attach
      info('attach', cfg.attach)
      return await runAgainstHost(cfg, outcome, { url: cfg.attach, child: undefined })
    }

    section('isolated home and profile')
    info('DSH_HOME', cfg.home)
    if (path.resolve(cfg.home) === path.resolve(path.join(os.homedir(), '.dsh'))) {
      fail('refusing to run against the live ~/.dsh home; pass --home with an isolated directory')
    }
    fs.mkdirSync(cfg.home, { recursive: true })
    const profile = ensureProfile(cfg)

    section('install the plugin into the profile')
    const facts = installPlugin(cfg, profile.dir)
    outcome.plugin = facts.name

    section('write the --patch overlay')
    // This plugin's own default `baseDir` is a sibling of the Host's
    // `default-workspace`, which for this harness would land outside the
    // writable workspace. Point it inside the isolated .e2e tree unless the
    // caller chose a config; `--plugin-config '{}'` restores the real default.
    if (cfg.pluginConfig === undefined && facts.name === 'dsh-session-workspace') {
      cfg.pluginConfig = JSON.stringify({ baseDir: path.join(cfg.workRoot, 'workspaces') })
      note('default plugin config: baseDir kept inside the isolated .e2e tree')
    }
    const { patchPath, entryId } = writePatch(cfg, facts, cfg.home)

    section('preflight the composition')
    if (cfg.preflight) preflight(cfg, patchPath, entryId)
    else note('skipped (--no-preflight)')

    section('boot the Host')
    const host = await bootHost(cfg, patchPath)
    child = host.child
    outcome.hostPid = child.pid
    outcome.log = host.logFile
    outcome.url = host.url
    return await runAgainstHost(cfg, outcome, { url: host.url, child, tail: host.tail })
  } catch (error) {
    outcome.ok = false
    outcome.error = error.message
    // The verdict line at the end of the run reports this; keep multi-line detail here.
    if (error.message.includes('\n')) note(error.message.split('\n').slice(1).join('\n'))
    return outcome
  } finally {
    // Runs before the caller sees the returned outcome, and also on a throw, so
    // a failed run cannot leave a Host behind.
    await cleanup()
  }
}

/** Everything that happens against a booted Host: auth, RPC, state, assertions. */
async function runAgainstHost(cfg, report, { url, child, tail }) {
  const parsed = new URL(url)
  const token = parsed.searchParams.get('token')
  if (token === null) fail('the Host URL carries no ?token=')
  const baseUrl = `${parsed.origin}/`

  section('authenticate over /connect')
  const cookie = await authenticate(baseUrl, token)
  ok('cookie', `${cookie.split('=')[0]}=… ${dim(`(${cookie.length} bytes)`)}`)
  const session = { baseUrl, cookie }
  report.url = url

  section('prove the plugin mounted (pluginInventory/list)')
  let inventory
  try {
    const envelope = await callWithArgs(cfg, session, 'pluginInventory/list', [{}, { _request: {} }])
    inventory = envelope.result?.ok === true ? envelope.result.value : undefined
  } catch (error) {
    note(`pluginInventory unavailable (${error.message.split('\n')[0]})`)
  }
  if (inventory === undefined) {
    report.pluginMounted = null
    note('no plugin inventory in this composition; mount proof falls back to boot success only')
  } else {
    const entries = inventory.entries ?? []
    const mine = entries.filter((entry) => entry.moduleName === report.plugin || String(entry.moduleName ?? '').includes(report.plugin))
    report.pluginMounted = mine.some((entry) => entry.fiberPhase === 'active')
    info('inventory', `${entries.length} entries, ${mine.length} matching '${report.plugin}'`)
    for (const entry of mine) info('row', `id=${entry.entryId} phase=${entry.fiberPhase} enabled=${entry.enabled}`)
    if (report.pluginMounted) ok('mounted', mine.map((entry) => entry.entryId).join(', '))
    else bad('not mounted', `no active entry whose moduleName matches '${report.plugin}'`)
  }

  section('resolve the default Workspace')
  let workspaces = readWorkspaceState(cfg.home)
  let defaultId = workspaces?.defaultWorkspaceId
  if (defaultId === undefined) {
    const envelope = await callWithArgs(cfg, session, 'workspace/initializeDefault', [{}, { _request: {} }])
    if (envelope.result?.ok === true) {
      defaultId = envelope.result.value?.workspace?.workspaceId
      info('initializeDefault', `created ${defaultId}`)
    } else {
      note(`workspace/initializeDefault: ${envelope.result?.error?.message ?? 'failed'}`)
    }
    await sleep(300)
    workspaces = readWorkspaceState(cfg.home)
    defaultId ??= workspaces?.defaultWorkspaceId
  } else {
    info('defaultWorkspaceId', defaultId)
  }
  if (workspaces !== undefined) info('workspaces', `${workspaces.workspaces.length} registered`)
  if (cfg.mode === 'workspace' && (cfg.workspaceId ?? defaultId) === undefined) {
    fail('--mode workspace needs a Workspace id, but the Host has none and initializeDefault failed')
  }

  section('call session.create over POST /api/session/create')
  const args = buildCreateArgs(cfg, defaultId)
  info('payload', JSON.stringify(args))
  const envelope = await rpc(cfg, session, 'session/create', args)
  if (envelope.type !== 'server-response') fail(`unexpected envelope type ${JSON.stringify(envelope.type)}`)
  if (envelope.result?.ok !== true) {
    const error = envelope.result?.error ?? {}
    fail(`session.create failed: ${error.code ?? 'unknown'} ${error.message ?? ''} ${JSON.stringify(error.details ?? {})}`)
  }
  const value = envelope.result.value ?? {}
  report.sessionId = value.sessionId ?? null
  if (report.sessionId === null) fail(`session.create returned no sessionId: ${JSON.stringify(value)}`)
  ok('created', report.sessionId)
  if (value.agentPreset !== undefined) info('agentPreset', value.agentPreset)
  info('raw result', JSON.stringify({ type: envelope.type, rpcId: envelope.rpcId, result: envelope.result }).slice(0, 900))

  section('read durable Host state')
  // The workspace file is written synchronously by the registry; poll briefly for
  // the same-ms race and for any async flush after the create returns. A run
  // that does not expect an attachment only needs a short grace period.
  const expectation = resolveExpectation(cfg, report)
  const attempts = expectation === 'created' && cfg.mode === 'bare' ? 8 : 40
  let state
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = readWorkspaceState(cfg.home)
    if (state !== undefined) {
      const owner = state.workspaces.find((workspace) => workspace.sessionIds.includes(report.sessionId))
      if (owner !== undefined) break
    }
    await sleep(250)
  }
  // Projection caches are flushed on their own schedule; poll briefly instead of
  // treating an early miss as failure (session/list is the cross-check).
  let caches = []
  let cache
  for (let attempt = 0; attempt < 24; attempt += 1) {
    caches = readProjectionCaches(cfg.home)
    cache = caches.find((entry) => entry.sessionId === report.sessionId)
    if (cache !== undefined) break
    await sleep(250)
  }

  if (state === undefined) {
    bad('workspace.json', 'not found')
  } else {
    ok('workspace.json', `${state.file} ${dim(`(${state.workspaces.length} workspaces)`)}`)
    info('defaultWorkspaceId', state.defaultWorkspaceId ?? '(none)')
    info('initialized', String(state.initialized))
    for (const workspace of state.workspaces) {
      const mark = workspace.sessionIds.includes(report.sessionId) ? green(' ← new session') : ''
      process.stdout.write(`    ${dim('•')} ${workspace.id}\n`)
      process.stdout.write(`        path       ${workspace.path}\n`)
      process.stdout.write(`        title      ${workspace.title ?? '(none)'}\n`)
      process.stdout.write(`        sessionIds ${JSON.stringify(workspace.sessionIds)}${mark}\n`)
    }
    const owner = state.workspaces.find((workspace) => workspace.sessionIds.includes(report.sessionId))
    if (owner !== undefined) {
      report.workspaceId = owner.id
      report.workspacePath = owner.path
      report.attached = true
      ok('attached', `${owner.id} → ${owner.path}`)
      const defaultPath = state.workspaces.find((workspace) => workspace.id === state.defaultWorkspaceId)?.path
      report.isolated = defaultPath === undefined ? null : path.resolve(owner.path ?? '') !== path.resolve(defaultPath)
    } else {
      report.attached = false
      report.isolated = false
      note('the new session is not attached to any Workspace (session.create without workspaceId, no plugin rewrite)')
    }
  }

  if (cache === undefined) {
    note(`no projection cache for ${report.sessionId} yet under storages/session_projcache/sessions/ — falling back to the Host API`)
  } else {
    ok('projection cache', `${cache.leaf} ${dim(`(${cache.sizeBytes} bytes)`)}`)
    info('recorded cwd', cache.cwd ?? '(none)')
    report.sessionCwd = cache.cwd ?? null
  }

  const logs = readSessionLogs(cfg.home, report.sessionId)
  if (logs === undefined) {
    note('no session log directory yet under $DSH_HOME/sessions/ (written on the first turn)')
  } else {
    ok('session log', `${logs.dir}`)
    for (const file of logs.files) info(file.leaf, `${file.bytes} bytes`)
    report.sessionLog = logs.dir
  }

  // Cross-check against the Host's own query surface.
  section('query the Host API (session/list)')
  try {
    const listing = await callWithArgs(cfg, session, 'session/list', [{}, { _request: {} }])
    const items = listing.result?.ok === true ? (listing.result.value?.items ?? []) : []
    const found = items.find((item) => item.sessionId === report.sessionId)
    info('sessions', String(items.length))
    if (found === undefined) bad('session/list', `does not list ${report.sessionId}`)
    else {
      ok('session/list', `cwd=${found.cwd ?? '(none)'} preset=${found.projections?.values?.agentPreset ?? '?'}`)
      info('workingDirectory', found.projections?.values?.workingDirectory ?? '(none)')
      report.checks.sessionListCwd = found.cwd ?? null
      report.sessionCwd ??= found.cwd ?? null
    }
  } catch (error) {
    note(`session/list unavailable: ${error.message.split('\n')[0]}`)
  }

  section('assertions')
  return judge(cfg, report, { state, cache, caches })
}

/** Build the `session.create` args for the selected mode. */
function buildCreateArgs(cfg, defaultId) {
  if (cfg.mode === 'raw') {
    if (cfg.argsJson === undefined) fail('--mode raw needs --args \'{"request":{...}}\'')
    try {
      return JSON.parse(cfg.argsJson)
    } catch (error) {
      fail(`--args is not valid JSON: ${error.message}`)
    }
  }
  if (cfg.mode === 'bare') return { request: {} }
  if (cfg.mode === 'workspace') return { request: { workspaceId: cfg.workspaceId ?? defaultId } }
  if (cfg.mode === 'cwd') {
    const cwd = cfg.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-cwd-'))
    return { request: { cwd } }
  }
  fail(`unknown --mode ${JSON.stringify(cfg.mode)} (bare | workspace | cwd | raw)`)
  return undefined
}

/** Resolve `--expect auto` into a concrete expectation for this plugin. */
function resolveExpectation(cfg, report) {
  if (cfg.expect !== 'auto') return cfg.expect
  return String(report.plugin).includes('session-workspace') ? 'isolated' : 'created'
}

/** Turn the collected facts into the pass/fail verdict. */
function judge(cfg, report, { state, cache, caches }) {
  const expected = resolveExpectation(cfg, report)
  report.expect = expected

  const checks = {}
  checks.sessionCreated = typeof report.sessionId === 'string'
  checks.cwdRecorded = typeof report.sessionCwd === 'string' && report.sessionCwd.length > 0
  if (checks.cwdRecorded && typeof report.workspacePath === 'string') {
    // The recorded cwd is the session's immutable sandbox root: it must be the
    // workspace directory the creation landed in.
    checks.cwdMatchesWorkspace = path.resolve(report.sessionCwd) === path.resolve(report.workspacePath)
  }
  if (report.pluginMounted !== null) checks.pluginMounted = report.pluginMounted

  if (expected === 'attached') checks.attached = report.attached === true
  if (expected === 'isolated') {
    checks.attached = report.attached === true
    checks.isolated = report.isolated === true
    // An isolated session must live somewhere other than the default workspace
    // path, and that directory must really exist on disk.
    const exists = report.workspacePath !== null && report.workspacePath !== undefined && fs.existsSync(report.workspacePath)
    checks.directoryExists = exists
    if (exists) {
      note(`workspace directory exists: ${report.workspacePath}`)
      try {
        const leaves = fs.readdirSync(report.workspacePath)
        note(`  ${leaves.length} entries inside`)
      } catch {
        /* unreadable is not fatal */
      }
    }
  }

  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key)
  for (const [key, value] of Object.entries(checks)) {
    if (value === true) ok(key, '')
    else bad(key, '')
  }
  if (expected === 'created') {
    note('expected: created — the session exists and the Host recorded its cwd')
    note('pass --expect isolated to require a fresh per-session Workspace, or --expect attached for any Workspace')
  }

  report.checks = { ...report.checks, ...checks }
  report.ok = failed.length === 0
  if (!report.ok) report.error = `failed checks: ${failed.join(', ')}`
  return report
}

// ────────────────────────────────────────────────────────────────────────────

const result = await main()
process.stdout.write(`\n${bold('E2E_RESULT')} ${JSON.stringify(result)}\n`)
note(`host log: ${result.log ?? '(none)'}`)
if (!result.ok) {
  process.stderr.write(`\n${red('FAILED')} ${result.error}\n`)
  process.exitCode = 1
}
