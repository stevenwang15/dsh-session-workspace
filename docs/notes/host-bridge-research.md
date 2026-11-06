# UI bridge research — data path + settings persistence for a third-party plugin (host-only at study start)

DSH 0.2.2-rc.1. Read from `/tmp/dsh-src/` and **executed** against an isolated Host
(`DSH_HOME=<workspace>/.bridge-research/home`, profile `web-proof`). `~/.dsh` and the live app were
never written to. No LLM tokens spent.

Proof: `.bridge-research/plugin/` (dummy plugin `dsh-bridge-proof`), `.bridge-research/proof.mjs`
(23 assertions, all passing), `.bridge-research/run-proof.sh` (curl-only), `.bridge-research/artifacts/`.

## TL;DR

| Need | Use | Why |
|---|---|---|
| GET status / POST save | `ctx.connection.fetch.register({path:'/api/<plugin>/…'})` | Host authenticates it; Fetch API; non-owner refused |
| Persist user settings | Schemastery `.volatile()` `Config` + `ctx.remote.settings.describe/update` | already served by the Host, writes the profile patch, live-applies without remount |
| Settings UI | a Client half (`dsh.client` + `client.js`); `webServer.tapIndex` as stopgap | `autoGenerate` is advisory — no shipped client renders plugin forms |

Do **not** copy `dsh-ima-copilot`'s `ctx.settings.register(...)`: that method is gone in 0.2.2-rc.1 (§3a).
## 1. Host → browser transport

**(a) raw `ctx.webServer` route — works, you own the auth.**
`ctx.inject(['webServer'], (s) => s.effect(() => s.webServer.register({kind, path, handler|resource}), 'label'))`
— `dsh-host-webserver/lib/index.js:375` (`register`), `:450` (`tapIndex`), `:576` (exact → longest
prefix → fallback). `kind: 'exact'|'prefix'`; `handler(req,res)` is raw node:http and owns the
response; `resource(request)` is Fetch-style but **GET/HEAD only** (`:599`). Duplicate `(kind,path)`
throws. **Nothing in the registry authenticates.** A prefix longer than `/api` also *shadows* the
`/api` handler — the hole `dsh-our-free-model` documents and patches (`src/trust.js:1-30`,
`index.js:1713-1760`). SSE works on a raw route (`index.js:1411-1420`, `src/push.js`).

**(b) Typert Remote namespace in SRC mode — possible without generated descriptors.** SRC derives the
descriptor at runtime (`dsh-api-gateway/lib/index.js:907-913, 1261-1330`) from: a Cordis **Service**
(gateway scans `ctx.reflect.props` for `type:'service'`); `service.typertRemote =
{service, serviceKey, namespace}` (`bindTypertRemote`/`TypertRemoteService`,
`dsh-typert-protocol/lib/index.js:326,339`); and `@Remote` markers, which are only a frozen record
under the string key `'@deepseek-ai/dsh-typert-protocol/remote-methods'` — `{version:1,
methods:[{method,invocation:{kind:'direct'}}]}` (`:315,424`). **Proven**: `POST /api/bridgeSrc/state
{"args":{}}` → `{"ok":true,"value":{"from":"src-remote",…}}`; undeclared arg →
`gateway/arguments-invalid`; no cookie → 401. Catch: step 1 needs a `Service` base, and
`import '@deepseek-ai/cordis'` fails from a profile plugin (probe: `ERR_MODULE_NOT_FOUND`; only
`@deepseek-ai/schemastery` resolves). The proof borrowed
`Object.getPrototypeOf(Object.getPrototypeOf(webServer)).constructor` — **unsupported**. Real but
not simplest.

**(c) forwarded Host events — closed.** `ctx.typertGateway.registerRemoteEvents(source, host)` is a
singleton (`dsh-api-gateway/lib/index.js:882-884`) already claimed by `@deepseek-ai/dsh-api-remotes`
(`/tmp/dsh-src/dsh-api-remotes/lib/index.js:155`; entry at `.bridge-research/dump.txt:518`), whose
forward list is a compile-time array (`:21`). A plugin cannot add an event name.

**Recommended transport — authenticated exact Fetch route** (`dsh-client-connection/lib/index.js:732`
`connection.fetch`, `:840` `registerFetchRoute`; served from the `/api` handler after `admit()`,
`:1044-1058`; `403` for non-owner peers, `:830-833`):

```js
ctx.inject(['connection'], (s) => s.effect(() => s.connection.fetch.register({
  path: '/api/session-workspace/state',   // must be under /api (assertFetchRoute)
  methods: ['GET', 'POST'], requestBody: 'buffered',
  fetch: async (request, peer) => Response.json({ ok: true }),
}), 'session-workspace: state route'))
```
## 2. Client → host authentication for custom routes

