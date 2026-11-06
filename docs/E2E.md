# E2E harness: real Host boot → `session.create` → state assertions

This directory contains a dependency-free harness that proves the plugin works on a
**real DeepSeek Harness Host boot**, not a mock:

| file | what it is |
| --- | --- |
| [`e2e-remote.mjs`](./e2e-remote.mjs) | the harness (Node ≥ 20 ESM, no npm dependencies) |
| [`run-e2e.sh`](./run-e2e.sh) | thin wrapper with the CLI path and defaults |

It never touches the live app: the Host it drives is a **separate process with its own
`DSH_HOME`**, so the running desktop app under `~/.dsh` is untouched.

---

## Quick start

```sh
cd $REPO

./scripts/run-e2e.sh                    # isolate a new session (bare `{}` create)
./scripts/run-e2e.sh --mode workspace   # create targeting the stock default Workspace
./scripts/run-e2e.sh --mode cwd --expect created   # explicit cwd must pass through
./scripts/run-e2e.sh --keep             # leave the Host up; then: --attach <url>
./scripts/run-e2e.sh --verbose          # stream the Host log while it boots
node scripts/e2e-remote.mjs --help      # every option
```

Default locations (all inside the workspace, safe to delete):

```
<workspace>/.e2e/home           isolated DSH_HOME (profile, storages, sessions, logs)
<workspace>/.e2e/home/e2e.patch.yml   generated --patch overlay
<workspace>/.e2e/workspaces     per-conversation workspaces created by the plugin
```

A successful run ends with exit code 0 and one machine-readable last line:

```
E2E_RESULT {"ok":true,"sessionId":"session-7c7b548f-…","workspaceId":"9afdc8b4-…","workspacePath":"…/.e2e/workspaces/20261106-201038-c01a","error":null,…}
```

`ok:false` sets exit code 1 and reports the failing checks in `checks` / `error`.

---

## What a run does

1. **Isolated home + profile** — creates `$DSH_HOME/profiles/<profile>` from a shipped
   template (`dsh <profile> --from-default-profile web --dump-config`), reusing it when
   it already exists.
2. **Install the plugin** — copies the package into the profile's `node_modules`,
   records a `file:` dependency, and leaves the profile's bundle list alone.
3. **Generate the `--patch` overlay** — a two-line YAML insert naming the plugin row.
4. **Preflight** — runs `--dump-config` and fails early unless the composed tree really
   contains that row id (catches YAML/patch mistakes before a 15-second boot).
5. **Boot** — `dsh <profile> --patch <overlay> --no-open --port 0`, Host stdout/stderr go
   to a log file, and the harness waits for the printed authenticated URL.
6. **Authenticate** — `GET /connect?token=…&interactions=answer`, capture the cookie.
7. **Prove the plugin mounted** — `POST /api/pluginInventory/list`, look for our
   `moduleName` with `fiberPhase: "active"`.
8. **Resolve the default Workspace** — read `storages/workspace.json`; call
   `workspace/initializeDefault` when the Host has none yet.
9. **Call `session.create`** — `POST /api/session/create` with the exact envelope the
   GUI sends.
10. **Read durable state** — `storages/workspace.json`,
    `storages/session_projcache/sessions/<id>.json`, `sessions/<escaped-cwd>/<id>/`,
    plus a `session/list` query through the Host API.
