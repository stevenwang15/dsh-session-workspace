/**
 * dsh-session-workspace — one workspace per conversation for DeepSeek Harness.
 *
 * DSH groups conversations into Workspaces, and a Workspace is a directory: a
 * Session's recorded `cwd` is its immutable workspace-write sandbox root and
 * the key the Workspace registry uses to group it. A stock installation sends
 * every new conversation to the same `default-workspace` directory, so files
 * written in one chat are visible to the next.
 *
 * This Host plugin closes that gap: when a new conversation is created it
 * allocates a fresh directory, registers it as a Workspace, and forwards the
 * create request with that Workspace, so the new Session starts in its own
 * directory and its own sandbox root automatically. No client or model
 * cooperation is needed.
 *
 * Interception point: `ctx.sessionController.create` is the Host business
 * method behind the `session.create` Remote call the GUI's "New Session" uses.
 * The Typert gateway resolves that method per invocation
 * (`Reflect.get(receiver, name)`), so an own-property override on the service
 * instance intercepts every caller of the public method. The wrapper only
 * rewrites a new-conversation request; anything else passes through untouched,
 * and any failure of the isolation machinery falls back to the original
 * request so conversation creation never breaks.
 *
 * @module dsh-session-workspace
 */

import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-workspace'

/**
 * Both services must be composed for the plugin to activate: the Session
 * controller owns conversation creation and the Workspace registry owns
 * directory grouping. A composition without them has nothing to isolate.
 */
export const inject = ['sessionController', 'workspaceRegistry']

/**
 * The fixed first-use Workspace leaf directory owned by the Host. A Workspace
 * with this leaf is the stock "everything goes here" bucket, which is exactly
 * the target this plugin wants to replace. Kept in sync with
 * `@deepseek-ai/dsh-api-workspace-controller/default-workspace`, which cannot
 * be imported from a profile-installed plugin.
 */
const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'

/** Sibling directory (next to `default-workspace`) that holds the per-chat Workspaces. */
const MANAGED_DIRECTORY = 'session-workspaces'

/** Marks a wrapped `create` and carries the function it replaced, so reloads re-wrap cleanly. */
const ORIGINAL = Symbol('dsh-session-workspace.original')

/** Same-origin control API the browser half reads and toggles. */
export const CONTROL_PATH = '/api/session-workspace'

/** Accepted `mode` values: `managed` isolates only the stock/managed buckets, `all` isolates everything. */
const MODES = ['managed', 'all']

/**
 * Plugin settings as accepted from the profile patch row.
 *
 * @typedef {object} SessionWorkspaceConfig
 * @property {boolean} [enabled] - quick off switch; default `true`.
 * @property {'managed'|'all'} [mode] - `managed` (default) isolates new
 *   conversations that target the stock default Workspace or one this plugin
 *   already created; explicitly picked workspaces are honoured. `all` isolates
 *   every new conversation that names no explicit directory.
 * @property {string} [baseDir] - absolute directory that holds per-chat
 *   Workspaces; defaults to a `session-workspaces` sibling of the Host's
 *   `default-workspace` directory, falling back to
 *   `<home>/Documents/deepseek-harness/session-workspaces`.
 */

/**
 * Validate and normalize the plugin config.
 *
 * @param {SessionWorkspaceConfig | undefined} config - raw config from the profile patch.
 * @returns {{ enabled: boolean, mode: 'managed'|'all', baseDir: string | undefined }} normalized settings.
 * @throws {TypeError} when a value has the wrong shape; a bad install must fail loud.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') throw new TypeError('session-workspace: `enabled` must be a boolean')
  const mode = raw.mode ?? 'managed'
  if (!MODES.includes(mode)) throw new TypeError(`session-workspace: \`mode\` must be one of ${MODES.join(', ')}`)
  let baseDir = raw.baseDir
  if (baseDir !== undefined) {
    if (typeof baseDir !== 'string' || baseDir.length === 0) throw new TypeError('session-workspace: `baseDir` must be a non-empty absolute path')
    baseDir = expandHome(baseDir)
    if (!isAbsolute(baseDir)) throw new TypeError(`session-workspace: \`baseDir\` must be absolute, got ${JSON.stringify(baseDir)}`)
  }
  return { enabled, mode, baseDir }
}

/**
 * Expand a leading `~` against the current home directory.
 *
 * @param {string} value - configured path.
 * @returns {string} the path with `~` replaced by the home directory.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Canonicalize a directory path for comparison against registry paths, which are
 * always `fs.realpath` results. The leaf may not exist yet, so the nearest
 * existing ancestor is canonicalized instead; a path that cannot be resolved is
 * returned unchanged.
 *
 * @param {string} path - absolute path.
 * @returns {string} the canonical spelling when resolvable.
 */