`webServer` checks no cookie/Host/Origin; the canonical fence is
`const admission = ctx.get('connection').admit(req)` → `{peer}` or `{rejection:401|403}`
(`dsh-client-connection/lib/index.js:742-750`). It already covers `isAuthenticated` (page cookie),
`authenticateApi` (API cookie) and the Host/Origin fence (`:777`), so you reimplement neither. The
handler receives `peer.principal.kind === 'owner'`, `peer.interactions === 'answer'` (observed in
`trace.log`). Two cookie kinds matter: `GET /?token=` mints the **v1 page cookie** (serves
`index.html` only, `:458`); `GET /connect?token=…&interactions=answer` mints the **v2 API cookie**
(`:505`). `/api` accepts both (`:746-748`). `connection.fetch` routes need **zero** plugin auth code:

```
$ curl -b jar http://127.0.0.1:51682/api/bridge-proof/state      → 200 {"route":"connection.fetch",…}
$ curl        http://127.0.0.1:51682/api/bridge-proof/state      → 401 unauthorized
$ curl -b jar -H 'origin: http://evil.example' …/plugin/bridge-proof/state → 403 forbidden  # raw route + fence
```

Same-origin browser `fetch()` needs no CORS work: no preflight, `SameSite=Strict` cookie rides, `Origin` matches.
## 3. Settings persistence, ranked

**(a) `ctx.settings` — recommended.** `SettingsForms` (`dsh-settings/lib/index.js`) serves every
active profile entry whose Schemastery `Config` has ≥1 `.volatile()` node (`:122 volatileForm`,
`:413 describe`), keyed by **profile entry id**. No registration, no opt-in — a third-party row just
appears:

```js
import z from '@deepseek-ai/schemastery'   // peerDependency; resolves in the profile
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  mode: z.union([z.const('managed'), z.const('all')]).default('managed').volatile(),
  baseDir: z.string().default('').volatile(),
})
// POST /api/settings/describe {"args":{}}
//   → {"ns":"bridge-proof","autoGenerate":true,"applies":"live","value":{…},"base":{…},"user":{},"revision":0}
// POST /api/settings/update {"args":{"ns":"bridge-proof","patch":{"mode":"all"},"expectedRevision":0}}
//   → ok:true, value.mode:"all", user:{"mode":"all"}
```

* Persists to the **profile patch** (`$DSH_HOME/profiles/<p>/cordis.patch.yml`) via
  `configEditor.edit()` (`dsh-config-editor/lib/index.js:69-120`); observed on disk as
  `- id: bridge-proof / config: {mode: all}` and it survives restart. Home/CLI overrides are refused.
* Live apply: a **volatile-only** change does *not* re-run `apply`; the loader commits into the
  existing reference and emits `loader/volatile-update` (`cordis-plugin-loader/lib/index.js:412,515,
  526-560`). Read `config.mode.get()`, not `config.mode`. Proven: 1 × apply, 1 × volatile-update.
* Any non-volatile field change = ordinary config change → the entry is disposed and re-applied (no
  process restart, but `apply` re-runs — keep registrations effect-scoped).
* **Trap:** 0.2.2-rc.1 `ctx.settings` exposes only `configure/describe/update/replace/mutate`
  (probed live). `dsh-ima-copilot/lib/index.js:119-121` calls `ctx.settings.register(...)`, which is
  gone → throws. Feature-detect.
* The wire schema strips `meta.volatile` (`dsh-settings/lib/types/schema.js:22`), so a client cannot
  tell which fields are live. `autoGenerate` is advisory ("no shipped client does so yet",
  `dsh-settings/README.md`) — ship a page, and call `configure({auto:false}, ctx.fiber)`.

**(b) `ctx.configEditor`** — `entries()` `:30`, `configuration()` `:39`, `documentPath` `:24`,
`edit(entry, change)` `:69`. Edits your own row safely (settings wraps exactly this), but you
re-implement volatile filtering, revisions and redaction. Use only for complete non-volatile config.

**(c) `dsh-plugin-manager`** — no config API: `listPlugins`/`listBundles`/`updateBundle`/
`setVersionExemption` only (`lib/typert.host.js:1292-1327`). Unusable.

**(d) plugin JSON store** — `dsh-our-free-model/src/store.js:24-120`: `$DSH_HOME` else `~/.dsh`, temp
file + rename, corrupt backup. Precedence there: static config = defaults, JSON = overrides, merged
per read (proven: `effective = {...config, ...store}`, re-read each request). Cheap and restart-safe,
but invisible to the harness UI and you own validation/migration. Good for high-cardinality state
(recent workspaces), not for the three settings fields.