11. **Assert** — see [Assertions](#assertions).
12. **Stop the Host** — SIGTERM, SIGKILL after a grace period (skipped with `--keep`).

It never calls `session.prompt`, so a run spends **zero model tokens**.

---

## The transport contract (verified against the shipped build)

### 1. URL line and flags

`dsh web --help` offers `--host`, `--port` (`0` = OS picks a free one), `--no-open`,
`--public-url`, `--trusted-host`, `--tls-cert/--tls-key`. The web runtime prints exactly
one line once the loader has settled and the startup audit passed:

```
dsh web: http://127.0.0.1:50809/?token=SsM50vQWML8OG-W7mQOd5SFcS3uBWJhG9LNMZfhzrGM
```

`--no-open` is what keeps a browser window from appearing; `--port 0` is what makes
parallel runs safe (the printed URL carries the real port).

### 2. Auth: `/connect` exchanges the launch token for a signed cookie

```http
GET /connect?token=<TOKEN>&interactions=answer HTTP/1.1
Host: 127.0.0.1:50809

HTTP/1.1 302 Found
location: ./api/remote.mux
set-cookie: dsh-auth-<authority-hash>=v2.<base64url-payload>.<hmac>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

The cookie is an **API** credential (`version 2` payload carrying an operator id), which
is why it can be replayed on `/api` requests. `interactions=answer` is required for
streaming/event forwarding; `none` is enough for unary calls. A plain `fetch` with
`redirect: 'manual'` plus `headers.getSetCookie()` is all the client needs.

### 3. Unary RPC: plain HTTP POST under `/api`

The connection layer bridges `POST /api/<namespace>/<method>` — the same endpoint the
browser's fetch transport uses. No WebSocket is needed for unary methods (the
`/api/remote.mux` socket, which is where `/connect` redirects, carries the streaming
methods such as `session/observeState` and `workspace/follow`).

Request:

```json
{
  "type": "client-request",
  "rpcId": "e2e-1793967038194-d4809a",
  "method": "session/create",
  "payload": { "args": { "request": {} } }
}
```

Response:

```json
{
  "type": "server-response",
  "rpcId": "e2e-1793967038194-d4809a",
  "result": { "ok": true, "value": { "sessionId": "session-7c7b548f-d6f9-4b02-ae26-1fbc1c861740", "agentPreset": "standard" } }
}
```

Three details cost time to discover, so they are worth stating plainly:

* **`payload` has exactly one key: `args`.** A bare payload is rejected.
* **`args` keys are the generated parameter names, not positional values.** `create(request)`
  needs `{"request": {…}}`; a bare `{}` fails with
  `gateway/arguments-invalid … missing "request"`. Request-less methods (`list(signal)`)
  want `{"_request": {}}`. The harness retries `{}` → `{_request:{}}` so it works with
  either spelling.
* **`method` must equal the path endpoint**, else `gateway/bad-request`.
* `content-type: application/json` is mandatory (415 otherwise), and the `/api` trust
  fence wants a loopback `Host` plus a matching `Origin` — normal browser behaviour.

Failures ride the same envelope, which is why they are easy to assert on:

```json
{"type":"server-response","rpcId":"probe-1","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/create: args fields do not match the descriptor: missing \"request\"","details":{"endpoint":"session/create"}}}}
```

### 4. Remote namespaces that matter here

| endpoint | args | notes |
| --- | --- | --- |
| `session/create` | `{"request":{}}`, `{"request":{"workspaceId":"…"}}`, `{"request":{"cwd":"…"}}` | returns `{sessionId, agentPreset?}` |
| `session/list` | `{"_request":{}}` | returns `{items:[{sessionId, cwd, projections:{values:{workingDirectory, agentPreset, …}}}]}` |
| `workspace/initializeDefault` | `{}` | idempotent; returns `{workspace:{workspaceId, path, title, sessionIds, …}}` |
| `pluginInventory/list` | `{}` | returns `{entries:[{entryId, moduleName, enabled, fiberPhase}], …}` |
| `workspace/list` | — | **404, not exposed.** Read `storages/workspace.json` instead. |

`pluginInventory/list` is the cheapest hard proof that a patch row actually mounted:

```json
{"entryId":"include:dsh-session-workspace","moduleName":"dsh-session-workspace","enabled":true,"fiberPhase":"active"}
```

(`moduleName` is the package name for a profile-installed plugin, or the `file://…` URL
when the row is inserted by URL.)

---

## Profile, patch and install mechanics

**Create a profile from a shipped template.** `--from-default-profile` *replaces* the
profile with a fresh copy of the template, so pair it with `--dump-config` to create
without booting:

