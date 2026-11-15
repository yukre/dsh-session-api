/**
 * dsh-session-api — settings page.
 *
 * The Host half owns the control surface; this half only makes the shared
 * secret visible and editable from the place a user looks for it, instead of
 * leaving them to find a file under the DSH home. It renders one
 * `settings.section` page and talks to the Host through two small routes the
 * Host half serves exclusively for this page (loopback + page-origin only).
 *
 * Design notes that matter:
 *   - The page never invents a token. It shows what the Host reports, so the
 *     value on screen is always the value a request must present.
 *   - Regenerating is explicit and confirmed: silently rotating the secret
 *     would break every caller the user already configured.
 *   - Everything follows the host theme through `--dsw-alias-*` tokens, and no
 *     Harness Client package is imported as a module.
 *
 * @module dsh-session-api/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-api',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    /** Host routes owned by the settings page. */
    const TOKEN_PATH = '/session-api/settings/token'
    const ROTATE_PATH = '/session-api/settings/rotate'

    /* ------------------------------------------------------------------ *
     * Host calls
     * ------------------------------------------------------------------ */

    /** How long the page waits for the Host before reporting a failure. */
    const REQUEST_TIMEOUT_MS = 8000

    /**
     * Read the current token from the Host.
     * @returns the token view.
     */
    async function fetchToken() {
      // Without a timeout a wedged Host leaves the page on "读取中…" forever,
      // with no way for the user to tell a slow answer from a dead one.
      const response = await fetch(TOKEN_PATH, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.message ?? `读取失败（HTTP ${response.status}）`)
      }
      return payload
    }

    /**
     * Ask the Host to mint a new token.
     * @returns the new token view.
     */
    async function rotateToken() {
      const response = await fetch(ROTATE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.message ?? `生成失败（HTTP ${response.status}）`)
      }
      return payload
    }

    /**
     * Turn a fetch rejection into a message a user can act on.
     * @param reason - the rejection value.
     * @returns a short explanation.
     */
    function describeFailure(reason) {
      const isTimeout = typeof DOMException !== 'undefined'
        && reason instanceof DOMException
        && reason.name === 'TimeoutError'
      if (isTimeout) {
        return '宿主未在 8 秒内响应，请检查会话接口插件是否已启用。'
      }
      if (reason instanceof TypeError) {
        // fetch rejects with TypeError when the route is not reachable at all.
        return '无法连接到宿主接口，请确认插件已启用且 DSH 正在运行。'
      }
      return reason instanceof Error ? reason.message : String(reason)
    }

    /* ------------------------------------------------------------------ *
     * Styles — host alias tokens only
     * ------------------------------------------------------------------ */

    const CSS = `
.dsa-page { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
.dsa-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 16px 18px;
}
.dsa-card-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsa-card-desc { margin: 0 0 14px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsa-row { display: flex; align-items: center; gap: 8px; }
.dsa-secret {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 20px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dsa-btn {
  flex: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.dsa-btn:disabled { opacity: 0.5; cursor: default; }
.dsa-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsa-hint { margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsa-error { margin: 10px 0 0; font-size: 13px; color: var(--dsw-alias-state-error-primary); }
.dsa-ok { margin: 10px 0 0; font-size: 13px; color: var(--dsw-alias-state-success-primary); }
.dsa-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 8px 10px;
  margin: 8px 0 0;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  overflow-x: auto;
  white-space: pre;
}
.dsa-meta { display: flex; gap: 20px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsa-meta b { color: var(--dsw-alias-label-primary); font-weight: 600; }
`

    /** Inject the page stylesheet exactly once for the plugin's lifetime. */
    function useStyles() {
      React.useEffect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-session-api')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, [])
    }

    /* ------------------------------------------------------------------ *
     * The page
     * ------------------------------------------------------------------ */

    /**
     * One settings page: reveal the shared secret, copy it, or rotate it.
     * @returns the section body.
     */
    function SessionApiSettingsSection() {
      useStyles()
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [revealed, setRevealed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        setError(null)
        fetchToken().then(setView).catch((reason) => {
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [])

      React.useEffect(() => { load() }, [load])

      const copy = () => {
        const token = view?.token
        if (typeof token !== 'string' || token.length === 0) return
        const done = () => setNotice('已复制到剪贴板')
        if (navigator.clipboard?.writeText === undefined) {
          setNotice('当前环境不支持剪贴板，请手动选中复制')
          return
        }
        navigator.clipboard.writeText(token).then(done).catch(() => {
          setNotice('复制失败，请手动选中复制')
        })
      }

      const rotate = () => {
        if (busy) return
        // Rotation invalidates every caller, so it is confirmed first.
        const confirmed = window.confirm(
          '重新生成后，之前配置的调用方会立即失效，需要更新它们。确定继续吗？',
        )
        if (!confirmed) return
        setBusy(true)
        setError(null)
        setNotice(null)
        rotateToken().then((next) => {
          setView(next)
          setRevealed(true)
          setNotice('已生成新密钥，请更新你的调用方')
        }).catch((reason) => {
          setError(describeFailure(reason))
        }).finally(() => { setBusy(false) })
      }

      const masked = (() => {
        const token = view?.token
        if (typeof token !== 'string' || token.length === 0) return ''
        if (revealed) return token
        return `${token.slice(0, 4)}${'•'.repeat(Math.max(8, token.length - 8))}${token.slice(-4)}`
      })()

      return h('div', { className: 'dsa-page' },
        // --- endpoint card ---
        h('section', { className: 'dsa-card' },
          h('h3', { className: 'dsa-card-title' }, '本机接口'),
          h('p', { className: 'dsa-card-desc' },
            '外部脚本可从这里读取会话状态并驱动发消息、切模型、切权限、取消等操作。仅本机可访问。'),
          h('div', { className: 'dsa-meta' },
            h('span', null, '监听 ', h('b', null, view?.loopbackOnly === true ? '仅 127.0.0.1' : '未知')),
            h('span', null, '密钥来源 ', h('b', null, String(view?.source ?? '—')))),
          h('pre', { className: 'dsa-code' },
            `curl -H "Authorization: Bearer ${revealed && view?.token ? view.token : '<你的密钥>'}" \\\n  ${view?.baseUrl ?? 'http://127.0.0.1:<port>'}/session-api/sessions`)),

        // --- token card ---
        h('section', { className: 'dsa-card' },
          h('h3', { className: 'dsa-card-title' }, '访问密钥'),
          h('p', { className: 'dsa-card-desc' },
            '每个请求都必须带上它。默认自动生成并保存在 DSH 数据目录，也可以在这里换一个。'),
          h('div', { className: 'dsa-row' },
            h('div', { className: 'dsa-secret' }, view === null ? '读取中…' : masked),
            h('button', {
              type: 'button',
              className: 'dsa-btn',
              disabled: view === null || busy,
              onClick: () => setRevealed(value => !value),
            }, revealed ? '隐藏' : '显示'),
            h('button', {
              type: 'button',
              className: 'dsa-btn',
              disabled: view === null || busy,
              onClick: copy,
            }, '复制'),
            h('button', {
              type: 'button',
              className: 'dsa-btn dsa-btn-danger',
              disabled: view === null || busy,
              onClick: rotate,
            }, busy ? '生成中…' : '重新生成')),
          error !== null ? h('p', { className: 'dsa-error', role: 'alert' }, error) : null,
          notice !== null ? h('p', { className: 'dsa-ok', role: 'status' }, notice) : null,
          h('p', { className: 'dsa-hint' },
            '重新生成会让已配置的调用方立即失效。若只是自己用，建议保持不变。')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // One page in the Settings panel, placed after the shipped sections.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-api',
          order: 60,
          label: '会话远程控制',
        }, SessionApiSettingsSection))
      },
    }
  },
})