**Recommendation:** `enabled`/`mode`/`baseDir` → volatile `Config` + `ctx.settings`; recent-workspace
list → JSON store or derive it from `workspaceRegistry` on demand.
## 4. Proof

* `.bridge-research/plugin/` — volatile `Config`; raw route `/plugin/bridge-proof/state`;
  authenticated Fetch route `/api/bridge-proof/state`; SRC service `bridgeSrc/{state,save}`;
  `tapIndex` script; JSON store.
* `.bridge-research/proof.mjs`, `run-proof.sh`, `artifacts/` (`proof-run.txt`, `index.html`,
  `rpc-settings-{describe,update}{,-response}.json`). Install (isolated): copy `plugin/` to
  `home/profiles/web-proof/node_modules/dsh-bridge-proof`, copy
  `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/{schemastery,cosmokit}` beside it, append
  `dsh-bridge-proof` to `dsh.profile.bundles`; `dsh --profile web-proof --dump-config` then lists it.

```
$ cd …/.bridge-research && node proof.mjs        # → ALL ASSERTIONS PASSED, pgrep -fl web-proof → (empty)
[1] boot ✓   [2] /connect ✓ 302 + v2 cookie
[3] raw route ✓ 200 {"config":{"enabled":true,"mode":"managed","baseDir":""}}   [4] no cookie ✓ 401   [5] evil Origin ✓ 403
[6] /api fetch route ✓ 200 route:"connection.fetch"                             [7] no cookie ✓ 401
[8] settings.describe ✓ 22 namespaces, ns=bridge-proof rev 0 applies=live
[9] settings.update ✓ value.mode="all" user={"mode":"all"}   [10] patch on disk ✓ config: mode: all
[11] stale revision ✓ settings/conflict   [12] bogus field ✓ settings/rejected
[13] SRC remote ✓ 200 {"from":"src-remote"}   [C7] no cookie ✓ 401, undeclared arg ✓ refused
[14] POST store ✓ file written   [15] effective = store over config
[16] tapIndex ✓ <script id="bridge-proof-ui"> inside GET / (v1 page cookie)
[17] live apply ✓ 1× apply, 1× loader/volatile-update paths=[["mode"]]
[18] cold restart ✓ mode=all (patch) + baseDir (JSON) both survived
```

Hygiene: `--no-open --port 0`, `DSH_HOME` pinned, kill via
`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, then `pgrep -fl web-proof` empty.
## 5. Risks + minimal design

* **Shadowing `/api`** — a raw prefix longer than `/api` bypasses admission. Use `connection.fetch`,
  or fence every raw route with `connection.admit`; never mount both for the same path.
* **Non-owner remote clients** — Fetch routes 403 them; Remote/SRC calls are decided by
  `ctx.remoteAccess` (`dsh-api-gateway` `prepareInvocation`). Never trust `sec-fetch-site` alone.
* **Version fragility** — `connection.fetch`, `admit`, `settings.describe/update` are 0.2.x internals
  and the settings seam already changed shape once. Feature-detect and degrade to JSON store + a
  fenced raw route instead of throwing in `apply`. Keep every editable field volatile: one
  non-volatile field turns each save into a full dispose + re-apply.
* **Two writers, one key** — one owner per field (settings patch *or* JSON store). **`tapIndex` is
  global** — inject a bootstrap pointer only, never peer data, into `index.html`.

Minimal design: (1) volatile `Config` for the three fields; (2) read via `.get()` and re-derive on
`ctx.on('loader/volatile-update', …)`; (3) `GET /api/session-workspace/state` +
`POST /api/session-workspace/open` through `connection.fetch.register`; (4) persist with
`settings.update(ns, patch, expectedRevision)` — never write `cordis.patch.yml` yourself; (5) UI as a
Client half (`dsh:{client:{platform:'web'}}`, `exports["./client"]`) registering into
`settings.section` / `settings.plugin.item` and calling `ctx.remote.settings` (or `ctx.configForms`).
## 6. Not verified

* Browser Client half calling `ctx.remote.settings` / registering a slot (documented, server-side
  proven, no client bundle built); a declared `@deepseek-ai/cordis` dependency giving a usable `Service`.
* Non-owner Peer behaviour on Fetch routes (`:830-833`; this Host only hands out owner peers) and the
  `dsh plugin add file:<dir>` install path (the proof copied the package into the profile instead).
