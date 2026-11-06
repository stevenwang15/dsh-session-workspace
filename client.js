/**
 * dsh-session-workspace — browser half.
 *
 * Adds one compact control to the composer tool row: a pill that reports and
 * toggles whether NEW conversations get their own isolated workspace. It reads
 * and writes the Host half's runtime state over the plugin's own same-origin
 * `/api/session-workspace` routes.
 *
 * The toggle is runtime-only by design: it never rewrites the profile config,
 * and restarting the Host returns to the configured default. Turning it off
 * only affects conversations created afterwards — a Session's workspace is
 * recorded in its header when it is created and never moves.
 *
 * Written as a hand-authored ModuleLoader bundle: no build step, no dependency
 * beyond the `react` the shell already provides. Colours come from theme
 * variables so the control survives a light/dark switch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'sessionWorkspace'
    const SLOT = 'conversation.input.left'

    const DICT = {
      zh: {
        label: '独立工作区',
        on: '独立工作区',
        off: '共用工作区',
        hintOn: '新建对话会自动创建一个独立工作区（点击改为沿用当前工作区）\n临时设置，不修改配置；重启 DSH 后恢复默认。',
        hintOff: '新建对话沿用所选工作区，不再自动隔离（点击恢复自动创建独立工作区）\n临时设置，不修改配置；重启 DSH 后恢复默认。',
        error: '无法连接插件后端',
      },
      en: {
        label: 'Isolated workspace',
        on: 'Isolated',
        off: 'Shared',
        hintOn: 'New conversations automatically get their own workspace (click to use the selected one instead)\nTemporary: the profile config is untouched and a Host restart restores the default.',
        hintOff: 'New conversations reuse the selected workspace instead of isolating (click to isolate again)\nTemporary: the profile config is untouched and a Host restart restores the default.',
        error: 'Cannot reach the plugin control API',
      },
    }

    // Resolve against the page base, not the origin: DSH may be mounted under a
    // reverse-proxy sub-path, where a leading slash would drop the prefix.
    const API = (() => {
      try {
        return new URL('api/session-workspace', document.baseURI).pathname
      } catch {
        return '/api/session-workspace'
      }
    })()

    const CSS = `
.dsws-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;box-sizing:border-box;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dsws-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsws-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));outline-offset:1px}
.dsws-pill[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#111);border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dsws-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45}
.dsws-pill[aria-pressed="true"] .dsws-dot{opacity:1;background:var(--dsw-alias-state-business-primary,#4c8dff)}
.dsws-pill:disabled{opacity:.55;cursor:default}
`

    /**
     * Call one control-API endpoint with a timeout.
     *
     * @param {string} path - endpoint suffix below {@link API}.
     * @param {RequestInit} [options] - fetch options.
     * @returns {Promise<any>} the parsed JSON payload.
     */
    async function controlApi(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`${API}${path}`, { ...options, signal: controller.signal, redirect: 'error' })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 160) }
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /** Read the Host half's runtime state. */
    const readState = () => controlApi('/state')

    /**
     * Persist the runtime switch in the Host process.
     *
     * @param {boolean} enabled - whether new conversations isolate.
     */
    const writeState = (enabled) => controlApi('/enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })

    /**
     * The composer control: a status pill that toggles automatic isolation for
     * new conversations. Renders nothing when the Host exposes no control API
     * (host-only install, or an older package version on the Host side).
     *
     * @param {{ t: (key: string) => string }} props - translation bound to the plugin namespace.
     */
    function SessionWorkspacePill({ t }) {
      const [state, setState] = useState(undefined)
      const [unavailable, setUnavailable] = useState(false)
      const [busy, setBusy] = useState(false)

      const load = useCallback(() => {
        let alive = true
        readState()
          .then((next) => {
            if (!alive) return
            setState(next)
            setUnavailable(false)
          })
          .catch(() => {
            if (alive) setUnavailable(true)
          })
        return () => {
          alive = false
        }
      }, [])
      useEffect(load, [load])

      const toggle = useCallback(() => {
        if (busy || state === undefined) return
        setBusy(true)
        writeState(!state.enabled)
          .then((next) => setState(next))
          .catch(() => setUnavailable(true))
          .finally(() => setBusy(false))
      }, [busy, state])

      if (unavailable || state === undefined) return null
      const enabled = state.enabled === true
      return h('button', {
        type: 'button',
        className: 'dsws-pill',
        'aria-pressed': enabled,
        'aria-label': t(enabled ? 'on' : 'off'),
        title: t(enabled ? 'hintOn' : 'hintOff'),
        disabled: busy,
        onClick: toggle,
      },
        h('span', { className: 'dsws-dot' }),
        h('span', null, t(enabled ? 'on' : 'off')))
    }

    /**
     * Mount the browser half.
     *
     * @param {any} ctx - client Cordis context carrying slots and locale.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'session-workspace: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-session-workspace')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'session-workspace: styles')
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'session-workspace',
        order: 40,
        label: () => t('label'),
        locale: NS,
      }, (props) => h(SessionWorkspacePill, { ...props, t })))
    }

    exports.name = 'session-workspace'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
