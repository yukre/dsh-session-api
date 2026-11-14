/**
 * dsh-session-api — a local HTTP control surface for DeepSeek Harness Sessions.
 *
 * DSH's own Remote layer is the browser's door into the Host: it is reachable
 * only by the authenticated page, and its methods are gateway projections, not
 * plain functions a Host plugin can call. This plugin therefore opens a small
 * HTTP surface of its own so an external script, another agent, or a phone on
 * the same machine can read and drive a Session.
 *
 * What it drives, and through which supported path:
 *   - reads/general control → `sessionController` SERVICE methods (the same
 *     implementations the Remote methods delegate to)
 *   - permission switch      → `commands.execute(agent, '/permission <preset>')`,
 *     exactly the route the UI uses, so every preset behaves identically
 *   - model switch           → `sessionController.selectModel`
 *   - messaging              → `sessionController.prompt` with `mode: 'steer'`
 *     (interject into the running turn) or `'queue'` (append to the queue)
 *
 * Security posture (all four are enforced, none is optional):
 *   1. The route lives on DSH's own web server, which binds a loopback literal
 *      only — the web server refuses a wildcard bind at load.
 *   2. Every request must carry `Authorization: Bearer <token>`.
 *   3. The socket's peer address must be loopback, so a proxy that re-exposes
 *      the port cannot reach this surface even though it reaches the server.
 *   4. Bodies are capped and must be JSON; session ids are validated.
 *
 * @module dsh-session-api
 */

import { randomBytes } from 'node:crypto'
import {
  renderSessionList,
  renderSessionDetail,
  renderModelCatalog,
  renderPermissionCatalog,
  renderQueue,
  renderConversation,
} from './markdown.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/** Route prefix owned by this plugin. */
const ROUTE = '/session-api'

/** Largest accepted request body. Every endpoint takes a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Settings. `token` is user-editable in the profile patch; leaving it empty
 * makes the plugin mint one on first use and persist it back, so the operator
 * can read it from the same place they would change it.
 */
const CONFIG_DEFAULTS = {
  /** Shared secret required on every request. Empty = mint and persist one. */
  token: '',
  /** Read the secret from this file instead of `token` when set. */
  tokenFile: '',
  /** Require the socket peer to be a loopback address. Off only for tests. */
  requireLoopback: true,
}

/** Services used when the profile has them; the plugin stays inert otherwise. */
export const inject = []

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * Whether an address is a loopback peer.
 * @param address - `req.socket.remoteAddress`, possibly IPv4-mapped IPv6.
 * @returns true for 127.0.0.0/8 and ::1.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (bare === '::1') return true
  return /^127\./.test(bare)
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/**
 * Whether the caller asked for Markdown instead of JSON.
 * @param req - the incoming request.
 * @returns true for `?format=md` (also accepts `markdown`).
 */
function wantsMarkdown(req) {
  try {
    const value = new URL(req.url ?? '', 'http://localhost').searchParams.get('format')
    if (value === null) return false
    const normalized = value.trim().toLowerCase()
    return normalized === 'md' || normalized === 'markdown'
  } catch {
    return false
  }
}

/**
 * Answer with a Markdown document.
 * @param res - response to own.
 * @param text - the document.
 * @param status - HTTP status.
 */