function canonicalize(path) {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

/**
 * Report whether `candidate` is `root` or lives beneath it.
 *
 * @param {string} root - absolute directory.
 * @param {string} candidate - absolute path to test.
 * @returns {boolean} true when `candidate` is contained by `root`.
 */
function containsPath(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read the registry's durable default Workspace id. The registry exposes it only
 * in its durable global state, so this is a best-effort read with a path-based
 * fallback in {@link isDefaultWorkspace}.
 *
 * @param {any} ctx - Cordis context.
 * @returns {string | undefined} the default Workspace id when readable.
 */
function defaultWorkspaceId(ctx) {
  try {
    const id = ctx.workspaceRegistry?.state?.defaultWorkspaceId
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Report whether a Workspace is the Host's stock first-use bucket.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ id?: string, path?: string }} workspace - Workspace entity.
 * @returns {boolean} true for the default Workspace.
 */
function isDefaultWorkspace(ctx, workspace) {
  const recorded = defaultWorkspaceId(ctx)
  if (recorded !== undefined) return workspace.id === recorded
  return typeof workspace.path === 'string' && basename(workspace.path) === DEFAULT_WORKSPACE_DIRECTORY
}

/**
 * Locate the stock default Workspace in the registry, if any.
 *
 * @param {any} ctx - Cordis context.
 * @returns {any | undefined} the default Workspace entity.
 */
function findDefaultWorkspace(ctx) {
  const recorded = defaultWorkspaceId(ctx)
  if (recorded !== undefined) return ctx.workspaceRegistry.get(recorded)
  try {
    return ctx.workspaceRegistry.list().find((workspace) => isDefaultWorkspace(ctx, workspace))
  } catch {
    return undefined
  }
}

/**
 * Resolve the directory that holds per-chat Workspaces.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ baseDir?: string }} settings - normalized config.
 * @returns {string} absolute base directory.
 */
export function resolveBaseDir(ctx, settings) {
  if (settings.baseDir !== undefined) return canonicalize(settings.baseDir)
  const stock = findDefaultWorkspace(ctx)
  if (stock !== undefined && typeof stock.path === 'string') return canonicalize(join(dirname(stock.path), MANAGED_DIRECTORY))
  return canonicalize(join(homedir(), 'Documents', 'deepseek-harness', MANAGED_DIRECTORY))
}

/**
 * Build the directory leaf and display title for one new conversation.
 *
 * The leaf is local-time sortable and carries four random hex digits so two
 * creations in the same second never collide.
 *
 * @param {Date} now - creation time.
 * @param {number} attempt - retry counter that perturbs the random suffix.
 * @returns {{ leaf: string, title: string }} directory leaf and Workspace title.
 */
export function directoryPlan(now, attempt = 0) {
  const pad = (value) => String(value).padStart(2, '0')
  const y = now.getFullYear()
  const m = pad(now.getMonth() + 1)
  const d = pad(now.getDate())
  const hh = pad(now.getHours())
  const mi = pad(now.getMinutes())
  const ss = pad(now.getSeconds())
  const suffix = randomBytes(2 + attempt).toString('hex').slice(0, 4)
  return {
    leaf: `${y}${m}${d}-${hh}${mi}${ss}-${suffix}`,
    title: `${y}-${m}-${d} ${hh}:${mi}`,
  }
}

/**
 * Decide whether one `session.create` request starts a new conversation that
 * should receive its own Workspace.
 *
 * A request that names an explicit directory or an existing (blank) Session is
 * never rewritten: `cwd` means the caller chose a location, and `sessionId`
 * means the caller wants to reuse that Session in place. A request with no
 * target isolates. A request naming a Workspace isolates only when the mode
 * admits it, so an explicitly picked project Workspace keeps working.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ mode: 'managed'|'all' }} settings - normalized config.
 * @param {{ baseDir: string }} state - resolved plugin state.
 * @param {Record<string, any>} request - Session create request.
 * @returns {boolean} true when the wrapper must allocate a Workspace.
 */
export function shouldIsolate(ctx, settings, state, request) {
  if (request === undefined || request === null || typeof request !== 'object') return false
  if (request.cwd !== undefined) return false
  if (request.sessionId !== undefined) return false
  const workspaceId = request.workspaceId
  if (workspaceId === undefined) return true
  const workspace = ctx.workspaceRegistry.get(workspaceId)
  if (workspace === undefined) return false
  if (settings.mode === 'all') return true
  if (typeof workspace.path === 'string' && containsPath(state.baseDir, workspace.path)) return true
  return isDefaultWorkspace(ctx, workspace)
}

/**
 * Create the directory and the Workspace record for one conversation.
 *
 * The directory is claimed exclusively (`mkdir` without `recursive`), so a
 * leaf collision retries with a new suffix instead of sharing a workspace.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ baseDir: string }} state - resolved plugin state.
 * @returns {Promise<{ workspace: any, directory: string }>} the registered Workspace and its directory.
 */
export async function createManagedWorkspace(ctx, state) {
  await mkdir(state.baseDir, { recursive: true })
  const now = new Date()
  let directory
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = directoryPlan(now, attempt)
    const candidate = join(state.baseDir, plan.leaf)
    try {
      await mkdir(candidate)
      directory = await realpath(candidate)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      lastError = error
    }
  }
  if (directory === undefined) throw lastError ?? new Error('session-workspace: could not allocate a workspace directory')
  const { title } = directoryPlan(now, 0)
  const workspace = await ctx.workspaceRegistry.create(directory, title)
  return { workspace, directory }
}

/**
 * Discard the Workspace registered for a conversation whose creation failed.
 *
 * When the Host already published a Session for the new directory, the
 * directory and the Workspace record are kept: the Session records that
 * directory as its `cwd`, so removing either would leave a dangling location.
 * Otherwise the registration is removed and the (empty) directory is cleaned
 * up, leaving the next New Session click to start from a clean slate.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ id: string }} workspace - Workspace created for the failed attempt.
 * @param {string} directory - its directory.
 * @param {any} error - the original creation failure.
 * @returns {Promise<void>} resolves after best-effort cleanup.
 */
export async function discardFailedWorkspace(ctx, workspace, directory, error) {
  const published = typeof error?.details?.sessionId === 'string'
  if (published) {
    ctx.logger?.warn?.(`[session-workspace] a Session was published for ${directory} but the create failed; keeping that directory and its workspace registration`)
    return
  }
  try {
    await ctx.workspaceRegistry.delete(workspace.id)
  } catch (cleanupError) {
    ctx.logger?.warn?.(`[session-workspace] could not remove workspace ${workspace.id} after a failed create: ${String(cleanupError)}`)
  }
  try {
    if ((await readdir(directory)).length === 0) await rmdir(directory)
  } catch (cleanupError) {
    ctx.logger?.warn?.(`[session-workspace] could not remove empty directory ${directory}: ${String(cleanupError)}`)
  }
}

/**
 * Forward one create request to the new conversation's fresh Workspace.
 *
 * The forwarded request is the original minus its location: `cwd` would override
 * the Workspace and `sessionId` names a Session recorded elsewhere, so neither
 * can be present here (they make {@link shouldIsolate} pass the request
 * through). Every other field, including `agentPreset`, is forwarded unchanged.
 * Any failure in allocating the Workspace falls back to the original request, so
 * a broken base directory degrades to stock behaviour instead of blocking
 * creation.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ mode: 'managed'|'all' }} settings - normalized config.
 * @param {{ baseDir: string }} state - resolved plugin state.
 * @param {any} service - the Session controller service (receiver for the original method).
 * @param {Function} original - the pre-patch `create` implementation.
 * @param {Record<string, any>} request - incoming create request.
 * @param {any[]} rest - additional arguments the caller passed.
 * @returns {Promise<any>} the Host create result.
 */
async function forwardCreate(ctx, settings, state, service, original, request, rest) {
  if (!state.runtime.enabled) return Reflect.apply(original, service, [request, ...rest])
  if (!shouldIsolate(ctx, settings, state, request)) return Reflect.apply(original, service, [request, ...rest])
  let allocated
  try {
    allocated = await createManagedWorkspace(ctx, state)
  } catch (error) {
    ctx.logger?.warn?.(`[session-workspace] could not allocate an isolated workspace; falling back to the requested one: ${String(error)}`)
    return Reflect.apply(original, service, [request, ...rest])
  }
  const forwarded = { ...request, workspaceId: allocated.workspace.id }
  try {
    const value = await Reflect.apply(original, service, [forwarded, ...rest])
    ctx.logger?.info?.(`[session-workspace] session ${String(value?.sessionId)} isolated in ${allocated.directory}`)
    return value
  } catch (error) {
    await discardFailedWorkspace(ctx, allocated.workspace, allocated.directory, error)
    throw error
  }
}

/**
 * Serialize the control API's public state.
 *
 * @param {{ mode: string, baseDir?: string }} settings - normalized config.
 * @param {{ baseDir: string, runtime: { enabled: boolean } }} state - resolved plugin state.
 * @returns {{ enabled: boolean, mode: string, baseDir: string }} the state the browser half renders.
 */
function controlState(settings, state) {
  return { enabled: state.runtime.enabled, mode: settings.mode, baseDir: state.baseDir }
}

/**
 * Write one JSON response.
 *
 * @param {any} res - node:http response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON payload.
 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read one bounded JSON request body.
 *
 * @param {any} req - node:http request.
 * @param {number} [limitBytes] - maximum accepted body size.
 * @returns {Promise<unknown>} the parsed body.
 */
function readJsonBody(req, limitBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Build one JSON Fetch response. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Build the browser half's control API as exact Fetch routes.
 *
 * These ride the Connection service's authenticated `/api` surface: the Host
 * applies its own browser admission before the handler runs and refuses a
 * non-owner peer, so the plugin neither reimplements that fence nor shadows the
 * kernel's `/api` route.
 *
 * @param {{ mode: string }} settings - normalized config.
 * @param {{ runtime: { enabled: boolean } }} state - resolved plugin state.
 * @param {(message: string) => void} [log] - optional logger for state changes.
 * @returns {Array<{ path: string, methods: string[], requestBody: string, fetch: (request: Request) => Promise<Response> | Response }>} the routes to register.
 */
export function controlRoutes(settings, state, log = () => {}) {
  return [
    {
      path: `${CONTROL_PATH}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => jsonResponse(200, controlState(settings, state)),
    },
    {
      path: `${CONTROL_PATH}/enabled`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return jsonResponse(400, { error: 'invalid JSON body' })
        }
        if (typeof body?.enabled !== 'boolean') return jsonResponse(400, { error: 'enabled must be a boolean' })
        state.runtime.enabled = body.enabled
        log(`[session-workspace] automatic isolation ${body.enabled ? 'enabled' : 'disabled'} at runtime`)
        return jsonResponse(200, controlState(settings, state))
      },
    },
  ]
}

/**
 * Mount the control API through the Connection service's Fetch route registry,
 * which supplies the Host's own browser admission and owner check. A
 * composition without that registry keeps the host-only behavior and simply
 * hides the browser control.
 *
 * @param {any} ctx - Cordis context.
 * @param {{ mode: string }} settings - normalized config.
 * @param {{ runtime: { enabled: boolean } }} state - resolved plugin state.
 */
function registerControlApi(ctx, settings, state) {
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.connection
    if (typeof connection?.fetch?.register !== 'function') {
      ctx.logger?.warn?.('[session-workspace] the composed Connection exposes no Fetch route registry; the composer control stays hidden')
      return
    }
    for (const route of controlRoutes(settings, state, (message) => ctx.logger?.info?.(message))) {
      connection.fetch.register(route)
    }
    ctx.logger?.info?.(`[session-workspace] control API mounted at ${CONTROL_PATH}`)
  })
}

/**
 * Mount the plugin: wrap `ctx.sessionController.create` for the lifetime of this
 * plugin instance and restore the previous implementation on disposal.
 *
 * @param {any} ctx - Cordis context carrying `sessionController` and `workspaceRegistry`.
 * @param {SessionWorkspaceConfig} [config] - profile patch config.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger?.info?.('[session-workspace] disabled by config')
    return
  }
  const service = ctx.sessionController
  if (service === undefined || typeof service.create !== 'function') {
    throw new Error('session-workspace: the composed Session controller exposes no create method')
  }
  const existing = service.create
  const original = typeof existing[ORIGINAL] === 'function' ? existing[ORIGINAL] : existing
  const state = { baseDir: resolveBaseDir(ctx, settings), runtime: { enabled: true } }
  const wrapped = function create(request, ...rest) {
    return forwardCreate(ctx, settings, state, service, original, request, rest)
  }
  Object.defineProperty(wrapped, ORIGINAL, { value: original })
  service.create = wrapped
  registerControlApi(ctx, settings, state)
  ctx.logger?.info?.(`[session-workspace] new conversations get their own workspace under ${state.baseDir} (mode: ${settings.mode})`)
  ctx.effect(() => () => {
    if (service.create === wrapped) service.create = original
  }, 'session-workspace: restore sessionController.create')
}

/** Exported seams for the unit tests; not part of the plugin contract. */
export const internals = {
  CONTROL_PATH,
  DEFAULT_WORKSPACE_DIRECTORY,
  MANAGED_DIRECTORY,
  ORIGINAL,
  containsPath,
  controlState,
  defaultWorkspaceId,
  findDefaultWorkspace,
  isDefaultWorkspace,
}
