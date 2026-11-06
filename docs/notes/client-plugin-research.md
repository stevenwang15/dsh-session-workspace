# Browser-side UI for a third-party DSH plugin — verified research

Target: DSH **0.2.2-rc.1** (release commit `c59d10a`), live profile `desktop`, isolated proof profile `web-test`.
All findings below were read from this installed version and/or executed; anything not executed is marked **UNVERIFIED**.
Extracted sources: `/tmp/dsh-src/<pkg>` (regenerate with `python3 /tmp/extract_asar.py "dsh/node_modules/@deepseek-ai/<pkg>" /tmp/dsh-src/<pkg>`).
Proof artifacts: `$WORKSPACE/.ui-research/` (`proof-plugin/`, `run-proof.sh`, `verify-client-bundle.mjs`, `logs/`, `index.html`, `served-client.js`).

## 0. TL;DR

A plugin ships a browser half with **three package.json additions + one file**:

1. `exports["./client"]` → a `.js` file;
2. `dsh.client = { "platform": "web" }` (optional `inject`, `external`, `immediately`);
3. a bundle-patch Loader row whose `name` is the **bare package name** (any host row — an empty `apply` is enough);
4. `client.js` in the **`window.__ModuleLoader__.load({id, factory})`** lazy-CJS shape — hand-written is fine, **no build step and no bundled React**: `require('react')` resolves from the shell's frozen platform seed table.

The settings surface is `ctx.slots.register({name:'settings.section', id, order, label, locale}, Component)`. Persisting settings natively needs the Host plugin to export a Schemastery `Config` with `.volatile()` fields; the client then writes through `ctx.configForms.get('<entryId>')`.

Everything was proven end-to-end on an isolated host, including a real `settings.mutate` write landing in the profile patch — see §5.

## 1. Packaging: what must ship

`@deepseek-ai/dsh-client-modules` turns a **Loader entry** into a served bundle. The host half scans Loader entries, locates the entry's package manifest by the row's own module resolution, reads `dsh.client`, and resolves `exports["./client"]`:

- manifest parse: `/tmp/dsh-src/dsh-client-modules/lib/index.js:86` (`dsh.client.platform` must be a string; `inject`/`external` string arrays; `immediately` boolean).
- entry build: `…/lib/index.js:783` — `decl.platform !== 'web'` ⇒ ignored; `dsh.client` without `exports["./client"]` ⇒ **hard error** `declares dsh.client but exports no "./client" bundle`; the bundle path is `join(dirname(pkgJson), clientRel)`, i.e. **served from the installed package in the profile's `node_modules`** (`:200` accepts a string or `{default: string}`).
- `/plugins` route: prefix route registered on `webServer`, `resource: request => this.fetchBundle(request)` (`:622`); request matching at `:1095` accepts only advertised combo URLs / current-revision chunks, everything else `404`.

Real packages confirm the same contract:

| package | `dsh.client` | `exports["./client"]` | host row |
|---|---|---|---|
| `dsh-our-free-model` 2.8.0 (`$DSH_HOME/profiles/desktop/node_modules/dsh-our-free-model/package.json:121-130`) | `{platform:'web', immediately:true, inject:[]}` | `./client.js` | `cordis.patch.yml` `insert` row `name: 'dsh-our-free-model'` **bare** |
| `dsh-ima-copilot` 0.2.3 (`…/dsh-ima-copilot/package.json` exports + `dsh.client.inject:[connection, settings-plugins]`) | `{platform:'web', inject:[…]}` (arrival ordering — still parsed in 0.2.2) | `./lib/client.js` (tsdown output) | row `name: dsh-ima-copilot` |
| `dsh-whale-widget` 0.4.2 | **none** (no client half at all; it injects HTML via `webserver/index-inject` instead) | — | row `name: dsh-whale-widget` |

Notes that matter:

- A **client-only package still needs a Loader row**: the official `ui-settings-plugins` README says its host half is “an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for”. Free-model's patch comment says the same: the browser half binds to the row whose name is the bare package name, “subpath rows do not carry a half”.
- `dsh.client.inject` = packages whose graph rows must **arrive first** (ordering, not `require`); `dsh.client.external` = non-seed module requests answered by another dynamic row or a seed-table key. Browser side: `…/dsh-client-modules/lib/client.js:780-792`.
- `immediately: true` = prefetch the bundle right after boot (`prefetchImmediateTier`, `/tmp/dsh-src/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`). Omit it for a lazily used settings page.
- **No `dsh.client` field is required for a Host-only plugin** — our current package is correct as-is; adding the field is what turns on the browser half.

## 2. Bundle format & build

**Format (must be pre-wrapped; plain ESM is not loaded).** The page never does `import(url)`: the index injects `<script src="plugins/…/client.js?rev=…">` rows (`bootInjections`, `…/lib/index.js:518`), and each script must register a factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-our-free-model',            // must equal the package name
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')     // answered by the platform seed table
    // …components…
    function apply(ctx) { /* ctx.slots / ctx.locale / … */ }
    exports.apply = apply
    exports.inject = ['slots', 'locale']   // client cordis services; blocks apply until present
    exports.name = 'our-free-model'
    return module.exports
  },
})
```

Evidence: hand-written bundle `$DSH_HOME/profiles/desktop/node_modules/dsh-our-free-model/client.js:1-31` (its header says “Hand-written ModuleLoader bundle: no build step, no dependency beyond the `react` the shell already provides”); official tsdown output has the identical wrapper, only with `require("react")`/`require("react/jsx-runtime")` (`…/dsh-ima-copilot/lib/client.js:1-10`).

**Platform seed table** (exact, from the shipped shell, `YZ()` in `index-BgUyXZcc.js:196`):
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`.
Anything else throws `require("<x>") missed the module table` (`…/client.js:842`) unless declared in `dsh.client.external` and supplied by another active row. Never bundle React — a second React copy breaks hooks.

Exports are memoized per factory; the module system calls `factory(require)` lazily (`…/client.js:819`), so CSS injection must live inside the factory.

**Service surface on `ctx` (client cordis)**: `slots` (registration), `locale` (`register/bind`), `modules` (module-system entry ledger), `configForms`/`remote` (settings), `theme`, `shortcuts`, `connection`, plus package services the plugin itself injects. Evidence: free-model `exports.inject=['slots','locale']`; `ctx.configForms` (`/tmp/dsh-src/dsh-client-ui-settings/lib/client.js:1265-1315`); `ctx.theme` (`/tmp/dsh-src/dsh-client-ui-theme/README.md:12,28`).

**Minimal viable authoring path** (recommended, and what the proof uses): hand-write `client.js` with `React.createElement`, no JSX, no bundler, no TypeScript. If types are wanted later, adopt the official `tsdown` preset and keep the same `lib/client.js` output; that adds a build dependency and the `dsh.client` fields stay identical. Hand-written is the lowest-risk path for an open-source plugin because the only runtime contract is the seed table + slot options.

## 3. UI extension points (0.2.2-rc.1)

Slot inventory harvested from every installed client bundle (names are stable string ids; `kind`/`scope` from the declaring package):