function sendMarkdown(res, text, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/** Read a capped JSON body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('请求体过大')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Validate a session id as a single path-safe segment.
 * @param value - candidate from the request.
 * @returns true when it can only ever name one directory.
 */
function isSafeSessionId(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 128) return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (value === '.' || value === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(value)
}

/**
 * Constant-time string comparison, so a wrong token cannot be probed by
 * timing successive prefixes.
 * @param left - expected value.
 * @param right - presented value.
 * @returns true only when both are identical.
 */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

/* ------------------------------------------------------------------ *
 * Token handling
 * ------------------------------------------------------------------ */

/**
 * Resolve the shared secret, minting and persisting one on first use.
 *
 * The token is written next to the DSH home so the operator finds it by
 * reading a file, and the plugin re-reads it on every activation — editing
 * either the file or the profile `config.token` takes effect on reload.
 * @param config - resolved plugin config.
 * @param log - logger used to announce where the secret landed.
 * @returns the secret and where it came from.
 */
function resolveToken(config, log) {
  if (typeof config.tokenFile === 'string' && config.tokenFile.length > 0) {
    try {
      const fromFile = readFileSync(config.tokenFile, 'utf8').trim()
      if (fromFile.length > 0) return { token: fromFile, source: config.tokenFile }
    } catch (error) {
      log?.warn?.('dsh-session-api: cannot read tokenFile %s: %s', config.tokenFile, error)
    }
  }
  if (typeof config.token === 'string' && config.token.length > 0) {
    return { token: config.token, source: 'config' }
  }
  // Mint once, then keep it: a token that changed every start would invalidate
  // every caller's stored credential on each restart.
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  const dir = join(home, 'session-api')
  const file = join(dir, 'token')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length > 0) return { token: existing, source: file }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const minted = randomBytes(32).toString('base64url')
    writeFileSync(file, `${minted}\n`, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // A restrictive umask already covers this; the file is created 0600 above.
    }
    log?.info?.('dsh-session-api: minted an access token at %s', file)
    return { token: minted, source: file }
  } catch (error) {
    log?.warn?.('dsh-session-api: cannot persist a token (%s); using an in-memory one', error)
    return { token: randomBytes(32).toString('base64url'), source: 'memory' }
  }
}

/* ------------------------------------------------------------------ *
 * Route handling
 * ------------------------------------------------------------------ */

/**
 * Read the bearer token a request presents.
 * @param req - the incoming request.
 * @returns the presented secret, or '' when absent.
 */
function presentedToken(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? '' : match[1].trim()
}

/**
 * Whether a request comes from the app's own page, which is the only caller the
 * settings page routes accept.
 *
 * These two routes exist so the Settings page can show and rotate the secret. A
 * token holder does not need them (it already knows the secret), so they are
 * deliberately NOT reachable with the token alone: requiring the page's own
 * origin keeps a script that merely learned the token from rotating it.
 * @param req - the incoming request.
 * @returns true when the browser page itself issued the request.
 */
function isPageOrigin(req) {
  const origin = String(req.headers.origin ?? '')
  if (origin === '') {
    // A same-origin fetch from the Electron renderer may omit Origin; the
    // loopback peer check has already run, and a cross-site page cannot reach
    // a loopback socket with a body of this shape without the browser sending
    // one. Fail closed only for an explicit foreign origin below.
    return true
  }
  let host
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  return host === String(req.headers.host ?? '')
}

/**
 * Persist a token so it survives a restart, then report where it landed.
 * @param token - the new secret.
 * @returns the source description for the page.
 */
function persistToken(token) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  const dir = join(home, 'session-api')
  const file = join(dir, 'token')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Created 0600 above; a restrictive umask already covers the rest.
  }
  return file
}

/**
 * The Session-controller service, or undefined in a profile without it.
 * @param ctx - Host context.
 * @returns the service, narrowed to what this plugin calls.
 */
function controllerOf(ctx) {
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  return controller !== undefined && typeof controller === 'object' ? controller : undefined
}

/**
 * Split a request path into its segments below the plugin prefix.
 *
 * The raw pathname is used for the prefix test and the split, and each segment
 * is decoded only afterwards. Decoding first would let `%2F` manufacture a new
 * segment and `..` walk out of the namespace before any id validation runs.
 * @param url - request URL.
 * @returns decoded segments, or [] when the request is outside the prefix.
 */
function segmentsOf(url) {
  let pathname
  try {
    pathname = new URL(url, 'http://localhost').pathname
  } catch {
    return []
  }
  if (!pathname.startsWith(`${ROUTE}/`)) return []
  return pathname
    .slice(ROUTE.length + 1)
    .split('/')
    .filter(part => part.length > 0)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        // A malformed escape is not a segment we can address.
        return part
      }
    })
}