```sh
DSH_HOME=$PWD/.e2e/home "$DSH_CLI" \
  ws-e2e --from-default-profile web --dump-config
```

**The `--patch` overlay** is a top-level YAML array; `insert` with a unique id appends a
row. This is exactly what the harness writes:

```yaml
- insert:
    - id: dsh-session-workspace
      name: 'dsh-session-workspace'
      config: {"baseDir":"/…/.e2e/workspaces"}
```

`--dump-config` echoes the applied overlays at the tail, so a preflight can assert on
`^- id: <row>$` before paying for a boot.

**Row `name` resolution — the one real gotcha.** The loader imports `row.name` against the
profile directory. Measured behaviour:

| row `name` | bare imports inside the plugin (`@deepseek-ai/schemastery`, …) | verdict |
| --- | --- | --- |
| `'dsh-session-workspace'` (copy in profile `node_modules`) | ✅ resolve to the installation's copies | **recommended** |
| `'file:///abs/path/index.js'` | ❌ `ERR_MODULE_NOT_FOUND` | only for plugins with `node:` builtins only |
| symlink at `node_modules/<pkg>` → plugin dir | ❌ resolves through realpath, fails | avoid |

So `--install copy` (the default) copies the package into
`$DSH_HOME/profiles/<profile>/node_modules/<pkg>` and records
`"<pkg>": "file:/abs/path"` in the profile's `package.json`. It needs no network and no
pnpm. `--install file-url` works for a plugin without bare imports (this plugin imports
only `node:` builtins, and it was verified green that way too).

**Alternative: install as a bundle.** `dsh plugin --profile <name> add file:/abs/path`
works offline (pnpm hard-links from a local store, ~250 ms) and adds the package to
`dsh.profile.bundles`, after which the package's own `cordis.patch.yml` inserts its row.
Two caveats found by trying it: on a **missing** profile it initializes one from the
*base* template only (no web app), and it drops a `.pnpm-store/` in the current
directory. The harness therefore creates the profile first and then uses the copy route,
so a run has no side effects outside its own `DSH_HOME`.

---

## State written by the Host (what the harness asserts on)

`$DSH_HOME/storages/workspace.json` — real excerpt from a verified run:

```json
{
  "global": {
    "initialized": true,
    "workspaceIds": ["9afdc8b4-ffa2-4acc-a58c-37fd0afa6f15", "e77acd63-6a1a-4d8f-947b-1bc517edf5a9"],
    "defaultWorkspaceId": "e77acd63-6a1a-4d8f-947b-1bc517edf5a9"
  },
  "tables": {
    "workspaces": {
      "e77acd63-…": { "path": "/…/default-workspace", "title": "default-workspace", "sessionIds": [] },
      "9afdc8b4-…": {
        "path": "/…/.e2e/workspaces/20261106-201038-c01a",
        "title": "2026-11-06 20:10",
        "sessionIds": ["session-7c7b548f-d6f9-4b02-ae26-1fbc1c861740"]
      }
    }
  }
}
```

The registry writes this file **synchronously** during the create, so the new session is
already listed when the RPC returns. Note that the stock Host creates **no** Workspace on
boot (`workspaceIds` is empty until something calls `workspace.initializeDefault`), which
is why the harness initializes one explicitly.

`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` — the projection cache;
`record.identity.cwd` is the session's immutable sandbox root (flushed shortly *after*
the create, so the harness polls):

```json
{ "version": 7, "record": { "identity": { "formatVersion": 4, "createdAt": 1793967038200,
  "cwd": "/…/.e2e/workspaces/20261106-201038-c01a", "isSeeded": false } } }
```

`$DSH_HOME/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd` — the durable session
log; the directory name encodes the session's cwd, e.g.
`--Users-zichenwang-…-default-workspace-.e2e-workspaces-20261106-201038-c01a--`.

---

## Assertions

`--expect` selects the bar; the default `auto` is `isolated` for a package named
`dsh-session-workspace` and `created` otherwise.