| area | slot | kind / scope | props delivered |
|---|---|---|---|
| Settings page | `settings.section` | list / root | `{close}` + registration `inject` |
| Settings nav icon | `settings.section.icon` | list / root | `{size, active}` (`dsh-client-ui-settings/README.md:47`) |
| Settings extras | `settings.header`, `settings.action`, `settings.close`, `settings.trigger`, `settings.onboarding`, `settings.launcher`, `settings.general.item` | list/single | — |
| Plugin tabs | `settings.plugins.tab` | list / root | `dsh-client-ui-settings-plugins/README.md:30` |
| Composer accessories | `conversation.input.left`, `conversation.input.right`, `conversation.input.dock`, `conversation.input.overlay` | list / session | `{locked}` / `{}` |
| Composer takeover | `conversation.composer` | **chain** (`select`) | `matched` + runtime props |
| Composer bar / activity | `conversation.composer.bar` (single), `conversation.input.activity` (single, expands between model picker and Send) | session | `dsh-client-ui-conversation/README.md:185` |
| Session row buttons | `sidebar.workspaces.session.row.action` | list / session | `{sessionId, displayTitle}` |
| Session row menu | `sidebar.workspaces.session.menu.item` | list / session | `{sessionId, displayTitle}` |
| Session row decor | `sidebar.session.row.leading/.trailing/.hover` | list / root-scoped, `{sessionId}` only | `dsh-client-ui-workspace/README.md:108` |
| Panels/toasts | `main` (keyed, `main.conversation` single), `sidebar.right.pane.tab`, `shell.overlay`, `workspace.toast` | keyed/single/list | — |

Slot kinds are declared by the owning package via `children: { '<slot>': { kind, scope } }` — e.g. `/tmp/dsh-src/dsh-client-ui-conversation/lib/client.js:22970-22985`. **There is no `actions.newSession` slot in this version**; the workspace/session seats above are the real ones.

**Registration contract** (both a declaration wait and a register):

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'session-workspace',       // required for list slots; becomes the nav id
  order: 40,                     // ascending; official General is 0, free-model 35
  label: () => t('nav'),         // string or () => string, resolved by resolveSlotLabel
  locale: NS,                    // dictionary namespace for the slot label/t seat
  // inject: () => ({ ...props }), // optional factory merged into the component props
  // children: { ... }             // only when the occupant itself hosts sub-slots
}, Section))
```

The shell builds the nav from `ctx.slots.entries('settings.section')` sorted by `order` (`/tmp/dsh-src/dsh-client-ui-settings-general/lib/client.js:1434-1441`) and renders the active one with `{close}` (`:341`). `ctx.slots.inject(name, cb)` is mandatory even when the owner is normally present: it withdraws the contribution if the declaration collapses and re-registers on restore (`dsh-client-ui-workspace/README.md:191`).

**i18n**: `ctx.locale.register(ns, {zh, en})` requires both baseline locales; extra ids optional; consumers use `ctx.locale.bind(ns)` or the injected `t` (`/tmp/dsh-src/dsh-client-locale/README.md:38-40`). Free-model: `ctx.effect(() => ctx.locale.register(NS, {zh, en}), '…')` (`client.js:7503`).

**Theming**: read `--dsw-*` tokens (e.g. `--dsw-alias-text-1/2/3`, `--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`); never reference official CSS-module class names (hashed per build). `dsh-client-ui-theme/README.md:20`.

## 4. Dev loop & verification (no browser needed)

- **Serving**: `GET /plugins/<pkg>/client.js?rev=<rev>` (or the combo form `plugins/??<pkg>/client.js&rev=<rev>`). Body = file bytes + `\n;\n//# sourceMappingURL=…`. Headers: `content-type: text/javascript; charset=utf-8`, `cache-control: public, max-age=31536000, immutable`. Wrong rev ⇒ `404`. **No cookie required** (verified: 200 without any cookie) — never put secrets in the bundle.
- **What applies a change**: `dsh-client-hmr` stat-polls every graph row's bundle every `pollIntervalMs` (default 500 ms) and calls `clientModules.rebuilt(id)` (`/tmp/dsh-src/dsh-client-hmr/lib/index.js:22,46-50`), which recomposes the graph and pushes a `rebuilt` frame over `/plugins/events`. Verified: after appending a comment to `client.js`, a fresh index fetch ~2 s later advertised a **new rev** (`5ab0ff887ff7` → `edab09429a25`). `pnpm run dev:web` is only needed to *rebuild* tsdown output from the DSH checkout — a hand-written bundle needs no watcher.
- **`file:` installs are content snapshots**: pnpm hardlinks/caches the package, so editing the source package in place does **not** update `$DSH_HOME/profiles/<p>/node_modules/<pkg>` reliably. Dev loop = edit, `rsync -a --no-perms proof-plugin/ …/node_modules/<pkg>/`, then the host half needs a restart (client half is picked up by the HMR poll). Re-running `dsh plugin add file:…` alone did not refresh `index.js`; `cp` also exits 1 on identical files (use rsync).
- **Host-side verification signals** (all used in the proof):
  1. `GET /?token=<token>` → 303 `./` + browser cookie; then `GET /` → 200 index containing `globalThis["__DSH_BOOT__"] = {rev, release, entries, batches}`. A correctly packaged plugin appears as `{"id":"dsh-ui-proof","url":"plugins/??dsh-ui-proof/client.js&rev=…","rev":"…"}`.
  2. Fetch that URL → 200 + the bundle.
  3. `node .ui-research/verify-client-bundle.mjs served-client.js --expect-id <pkg>` → executes the bundle against a stub `window.__ModuleLoader__`/React/ctx and asserts factory + `apply/inject/name` + the actual slot registration.
  4. `pluginInventory/list` is **not** a client check — it projects Host Loader entries only (`/tmp/dsh-src/dsh-host-plugin-inventory/README.md:12,42`).