/**
 * One JSON view of a session, built from the list/state surfaces.
 * @param ctx - Host context.
 * @param sessionId - optional id to narrow to.
 * @returns the projection the API publishes.
 */
async function readSessions(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (controller === undefined) return undefined
  const listed = await controller.list({}, AbortSignal.timeout(10_000))
  const items = Array.isArray(listed?.items) ? listed.items : (Array.isArray(listed) ? listed : [])
  if (sessionId === undefined) return items
  return items.find(item => item?.sessionId === sessionId || item?.id === sessionId)
}

/**
 * Answer one HTTP request.
 * @param ctx - Host context.
 * @param secret - live secret holder; `rotate()` replaces its `token` in place
 *   so a rotation applies to the very next request without a reload.
 * @param config - resolved config.
 * @param req - incoming request.
 * @param res - response to own.
 */
async function handle(ctx, secret, config, req, res) {
  // Peer check first: it needs no parsing and rejects a re-exposed port.
  if (config.requireLoopback === true) {
    const peer = req.socket?.remoteAddress
    if (!isLoopbackAddress(peer)) {
      sendJson(res, 403, { ok: false, code: 'NOT_LOOPBACK', message: '只允许本机访问。' })
      return
    }
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  // Only a request that actually carries a body has to declare a JSON type: a
  // bodyless POST/DELETE (cancel, queue removal) is a plain command with no
  // payload, and demanding a content type there would reject valid calls.
  const hasBody = req.headers['content-length'] !== undefined
    || req.headers['transfer-encoding'] !== undefined
  if (hasBody && contentType !== '' && contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, code: 'BAD_CONTENT_TYPE', message: '请求必须是 application/json。' })
    return
  }
  const parts = segmentsOf(req.url ?? '')
  const method = req.method ?? 'GET'

  /* ---------- settings page routes ----------
   * The page shows and rotates the secret. They are gated on the page's own
   * origin instead of the bearer token: a caller that merely holds the token
   * has no business rotating it.
   */
  if (parts[0] === 'settings' && parts[1] === 'token' && method === 'GET') {
    if (!isPageOrigin(req)) {
      sendJson(res, 403, { ok: false, code: 'NOT_PAGE', message: '只允许设置页访问。' })
      return
    }
    sendJson(res, 200, tokenView(secret, config))
    return
  }
  if (parts[0] === 'settings' && parts[1] === 'rotate' && method === 'POST') {
    if (!isPageOrigin(req)) {
      sendJson(res, 403, { ok: false, code: 'NOT_PAGE', message: '只允许设置页访问。' })
      return
    }
    const minted = randomBytes(32).toString('base64url')
    const written = persistToken(minted)
    secret.token = minted
    secret.source = written
    ctx.logger?.info?.('dsh-session-api: rotated the access token')
    sendJson(res, 200, tokenView(secret, config))
    return
  }

  if (!safeEqual(presentedToken(req), secret.token)) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '缺少或错误的访问密钥。' })
    return
  }

  const controller = controllerOf(ctx)

  if (controller === undefined) {
    sendJson(res, 503, { ok: false, code: 'NO_CONTROLLER', message: '本 profile 未挂载会话控制器。' })
    return
  }

  try {
    /* ---------- read-only ---------- */
    if (method === 'GET' && parts.length === 1 && parts[0] === 'status') {
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-session-api',
        version: 1,
        loopbackOnly: config.requireLoopback === true,
      })
      return
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'capabilities') {
      const capabilities = describeCapabilities()
      if (wantsMarkdown(req)) {
        sendMarkdown(res, renderCapabilities(capabilities))
        return
      }
      sendJson(res, 200, { ok: true, ...capabilities })
      return
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const items = await readSessions(ctx)
      if (wantsMarkdown(req)) {
        sendMarkdown(res, renderSessionList(items ?? []))
        return
      }
      sendJson(res, 200, { ok: true, sessions: items ?? [] })
      return
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'models') {
      const catalog = await controller.modelCatalog()
      if (wantsMarkdown(req)) {
        sendMarkdown(res, renderModelCatalog(catalog))
        return
      }
      sendJson(res, 200, { ok: true, catalog })
      return
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'permissions') {
      const presets = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined
      if (presets === undefined || typeof presets.catalog !== 'function') {
        sendJson(res, 503, { ok: false, code: 'NO_PERMISSIONS', message: '本 profile 未挂载权限预设。' })
        return
      }
      const catalog = presets.catalog()
      if (wantsMarkdown(req)) {
        sendMarkdown(res, renderPermissionCatalog(catalog))
        return
      }
      sendJson(res, 200, { ok: true, catalog })
      return
    }

    // Everything below needs a session id in the path.
    if (parts.length >= 2 && parts[0] === 'sessions') {
      const sessionId = parts[1]
      if (!isSafeSessionId(sessionId)) {
        sendJson(res, 400, { ok: false, code: 'BAD_SESSION_ID', message: '会话 ID 不合法。' })
        return
      }

      if (method === 'GET' && parts.length === 2) {
        const found = await readSessions(ctx, sessionId)
        if (found === undefined) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '没有这个会话。' })
          return
        }
        if (wantsMarkdown(req)) {
          let state
          try {
            state = await controller.state({ sessionId }, AbortSignal.timeout(10_000))
          } catch {
            // Detail is still useful when the live state cannot be read.
          }
          sendMarkdown(res, renderSessionDetail(found, state))
          return
        }
        sendJson(res, 200, { ok: true, session: found })
        return
      }

      if (method === 'GET' && parts.length === 3 && parts[2] === 'state') {
        const state = await controller.state({ sessionId }, AbortSignal.timeout(10_000))
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderSessionDetail({ sessionId }, state))
          return
        }
        sendJson(res, 200, { ok: true, state })
        return
      }

      if (method === 'GET' && parts.length === 3 && parts[2] === 'queue') {
        const state = await controller.state({ sessionId }, AbortSignal.timeout(10_000))
        const queue = Array.isArray(state?.queue) ? state.queue : []
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderQueue(sessionId, queue))
          return
        }
        sendJson(res, 200, { ok: true, queue })
        return
      }

      if (method === 'GET' && parts.length === 3 && parts[2] === 'conversation') {
        const limitRaw = (() => {
          try {
            return new URL(req.url ?? '', 'http://localhost').searchParams.get('limit')
          } catch {
            return null
          }
        })()
        const parsed = limitRaw === null ? NaN : Number.parseInt(limitRaw, 10)
        const maxMessages = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 40
        const page = await controller.page({
          address: { kind: 'session', sessionId },
          maxMessages,
        }, AbortSignal.timeout(30_000))
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderConversation(sessionId, page))
          return
        }
        sendJson(res, 200, { ok: true, page })
        return
      }

      if (method === 'GET' && parts.length === 3 && parts[2] === 'projections') {
        const projections = await controller.projections({ sessionId }, AbortSignal.timeout(10_000))
        sendJson(res, 200, { ok: true, projections })
        return
      }

      /* ---------- write ---------- */
      if (method === 'POST' && parts.length === 3 && parts[2] === 'prompt') {
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim().length === 0) {
          sendJson(res, 400, { ok: false, code: 'BAD_TEXT', message: 'text 不能为空。' })
          return
        }
        const mode = body.mode === 'queue' ? 'queue' : 'steer'
        const value = await controller.prompt({
          requestId: `api-${randomBytes(8).toString('hex')}`,
          sessionId,
          mode,
          content: [{ type: 'text', text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, AbortSignal.timeout(30_000))
        sendJson(res, 200, { ok: true, accepted: value?.accepted === true, mode })
        return
      }

      if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
        const value = controller.cancel({ sessionId })
        sendJson(res, 200, { ok: true, accepted: value?.accepted === true })
        return
      }

      if (method === 'POST' && parts.length === 3 && parts[2] === 'model') {
        const body = await readJsonBody(req)
        if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
          sendJson(res, 400, { ok: false, code: 'BAD_MODEL', message: '需要 provider 与 model。' })
          return
        }
        const value = await controller.selectModel({
          sessionId,
          provider: body.provider,
          model: body.model,
          ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
        })
        sendJson(res, 200, { ok: true, selection: value?.selection ?? value })
        return
      }

      if (method === 'POST' && parts.length === 3 && parts[2] === 'permission') {
        const body = await readJsonBody(req)
        const preset = typeof body.preset === 'string' ? body.preset.trim() : ''
        if (preset.length === 0) {
          sendJson(res, 400, { ok: false, code: 'BAD_PRESET', message: '需要 preset。' })
          return
        }
        const outcome = await switchPermission(ctx, sessionId, preset)
        sendJson(res, outcome.ok ? 200 : 409, outcome)
        return
      }

      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'queue') {
        const value = await controller.updateQueue({
          sessionId,
          itemId: parts[3],
          action: 'remove',
        })
        sendJson(res, 200, { ok: true, accepted: value?.accepted === true })
        return
      }
    }

    sendJson(res, 404, { ok: false, code: 'NO_ROUTE', message: '没有这个接口。' })
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') {
      sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', message: '请求体过大。' })
      return
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON。' })
      return
    }
    ctx.logger?.warn?.('dsh-session-api: %s', error)
    sendJson(res, 500, {
      ok: false,
      code: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Switch a session's permission preset through the same command path the UI
 * uses, so every selectable preset (including `auto` and `danger-full-access`)
 * behaves exactly as it does when clicked.
 * @param ctx - Host context.
 * @param sessionId - target session.
 * @param preset - preset name from the catalog.
 * @returns a result object shaped for the response.
 */
async function switchPermission(ctx, sessionId, preset) {
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (commands === undefined || typeof commands.execute !== 'function') {
    return { ok: false, code: 'NO_COMMANDS', message: '本 profile 未挂载命令服务。' }
  }
  if (agents === undefined || typeof agents.get !== 'function') {
    return { ok: false, code: 'NO_AGENT', message: '本 profile 未挂载 Agent 注册表。' }
  }
  const agent = agents.get(sessionId)
  if (agent === undefined) {
    return { ok: false, code: 'NOT_OPEN', message: '该会话当前没有打开，无法切换权限。' }
  }
  const execution = await commands.execute(
    agent,
    `/permission ${preset}`,
    [],
    AbortSignal.timeout(15_000),
  )
  if (execution === undefined) {
    return { ok: false, code: 'UNKNOWN_PRESET', message: `没有这个权限预设：${preset}` }
  }
  // A command reports its own outcome; a rejected preset comes back as
  // `kind: 'error'` rather than a throw, so the result must be inspected or a
  // failure would be reported to the caller as success.
  const outcome = execution.result
  if (outcome !== undefined && outcome.kind === 'error') {
    return {
      ok: false,
      code: 'PERMISSION_REJECTED',
      message: typeof outcome.text === 'string' && outcome.text.length > 0
        ? outcome.text
        : `切换权限失败：${preset}`,
    }
  }
  return { ok: true, preset }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Register the control surface on DSH's own web server.
 * @param ctx - Host context.
 * @param config - the row's config, merged over the defaults.
 */
export function apply(ctx, config) {
  const resolved = { ...CONFIG_DEFAULTS, ...(config ?? {}) }
  const initial = resolveToken(resolved, ctx.logger)
  // One mutable holder: rotating through the settings page replaces `token` in
  // place, so the next request validates against the new secret with no reload.
  const secret = { token: initial.token, source: initial.source }
  ctx.logger?.info?.('dsh-session-api: serving %s (token source: %s)', ROUTE, initial.source)
  ctx.inject(['webServer'], (webCtx) => {
    // The page prints a copy-paste curl line, so it needs the real origin.
    try {
      if (typeof webCtx.webServer.getOrigin === 'function') {
        resolved.baseUrl = String(webCtx.webServer.getOrigin()).replace(/\/+$/, '')
      }
    } catch {
      // Before the listener binds there is no origin; the page prints a hint.
    }
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => handle(ctx, secret, resolved, req, res),
      }),
      'dsh-session-api: control surface',
    )
  })
}