| check | meaning |
| --- | --- |
| `sessionCreated` | the RPC returned a `sessionId` |
| `pluginMounted` | `pluginInventory/list` shows our row `active` (skipped if the composition has no inventory) |
| `cwdRecorded` | the Host recorded a cwd (projection cache, else `session/list`) |
| `cwdMatchesWorkspace` | that cwd equals the Workspace directory the session landed in |
| `attached` | some Workspace in `workspace.json` lists the session id |
| `isolated` | that Workspace's path differs from `defaultWorkspaceId`'s path |
| `directoryExists` | the workspace directory really exists on disk |

Verified matrix (each run exit 0, against this plugin):

| `--mode` | payload | result |
| --- | --- | --- |
| `bare` (default) | `{"request":{}}` | new workspace `…/session-workspaces/2026…`, session attached, `isolated:true` |
| `workspace` | `{"request":{"workspaceId":"<default>"}}` | same: targeting the stock default is rewritten |
| `cwd` | `{"request":{"cwd":"/tmp/…"}}` | pass-through: cwd honoured, **not** attached, `isolated:false` |

---

## Caveats and troubleshooting

* **No credentials or model config are needed for `session.create`.** A fresh isolated
  home with no `.credentials.yaml` creates sessions fine. Only `session/prompt` (never
  called here) would need a model and credentials.
* **Boot takes ~10–16 s**; the URL line appears only after the loader settles, so do not
  shorten `--boot-timeout` below ~60 s.
* **An Electron `codesign` ERROR line on stderr is normal** on macOS and lands in the log:
  `[ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: …`.
* **`--keep` leaves an orphan Host by design**; stop it with the `hostPid` from
  `E2E_RESULT` (`kill -- -<pid>` kills its process group, `kill <pid>` the leader).
  `--attach <url>` drives that same Host without rebooting — pass the matching `--home`
  so state can be read.
* **Ports**: `--port 0` lets the OS choose; the printed URL is authoritative.
* **Per-run workspaces accumulate** under `.e2e/workspaces` (one directory per create).
  Delete `.e2e` to start clean; the harness recreates everything.
* **Bare `--port` + non-loopback bind** would need `--trusted-host` for the `/api` fence;
  the harness always binds loopback.
* If a run fails, the Host log path is printed and included in `E2E_RESULT.log`; the last
  40 lines are echoed on boot failures.
* `kill -0` / recorded PIDs are used instead of `ps` lookups, which a file sandbox may
  block.

### If HTTP RPC ever stops working

Unary calls are confirmed to work over `POST /api/<ns>/<method>` on this build. The
fallback is the WebSocket mux at `/api/remote.mux` (the `/connect` redirect target),
which speaks the same `client-request` / `server-response` envelopes inside a
`{type:'server-response'}` wrapper. A dependency-free WebSocket client is not part of
Node core; the `ws` module shipped inside the app bundle
(`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/ws`)
can be imported by absolute path, or the whole flow can run in-process through
`@deepseek-ai/dsh-app-boot` with a fake transport — neither was necessary here.

---

## Safety notes

* Never points at `~/.dsh`; `--home` refuses the live home explicitly.
* Owns only the child it spawns: it spawns the Host `detached` (own process group) and
  signals the **group** with SIGTERM, then SIGKILL after 10 s, always in a `finally`
  (also on `SIGINT`/`SIGTERM` of the harness itself). This matters: the `dsh` launcher
  `exec`s an Electron binary that can fork a same-command-line helper, so signalling only
  the direct child leaks a Host — verified fixed by checking `pgrep -fl ws-e2e` after a run.
* Everything it writes stays under `<workspace>/.e2e/` (or the `--home` you pass).
* The plugin's own `baseDir` defaults to a sibling of the Host's `default-workspace`,
  which would fall outside the workspace — so the harness passes
  `config.baseDir=<workspace>/.e2e/workspaces` unless you supply `--plugin-config`
  (`--plugin-config '{}'` exercises the plugin's real default).