- **API cookie vs browser cookie**: browser = `GET /?token=…` (303); API = `GET /connect?token=…&interactions=answer` (302, `v2` cookie). RPC envelope: `POST /api/<ns>/<method>`, `method` must equal `"<ns>/<method>"` (it is compared to the URL endpoint, `/tmp/dsh-src/dsh-client-connection/lib/index.js:906`), `content-type: application/json`, `Origin` must match. Zero-arg methods take `payload.args = {}` — **not** `{_request:{}}` (that errors `unexpected "_request"`). Verified calls: `settings/describe`; `settings/mutate` with `{ns, ops:[{op:'set',path:['enabled'],value:false}], expectedRevision}`.

## 5. Proof (executed 2026-11-06, isolated host)

`./.ui-research/run-proof.sh` (exit 0, from a deleted-then-recreated `$DSH_HOME`):

```
created profile web-test
row={"id": "dsh-ui-proof", "url": "plugins/??dsh-ui-proof/client.js&rev=833f80f9d592", "rev": "833f80f9d592"}
bundle=200 bytes=3326
stale-rev=404
slot: {"name":"settings.section","id":"ui-proof","order":900,"label":"UI-PROOF","locale":"uiProof"}
inject: ["slots","locale"] | waited for: ["settings.section"]
component text: UI-PROOFclient bundle loaded from /plugins/dsh-ui-proof/client.js…
namespace: ui-proof | applies: live | revision: 0 | value: {'enabled': True, 'mode': 'managed', 'baseDir': ''}
mutate ok: {'enabled': False, 'mode': 'all', 'baseDir': ''}
- id: ui-proof
  name: dsh-ui-proof
  config:
    enabled: false
    mode: all
log clean
```

- (a) client entry composed and advertised in `__DSH_BOOT__`; (b) served at the advertised rev, 404 on a stale rev, 200 without auth; (c) headless contract check on the **served bytes**; (d) the plugin's volatile Config is a live settings namespace and a real write persisted into `$DSH_HOME/profiles/web-test/cordis.patch.yml`; (e) host log had no error/warn line; the host was killed by listening port and `pgrep -fl web-test` was empty afterwards (live `~/.dsh` never touched).
- **UNVERIFIED**: actual browser paint / React commit (no browser and no offline React in this environment; the harness stubs React and checks the returned element tree), CSS appearance, and whether a `settings/mutate` write restarts the Host entry vs. updating it in place (`applies: "live"` is what the Host reports, but I did not observe `apply` re-entry).
- `cordis.patch.yml` mutation shape discovered: a settings write appends an override row `- id: <entryId> name: <pkg> config: {…}` **after** the bundle layer; the profile patch is applied last.