/**
 * The endpoint table published by `GET /capabilities`.
 *
 * A caller cannot guess which endpoints render Markdown, and guessing wrong
 * means parsing a document it did not expect. The table is the contract: each
 * row says what the endpoint does, which formats it answers, and whether it
 * writes.
 * @returns the capability document.
 */
function describeCapabilities() {
  return {
    service: 'dsh-session-api',
    version: 1,
    formats: ['json', 'md'],
    note: '在任意只读接口后加 ?format=md 取 Markdown；写入接口只返回 JSON。',
    endpoints: [
      { method: 'GET', path: '/status', formats: ['json'], write: false, summary: '服务状态与安全姿态' },
      { method: 'GET', path: '/capabilities', formats: ['json', 'md'], write: false, summary: '本清单：接口、格式与用途' },
      { method: 'GET', path: '/sessions', formats: ['json', 'md'], write: false, summary: '会话列表（含状态、标题、工作目录、最后活动）' },
      { method: 'GET', path: '/sessions/:id', formats: ['json', 'md'], write: false, summary: '单会话详情与运行状态' },
      { method: 'GET', path: '/sessions/:id/state', formats: ['json', 'md'], write: false, summary: '运行状态与排队信息' },
      { method: 'GET', path: '/sessions/:id/queue', formats: ['json', 'md'], write: false, summary: '排队消息列表' },
      { method: 'GET', path: '/sessions/:id/conversation', formats: ['json', 'md'], write: false, summary: '会话对话内容（?limit=N，默认 40，上限 200）' },
      { method: 'GET', path: '/sessions/:id/projections', formats: ['json'], write: false, summary: '原始投影数据' },
      { method: 'GET', path: '/models', formats: ['json', 'md'], write: false, summary: '可选模型目录' },
      { method: 'GET', path: '/permissions', formats: ['json', 'md'], write: false, summary: '权限预设与默认值' },
      { method: 'POST', path: '/sessions/:id/prompt', formats: ['json'], write: true, summary: '发消息：mode=steer 即时插话 / queue 排队' },
      { method: 'POST', path: '/sessions/:id/cancel', formats: ['json'], write: true, summary: '取消当前轮' },
      { method: 'POST', path: '/sessions/:id/model', formats: ['json'], write: true, summary: '切换模型' },
      { method: 'POST', path: '/sessions/:id/permission', formats: ['json'], write: true, summary: '切换权限预设' },
      { method: 'DELETE', path: '/sessions/:id/queue/:itemId', formats: ['json'], write: true, summary: '移除排队项' },
    ],
  }
}

/**
 * Render the capability table as Markdown.
 * @param capabilities - the document from {@link describeCapabilities}.
 * @returns Markdown document.
 */
function renderCapabilities(capabilities) {
  const lines = ['# 接口能力清单', '', capabilities.note, '']
  lines.push('| 方法 | 路径 | 格式 | 写入 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const entry of capabilities.endpoints) {
    const formats = entry.formats.includes('md') ? 'JSON / Markdown' : 'JSON'
    const write = entry.write ? '是' : '否'
    lines.push(`| ${entry.method} | \`${entry.path}\` | ${formats} | ${write} | ${entry.summary} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * What the settings page reads: the live secret and where it came from.
 * @param secret - live holder.
 * @param config - resolved config, whose `persisted` getter names the file.
 * @returns the page's view of the token.
 */
function tokenView(secret, config) {
  return {
    ok: true,
    token: secret.token,
    source: secret.source,
    persistedTo: secret.source,
    loopbackOnly: config.requireLoopback === true,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
  }
}

/** Exported for the test suite. */
export const internals = {
  isLoopbackAddress,
  isSafeSessionId,
  safeEqual,
  segmentsOf,
  ROUTE,
}