## 6. Risks & recommended plan

**Upgrade risks**

- `dsh.client` parsing, the `/plugins` route, and the `__DSH_BOOT__` wire are internal-but-documented; a release change breaks the bundle (loudly: composition error at boot). Pin the peer/target version, e.g. `"deepseekHarness": {"release": "dsh-v0.2.2-rc.1"}` as ima-copilot does, and re-run `run-proof.sh` after upgrades.
- Slot option contract (`id/order/label/locale/inject/children`) is the main UI risk; the *names* changed little but there is no semver promise for slot ids. Keep registrations in `ctx.slots.inject(...)` so a missing owner degrades to “no UI” instead of a broken boot.
- A page only applies graphs from the Host release it booted from (`/tmp/dsh-src/dsh-client-modules/README.md`, “Host release changes”) → after upgrading DSH, users must reload the page.
- Schemastery `Config` for persistence: `^3.18.2`; the browser form receives `schema.toJSON()`. A future major could change the envelope. Without `.volatile()` fields the namespace is invisible in `settings/describe` (`/tmp/dsh-src/dsh-settings/lib/index.js:122,505-507`) — no error is shown to the user, the page just can't be built.
- Generated typert descriptors are **avoided entirely** by using the plugin's own HTTP route + `settings/mutate`; nothing must be regenerated at build time.
- `/plugins` is unauthenticated: the bundle is public to any local process. No secrets, no tokens, no internal hostnames.

**Recommended minimal design for `dsh-session-workspace`**

1. `client.js` (new, ~250 lines, hand-written, no build): `id: 'dsh-session-workspace'`; `inject = ['slots','locale','configForms']`; register `settings.section` `{id:'session-workspace', order: 40, label: () => t('nav'), locale:'sessionWorkspace'}`; dictionary `{zh, en}`; component renders: a switch for `enabled`, a two-option segmented control for `mode` (`managed|all`), a text field for `baseDir` (absolute path validation client-side only), and a read-only “recent auto-created workspaces” list loaded from `GET /api/session-workspace/state`.
   Writes: `ctx.configForms.get('session-workspace').set('enabled', v)` / `mutate([{op:'set',path:['mode'],value:'all'}])` — one atomic op for the segmented change; never write `baseDir` unvalidated.
2. `package.json` (Lead-owned): add `"exports": {".":"./index.js","./client":"./client.js","./package.json":"./package.json"}`, `"dsh": {"bundle":{"patch":"./cordis.patch.yml"}, "client": {"platform":"web"}}`, dependency `"@deepseek-ai/schemastery": "^3.18.2"`, and `client.js` in `files`.
3. `index.js` (Lead-owned): export `Config` with `.volatile()` on `enabled`, `mode`, `baseDir` (defaults as today), read them with `config.enabled.get()` (volatile fields arrive as `Volatile` refs, **not** raw values — verified: serializing `config` directly yields `{}`), and register a `webServer` prefix route `/api/session-workspace` returning `{config, recent}` (free-model uses the same “own route instead of a typed Remote” pattern). No new Loader row, no patch change.
4. Optional composer indicator: `conversation.input.right` list occupancy reading the same config form — a 20 px chip (“独立工作区”), no interaction, so it cannot break submission.
5. Open-source readiness: no build deps, no generated files, MIT, README section documenting `dsh.client`, the slot name relied on, and the `settings.section` id; keep `client.js` under ~30 KB so review is possible; add a `scripts/verify-client-ui.mjs` that is a trimmed copy of `verify-client-bundle.mjs` (it works on any ModuleLoader bundle).
6. Rollout: land Host config (step 3) first — with defaults unchanged it is behavior-neutral; then the client half; then the optional indicator. Verify each with `run-proof.sh`-style checks (boot row → served rev → contract harness → settings describe/mutate).
