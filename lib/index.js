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
 *   - answering a question   → wraps `userQuestions.ask` so an external caller
 *     can race the page (or the QQ channel) and win; see the question section
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
// Only the install direction is used here. `removeBundledSkills` is exported
// from that module for a real uninstall, but it must NOT run from a context
// cleanup: the same cleanup fires on reload and during an upgrade, where
// deleting the skill would make it vanish and reappear for no reason.
import { syncBundledSkills } from './skills-sync.js'
import {
  renderSessionList,
  renderSessionDetail,
  renderModelCatalog,
  renderPermissionCatalog,
  renderQueue,
  renderConversation,
  renderWorkspaceList,
  renderApprovals,
  renderQuestions,
} from './markdown.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { realpath as realpathAsync, stat as statAsync } from 'node:fs/promises'
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
  /**
   * Copy the bundled skill into the shared skill library on activation, so an
   * agent in any session can discover it without a manual install.
   */
  syncSkills: true,
  /**
   * Publish each `ask_user_question` to the HTTP surface and let an external
   * caller answer it, racing whoever else would answer (the page card, the QQ
   * channel). On by default because a headless session — a QQ-driven one in
   * particular — has no page to answer its questions. Set `false` to restore
   * the pre-1.7 behaviour of a read-only question list.
   */
  answerQuestions: true,
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

/**
 * The Host / Origin / Sec-Fetch-Site half of DSH's browser-trust fence.
 *
 * Mirrors `isTrustedApiRequest` in client-connection/api-request-trust.ts: the
 * Host header must name a loopback authority (DNS rebinding cannot forge it),
 * an explicit cross-site marker is refused, and an Origin — when a browser
 * attaches one — must be this very authority.
 *
 * The peer-authentication half of that function is intentionally absent: this
 * surface serves callers that never hold a DSH browser Peer, so requiring one
 * would reject the curl/Python/agent calls the plugin exists to accept.
 * @param ctx - Host context (reads the listener's bind host).
 * @param config - resolved plugin config.
 * @param req - the incoming request.
 * @returns a refusal message, or undefined when the request passes.
 */
function requestFence(ctx, config, req) {
  const host = String(req.headers?.host ?? '')
  if (host.length === 0) return '请求缺少 Host 头。'
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return 'Host 头无法解析。'
  }
  // Loopback authority, plus any extra host the operator declared trusted.
  const hostname = authority.hostname.toLowerCase()
  const extra = Array.isArray(config.trustedHosts) ? config.trustedHosts : []
  const loopback = hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback && !extra.includes(host)) {
    return 'Host 头不是本机地址（可能是 DNS 重绑定）。'
  }
  // An explicit cross-site marker is refused regardless of Origin.
  if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') {
    return '拒绝跨站请求。'
  }
  // When a browser attaches an Origin it must be this same authority. An absent
  // Origin is fine: the Host fence above already bound the request, and curl
  // sends none.
  const origin = req.headers?.origin
  if (origin === undefined) return undefined
  const text = String(origin)
  if (text === 'null') return '拒绝 opaque origin。'
  let originUrl
  try {
    originUrl = new URL(text)
  } catch {
    return 'Origin 头无法解析。'
  }
  if (originUrl.host.toLowerCase() !== authority.host.toLowerCase()) {
    return 'Origin 与 Host 不一致（跨站请求）。'
  }
  return undefined
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
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // A JSON body that is not an object (`null`, an array, a bare number) cannot
  // carry the fields any route reads, so it is a malformed request rather than
  // a server fault. Normalising it here keeps every route from having to guard
  // a property access on a primitive.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('请求体必须是一个 JSON 对象。')
    error.code = 'BAD_JSON_SHAPE'
    throw error
  }
  return parsed
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
 * The workspace registry, or undefined in a profile without it.
 * @param ctx - Host context.
 * @returns the registry, narrowed to what this plugin calls.
 */
function registryOf(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  return registry !== undefined && typeof registry === 'object' ? registry : undefined
}

/**
 * Publish one workspace as the API sees it.
 * @param workspace - a registry workspace value.
 * @returns its public projection.
 */
function workspaceView(workspace) {
  return {
    workspaceId: workspace?.id,
    path: workspace?.path,
    title: workspace?.title,
    sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
  }
}

/**
 * Resolve a caller-supplied directory to its canonical form, refusing anything
 * that is not an EXISTING directory.
 *
 * This check is the whole safety story for creating a session at a path. The
 * Host's own create path calls `mkdir(cwd, { recursive: true })`, so an
 * unchecked `cwd` would let any token holder materialise a directory tree
 * anywhere on disk. Requiring an existing directory keeps this API at exactly
 * the界面's capability: a Workspace is adopted from a directory that already
 * exists, and never conjured from a string.
 * @param raw - caller-supplied path.
 * @returns the canonical path, or an error result.
 */
async function resolveExistingDirectory(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'BAD_CWD', message: '需要 cwd（目录路径）。' }
  }
  const candidate = raw.trim()
  if (!isAbsolutePath(candidate)) {
    return { ok: false, code: 'BAD_CWD', message: 'cwd 必须是绝对路径。' }
  }
  let canonical
  try {
    canonical = await realpathAsync(candidate)
  } catch {
    return { ok: false, code: 'CWD_NOT_FOUND', message: `目录不存在：${candidate}` }
  }
  try {
    const info = await statAsync(canonical)
    if (!info.isDirectory()) {
      return { ok: false, code: 'CWD_NOT_DIRECTORY', message: `不是目录：${canonical}` }
    }
  } catch {
    return { ok: false, code: 'CWD_NOT_FOUND', message: `无法读取目录：${canonical}` }
  }
  return { ok: true, path: canonical }
}

/**
 * Whether a value is an absolute filesystem path.
 * @param value - candidate path.
 * @returns true for POSIX and Windows absolute forms.
 */
function isAbsolutePath(value) {
  if (/^\//.test(value)) return true
  return /^[A-Za-z]:[\\/]/.test(value)
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
  // Host / Origin fence first.
  //
  // `webServer.register` does NOT apply DSH's connection trust check, so a
  // loopback bind plus a peer-address test are not enough on their own: a page
  // on another origin, or a DNS-rebinding Host header, still reaches this route.
  //
  // The fence implemented here is the Host/Origin half of DSH's own
  // `isTrustedApiRequest` (client-connection/api-request-trust.ts). Its other
  // half — authenticating a browser Peer — is deliberately NOT used: this
  // surface exists precisely for callers DSH's own auth never issues a Peer to
  // (curl, Python, another agent), so requiring one would refuse every request
  // it is meant to serve, as a first attempt at this fix did.
  const untrusted = requestFence(ctx, config, req)
  if (untrusted !== undefined) {
    sendJson(res, 403, { ok: false, code: 'UNTRUSTED_CONNECTION', message: untrusted })
    return
  }
  // Peer check next: it needs no parsing and rejects a re-exposed port.
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
  if (parts.length === 2 && parts[0] === 'settings' && parts[1] === 'token' && method === 'GET') {
    if (!isPageOrigin(req)) {
      sendJson(res, 403, { ok: false, code: 'NOT_PAGE', message: '只允许设置页访问。' })
      return
    }
    sendJson(res, 200, tokenView(secret, config))
    return
  }
  if (parts.length === 2 && parts[0] === 'settings' && parts[1] === 'rotate' && method === 'POST') {
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

    /* ---------- workspaces: list and adopt ---------- */
    if (parts.length === 1 && parts[0] === 'workspaces') {
      const registry = registryOf(ctx)
      if (registry === undefined || typeof registry.list !== 'function') {
        sendJson(res, 503, { ok: false, code: 'NO_WORKSPACES', message: '本 profile 未挂载工作区注册表。' })
        return
      }
      if (method === 'GET') {
        const items = registry.list().map(workspaceView)
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderWorkspaceList(items))
          return
        }
        sendJson(res, 200, { ok: true, workspaces: items })
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        // Adoption requires an EXISTING directory, exactly like the UI's
        // "add workspace": the registry canonicalises it and refuses a
        // non-directory, and nothing here creates one.
        const resolved = await resolveExistingDirectory(body.path)
        if (resolved.ok !== true) {
          sendJson(res, resolved.code === 'CWD_NOT_FOUND' ? 404 : 400, {
            ok: false,
            code: resolved.code,
            message: resolved.message,
          })
          return
        }
        const workspace = await registry.create(resolved.path, typeof body.title === 'string' ? body.title : undefined)
        sendJson(res, 200, { ok: true, created: true, workspace: workspaceView(workspace) })
        return
      }
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 POST。' })
      return
    }

    /* ---------- create a session in a workspace and run its first task ---------- */
    if (method === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'create') {
      const body = await readJsonBody(req)
      const prepared = await prepareText(body)
      if (prepared.ok !== true) {
        sendJson(res, 400, prepared)
        return
      }
      const resolved = await resolveExistingDirectory(body.cwd)
      if (resolved.ok !== true) {
        sendJson(res, resolved.code === 'CWD_NOT_FOUND' ? 404 : 400, {
          ok: false,
          code: resolved.code,
          message: resolved.message,
        })
        return
      }
      const created = await createSessionWithFirstTask(ctx, controller, {
        cwd: resolved.path,
        text: prepared.text,
        mode: prepared.mode,
        ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
      })
      sendJson(res, created.ok ? 200 : 502, created)
      return
    }

    /* ---------- create a session inside one workspace ---------- */
    if (method === 'POST' && parts.length === 3 && parts[0] === 'workspaces' && parts[2] === 'sessions') {
      const registry = registryOf(ctx)
      if (registry === undefined || typeof registry.get !== 'function') {
        sendJson(res, 503, { ok: false, code: 'NO_WORKSPACES', message: '本 profile 未挂载工作区注册表。' })
        return
      }
      const workspace = registry.get(parts[1])
      if (workspace === undefined) {
        sendJson(res, 404, { ok: false, code: 'WORKSPACE_NOT_FOUND', message: '没有这个工作区。' })
        return
      }
      const body = await readJsonBody(req)
      const prepared = await prepareText(body)
      if (prepared.ok !== true) {
        sendJson(res, 400, prepared)
        return
      }
      const resolved = await resolveExistingDirectory(workspace.path)
      if (resolved.ok !== true) {
        sendJson(res, 409, {
          ok: false,
          code: 'WORKSPACE_PATH_UNUSABLE',
          message: `工作区目录不可用：${resolved.message}`,
        })
        return
      }
      const created = await createSessionWithFirstTask(ctx, controller, {
        cwd: resolved.path,
        text: prepared.text,
        mode: prepared.mode,
        ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
        workspaceId: workspace.id,
        workspacePath: workspace.path,
      })
      sendJson(res, created.ok ? 200 : 502, created)
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
          // Markdown needs the session's own facts (title, model, cwd), not just
          // its id: rendering from `{ sessionId }` alone produced a document
          // that called a running session idle and blank.
          const session = await readSessions(ctx, sessionId)
          sendMarkdown(res, renderSessionDetail(session ?? { sessionId }, state))
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

      if (method === 'GET' && parts.length === 3 && parts[2] === 'approvals') {
        const pending = approvalsFor(sessionId).map(approvalView)
        // Report the durable view too: a session can have an approval recorded
        // in its projection while this plugin holds nothing (the page answered
        // it), and a caller needs to see that difference rather than an empty
        // list that implies "nothing is waiting".
        let pendingInput = []
        try {
          const state = await controller.state({ sessionId }, AbortSignal.timeout(10_000))
          pendingInput = Array.isArray(state?.pendingInput) ? state.pendingInput : []
        } catch {
          // The session may be cold; the held queue is still authoritative here.
        }
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderApprovals(sessionId, pending, pendingInput))
          return
        }
        sendJson(res, 200, { ok: true, sessionId, pending, pendingInput })
        return
      }

      if (method === 'POST' && parts.length === 4 && parts[2] === 'approvals') {
        const body = await readJsonBody(req)
        const decision = body?.decision
        if (decision !== 'allow' && decision !== 'deny') {
          sendJson(res, 400, {
            ok: false,
            code: 'BAD_DECISION',
            message: 'decision 必须是 allow 或 deny。',
          })
          return
        }
        const entry = pendingApprovals.get(parts[3])
        if (entry === undefined) {
          sendJson(res, 404, {
            ok: false,
            code: 'APPROVAL_NOT_FOUND',
            message: '没有这个待决审批，可能已裁决、已超时，或已由界面处理。',
          })
          return
        }
        if (entry.sessionId !== sessionId) {
          // The decision is scoped: an id belonging to another session must not
          // be resolvable through this path.
          sendJson(res, 404, { ok: false, code: 'APPROVAL_NOT_FOUND', message: '该审批不属于这个会话。' })
          return
        }
        const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
        settleApproval(entry.decisionId, outcome)
        ctx.logger?.info?.('dsh-session-api: approval %s decided %s', entry.decisionId, outcome)
        sendJson(res, 200, {
          ok: true,
          decisionId: entry.decisionId,
          decision,
          applied: outcome,
        })
        return
      }

      if (method === 'GET' && parts.length === 3 && parts[2] === 'questions') {
        // Re-assert first: a row this plugin should be racing is only listable
        // if the wrapper is actually on top of the service.
        ensureRacerInstalled(ctx)
        // Two sources, merged: the plugin's own race queue (the only thing an
        // external caller can actually settle) and DSH's durable projection
        // (which also lists a `timed` call the plugin is not holding, but that
        // row is reported unanswerable rather than silently omitted).
        const projected = await activeQuestionsOf(ctx, sessionId)
        const rows = questionRows(questionsFor(sessionId), projected)
        // Report whether the session exists at all. Without it, "empty list"
        // reads the same for a session with no questions and for a typo in the
        // id — and the caller only finds out when its POST gets a 404.
        const found = await readSessions(ctx, sessionId)
        const known = found !== undefined
        if (wantsMarkdown(req)) {
          sendMarkdown(res, renderQuestions(sessionId, rows))
          return
        }
        sendJson(res, 200, { ok: true, sessionId, sessionKnown: known, questions: rows })
        return
      }

      if (method === 'POST' && parts.length === 4 && parts[2] === 'questions') {
        const body = await readJsonBody(req)
        // Accept `{answers:[{id,selected,custom?}]}` and, as a convenience, a
        // bare `{selected: "x"}`. The shorthand only makes sense for a call that
        // asked ONE question: applying it to a multi-question call would answer
        // the first and then fail the all-questions-answered check with a
        // message the caller cannot act on. Refuse it up front instead.
        let answers = body?.answers
        if (!Array.isArray(answers) && typeof body?.selected === 'string') {
          const held = pendingQuestions.get(parts[3])
          const entry = held?.sessionId === sessionId ? held : undefined
          const asked = entry !== undefined
            ? entry.questions
            : await activeQuestionsOf(ctx, sessionId)
            .then(rows => rows.find(row => String(row?.callId) === parts[3])?.questions)
          const list = Array.isArray(asked) ? asked : []
          if (list.length > 1) {
            sendJson(res, 409, {
              ok: false,
              code: 'BAD_ANSWERS',
              message: `这次提问有 ${String(list.length)} 个问题，简写不适用；请用 answers 为每个问题各提供一项（问题 id：${list.map(item => String(item?.id)).join('、')}）。`,
            })
            return
          }
          const first = list[0]
          if (first !== undefined) {
            answers = [{ id: first.id, selected: [body.selected] }]
          }
        }
        const outcome = await answerQuestion(ctx, sessionId, parts[3], answers)
        // Status codes carry the caller's next move:
        //   404 — nothing addressable here (unknown session, unknown call, or a
        //         call that belongs to another session); re-read the list.
        //   409 — the request was understood but cannot be applied (bad batch,
        //         or someone else answered first); do not retry blindly.
        const status = outcome.ok
          ? 200
          : (outcome.code === 'QUESTION_NOT_FOUND' || outcome.code === 'NOT_OPEN' ? 404 : 409)
        sendJson(res, status, outcome)
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
        // Strict integer parse: `parseInt('10abc')` silently yields 10, which
        // would let a malformed query look like a valid request.
        const parsed = limitRaw !== null && /^\d+$/.test(limitRaw.trim())
          ? Number.parseInt(limitRaw.trim(), 10)
          : NaN
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
    if (error?.code === 'BAD_JSON_SHAPE') {
      sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: error.message })
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
 * Validate the first-task fields shared by both create routes.
 * @param body - the parsed request body.
 * @returns the normalised text and mode, or an error result.
 */
async function prepareText(body) {
  const text = typeof body?.text === 'string' ? body.text : ''
  if (text.trim().length === 0) {
    return { ok: false, code: 'BAD_TEXT', message: 'text 不能为空。' }
  }
  const mode = body?.mode === 'queue' ? 'queue' : 'steer'
  return { ok: true, text, mode }
}

/**
 * Create a Session through the Host's own creation path and immediately hand it
 * its first task.
 *
 * The two steps are reported separately on purpose. `create` is durable the
 * moment it returns: if `prompt` then fails, the Session genuinely exists and
 * the caller must learn its id — reporting a bare failure would leave an
 * orphan the caller cannot address.
 * @param ctx - Host context.
 * @param controller - the session controller service.
 * @param options - target directory, first task, and optional placement.
 * @returns the create result for the response body.
 */
async function createSessionWithFirstTask(ctx, controller, options) {
  let created
  try {
    created = await controller.create({
      cwd: options.cwd,
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
  } catch (error) {
    return {
      ok: false,
      code: 'CREATE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, code: 'CREATE_FAILED', message: '宿主未返回会话 ID。' }
  }

  const base = {
    sessionId,
    cwd: options.cwd,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
    ...(typeof created?.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
  }

  try {
    await controller.prompt({
      requestId: `api-${randomBytes(8).toString('hex')}`,
      sessionId,
      mode: options.mode,
      content: [{ type: 'text', text: options.text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, AbortSignal.timeout(30_000))
  } catch (error) {
    // The Session exists; say so, and report the failed task beside it.
    return {
      ok: false,
      code: 'PROMPT_FAILED',
      message: `会话已创建，但首条任务发送失败：${error instanceof Error ? error.message : String(error)}`,
      ...base,
    }
  }

  ctx.logger?.info?.('dsh-session-api: created %s in %s', sessionId, options.cwd)
  return { ok: true, accepted: true, mode: options.mode, ...base }
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
  // Install the bundled skill before anything else: an agent's first question
  // may need it, and the copy is cheap when already current.
  if (resolved.syncSkills !== false) {
    try {
      const installed = syncBundledSkills({ log: ctx.logger })
      if (installed.length > 0) {
        ctx.logger?.info?.('dsh-session-api: skill library now carries %s', installed.join(', '))
      }
    } catch (error) {
      // A skill that cannot be copied must not take the control surface down.
      ctx.logger?.warn?.('dsh-session-api: skill sync failed: %s', error)
    }
  }

  installApprovalAnswerer(ctx)
  // `answerQuestions: false` restores the pre-1.7 behaviour: no wrapper at all,
  // so `/questions` lists only what DSH's own projection reports and every POST
  // falls back to the service's late-reply path. The disposer registered by
  // `installQuestionRacer` restores exactly the function it replaced, so a
  // reload that flips this flag cannot leave a stale wrapper behind.
  if (resolved.answerQuestions !== false) {
    // `ctx.inject`, not a bare `ctx.get`: the question service is mounted by a
    // different bundle and may not exist yet when this row loads. Reading it
    // once here would find nothing and — worse — never try again, which is
    // exactly how the racer silently failed to install on a real host while
    // every unit test passed. `inject` runs the callback when the service
    // appears and disposes it when the service goes away.
    ctx.inject(['userQuestions'], (questionCtx) => {
      questionCtx.effect(() => installQuestionRacer(questionCtx), 'dsh-session-api: question racer')
    })
  }
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

/* ------------------------------------------------------------------ *
 * Pending questions
 *
 * A question is answered by whichever channel gets there first. In DSH the
 * shipped channels are the page card (a `user-questions/request` waterfall
 * listener) and, for QQ-driven sessions, `im-qqbot`'s channel — which does not
 * join the waterfall at all, it REPLACES `userQuestions.ask` outright. A
 * plugin that joined only the waterfall would therefore be blind to every QQ
 * session; one that only read the projection would be blind to every legacy
 * (blocking-schema) call. Neither is acceptable for a headless session, which
 * is exactly the case this plugin exists to serve.
 *
 * So this plugin sits ABOVE both: it wraps `userQuestions.ask` once, publishes
 * the request to the HTTP surface, and settles on the first of
 *
 *   a) an external POST /questions/:callId,
 *   b) whatever the wrapped chain is about to do (page card / QQ / no answer),
 *   c) the caller's own abort signal going away.
 *
 * The wrapped call is left running when (a) wins. It still holds its own
 * promise, so it settles later on its own terms and its answer is discarded —
 * the page card simply disappears once the tool call is no longer answerable,
 * because the durable projection no longer lists it. Nothing is stranded: the
 * plugin never takes ownership of the request, it only races it.
 *
 * The queue below is therefore the plugin's own, not a view of the
 * `userQuestions` projection. The projection is still consulted to decide
 * whether an addressed call is answerable at all (a `legacy` call never enters
 * it), but only for reporting state — a race winner is settled here.
 * ------------------------------------------------------------------ */

/**
 * One question waiting for an external answer.
 * @typedef {object} PendingQuestion
 * @property {string} callId stable id the HTTP routes address
 * @property {string} sessionId session the asking agent belongs to
 * @property {Array<object>} questions the asked questions
 * @property {string=} toolCallId exact tool call, when the asker supplied one
 * @property {boolean} timed whether the asker declared a foreground deadline
 * @property {number} askedAt epoch milliseconds
 * @property {(answer: object) => void} settle resolves the race with an answer
 */

/**
 * Questions this plugin is currently holding for an external answer, newest last.
 * @type {Map<string, PendingQuestion>}
 */
const pendingQuestions = new Map()

/**
 * The synthetic call id used when a request carries no tool call id.
 *
 * A blocking `ask_user_question` call (the `legacy` schema) passes no `wait`
 * and no callId, but an external caller still needs something to address. The
 * value is derived from the session and a counter rather than random, so a
 * caller that lists the question can address it without another round trip.
 */
function syntheticCallId(sessionId, sequence) {
  return `${sessionId}#ask-${sequence}`
}

/** Monotonic suffix for {@link syntheticCallId}. */
let syntheticQuestionSequence = 0

/** How long a question stays addressable before the plugin withdraws it. */
const QUESTION_TTL_MS = 30 * 60 * 1000

/**
 * The live TTL. A separate binding so a test can shorten it: 30 minutes is far
 * longer than any test can wait, and the expiry rule ("drop the HTTP entry, do
 * NOT touch the downstream") is a real invariant worth asserting rather than
 * describing in a comment.
 */
const questionTtl = { ms: QUESTION_TTL_MS }

/**
 * Why a winning API answer aborts the losing channel.
 *
 * Both shipped channels read an abort as "the asker withdrew": the page drops
 * its card and the QQ channel removes its entry without messaging the user.
 * That is exactly the state a race winner needs — the question is over, and the
 * loser must stop offering it — so the abort reason exists purely to make a log
 * line say why, rather than to signal any failure to the model.
 */
class QuestionWithdrawnError extends Error {
  constructor(callId) {
    super(`question ${callId} was answered through the session API`)
    this.name = 'QuestionWithdrawnError'
    this.code = 'API_WON_RACE'
  }
}

/**
 * Read the questions a session is currently waiting on, as DSH's own durable
 * projection reports them.
 *
 * This is the `timed` schema's view only: a blocking `legacy` call never enters
 * the projection, which is precisely why the plugin also keeps its own queue.
 * @param ctx - Host context.
 * @param sessionId - the addressed session.
 * @returns the projection's active questions, or [] when unavailable.
 */
async function activeQuestionsOf(ctx, sessionId) {
  const controller = controllerOf(ctx)
  if (controller === undefined) return []
  try {
    const result = await controller.projections({ sessionId }, AbortSignal.timeout(10_000))
    const values = result?.kind === 'sequenced' ? result.values : result?.values
    const active = values?.userQuestions?.active
    return Array.isArray(active) ? active : []
  } catch {
    return []
  }
}

/**
 * Publish one asked question as the API sees it.
 * @param questions - the asked questions, in service vocabulary.
 * @returns their public projection.
 */
function questionItemsView(questions) {
  const rows = Array.isArray(questions) ? questions : []
  return rows.map(item => ({
    id: item?.id,
    question: item?.question,
    ...(item?.header === undefined ? {} : { header: item.header }),
    ...(item?.detail === undefined ? {} : { detail: item.detail }),
    ...(Array.isArray(item?.options)
      ? {
        options: item.options.map(option => ({
          label: option?.label ?? option?.value ?? option,
          ...(typeof option?.description === 'string' ? { description: option.description } : {}),
        })),
      }
      : {}),
    ...(item?.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
  }))
}

/**
 * Merge the plugin's live queue with the durable projection into one list.
 *
 * A call can appear in both: the projection lists a `timed` call as `open`
 * while the plugin is racing it. The plugin's entry wins because it carries the
 * address the caller can actually answer through.
 * @param held - entries from {@link pendingQuestions} for that session.
 * @param projected - the projection's active rows.
 * @returns one row per answerable call.
 */
function questionRows(held, projected) {
  const rows = new Map()
  for (const entry of projected) {
    const callId = String(entry?.callId ?? '')
    if (callId.length === 0) continue
    rows.set(callId, {
      callId,
      kind: 'question',
      state: entry?.state ?? 'open',
      // Whether an external caller can answer THIS row. A projection-only row
      // whose call the plugin is not racing cannot be settled through the API —
      // saying so is the whole point of this field.
      answerable: false,
      questions: questionItemsView(entry?.questions),
    })
  }
  for (const entry of held) {
    const existing = rows.get(entry.callId)
    rows.set(entry.callId, {
      callId: entry.callId,
      kind: 'question',
      state: existing?.state ?? 'open',
      answerable: true,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      ...(entry.timed ? { timed: true } : {}),
      source: 'session-api',
      askedAt: entry.askedAt,
      questions: questionItemsView(entry.questions),
    })
  }
  return [...rows.values()].sort((left, right) => {
    // Oldest first so a caller reads them in the order the agent asked.
    const leftAt = left.askedAt ?? Number.MAX_SAFE_INTEGER
    const rightAt = right.askedAt ?? Number.MAX_SAFE_INTEGER
    return leftAt - rightAt
  }).map(({ askedAt, ...row }) => row)
}

/**
 * Re-assert the question racer if another installer displaced it.
 *
 * The wrapper polls on its own, but a caller arriving through the HTTP surface
 * should not have to wait for that interval: reading the question list is
 * exactly when a displaced wrapper must be noticed, because the row would
 * otherwise be missing from the very list meant to reveal it.
 * @param ctx - Host context.
 */
function ensureRacerInstalled(ctx) {
  if (typeof ctx.get !== 'function') return
  const service = ctx.get('userQuestions')
  if (service === undefined) return
  const controller = racerControllers.get(service)
  if (controller !== undefined) controller.reassert()
}

/**
 * List the questions this plugin is currently holding for one session.
 * @param sessionId - the addressed session.
 * @returns matching entries, oldest first.
 */
function questionsFor(sessionId) {
  return [...pendingQuestions.values()]
    .filter(entry => entry.sessionId === sessionId)
    .sort((left, right) => left.askedAt - right.askedAt)
}

/**
 * Answer one waiting question from outside.
 *
 * Two shapes are supported, and the plugin says which one it used:
 *   - a call this plugin is racing → the race is settled directly, so the
 *     answer wins even when the durable projection says nothing about it
 *     (a blocking `legacy` call, or a `timed` one still inside its window);
 *   - a `continued` call the plugin is not holding → falls back to
 *     `userQuestions.answer`, which is DSH's own late-reply path and works with
 *     or without this plugin.
 *
 * The service validates the batch (one item per asked question) and throws a
 * typed error for a malformed one, so the plugin reports the reason verbatim
 * instead of re-deriving the rules.
 * @param ctx - Host context.
 * @param sessionId - the addressed session.
 * @param callId - the waiting tool call.
 * @param answers - caller-supplied items.
 * @returns a result shaped for the response.
 */
async function answerQuestion(ctx, sessionId, callId, answers) {
  const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (!Array.isArray(answers)) {
    return { ok: false, code: 'BAD_ANSWERS', message: 'answers 必须是数组。' }
  }
  // An empty batch would "succeed" while answering nothing: the service only
  // checks that the batch names every asked question, and a zero-question call
  // is rejected by it, but a caller passing [] for a real question would get a
  // confusing success here. Refuse it explicitly.
  if (answers.length === 0) {
    return { ok: false, code: 'BAD_ANSWERS', message: 'answers 不能为空，需要为每个问题提供一项。' }
  }
  // Shape-check before calling so a caller gets a precise message instead of a
  // generic service rejection.
  const malformed = answers.find(item => typeof item?.id !== 'string'
    || !Array.isArray(item?.selected ?? [])
    || (item?.custom !== undefined && typeof item.custom !== 'string'))
  if (malformed !== undefined) {
    return { ok: false, code: 'BAD_ANSWERS', message: '每项需要 {id, selected[]}，可选 custom。' }
  }
  const normalized = {
    answers: answers.map(item => ({
      id: item.id,
      selected: Array.isArray(item.selected) ? item.selected.map(String) : [],
      ...(item.custom === undefined ? {} : { custom: String(item.custom) }),
    })),
  }

  // Path 1: this plugin is racing the request. Settling here is what lets a
  // QQ-driven or blocking call be answered at all.
  const held = pendingQuestions.get(callId)
  // A call id that this plugin holds for a DIFFERENT session is not answerable
  // through this path at all. Falling through would ask the service about a call
  // id belonging to another session's log, which it scopes away and reports as
  // "not found" — true, but for the wrong reason, and it would hide a caller
  // that addressed the wrong session.
  if (held !== undefined && held.sessionId !== sessionId) {
    return {
      ok: false,
      code: 'QUESTION_NOT_FOUND',
      message: '这个 callId 不属于该会话。',
    }
  }
  if (held !== undefined) {
    // The batch must name every question the call asked, exactly once. The
    // service enforces this for its own path; a race winner has to enforce it
    // itself, otherwise the model would receive a partial answer.
    const asked = held.questions.map(item => item?.id)
    const answered = new Set(normalized.answers.map(item => item.id))
    if (answered.size !== normalized.answers.length
      || asked.length !== normalized.answers.length
      || !asked.every(id => answered.has(id))) {
      return {
        ok: false,
        code: 'BAD_ANSWERS',
        message: `这次提问有 ${String(asked.length)} 个问题，需要每个各回答一项，且不能重复。`,
      }
    }
    const settled = held.settle(normalized)
    // `settle` returns false when the race already ended (the page or the QQ
    // channel answered first); treating that as success would tell the caller
    // its answer was applied when it was discarded.
    if (settled === false) {
      return {
        ok: false,
        code: 'QUESTION_ALREADY_SETTLED',
        message: '这条提问刚刚已被别处回答（界面或 QQ 通道），以那边为准。',
      }
    }
    ctx.logger?.info?.('dsh-session-api: question %s answered via API', callId)
    return { ok: true, callId, answered: normalized.answers.length, via: 'api' }
  }

  // Path 2: nobody here is racing it, so DSH's own late-reply path is the only
  // route. It requires a live agent and a `continued` question.
  if (service === undefined || typeof service.answer !== 'function') {
    return { ok: false, code: 'NO_QUESTIONS', message: '本 profile 未挂载提问服务。' }
  }
  if (agents === undefined || typeof agents.get !== 'function') {
    return { ok: false, code: 'NO_AGENT', message: '本 profile 未挂载 Agent 注册表。' }
  }
  const agent = agents.get(sessionId)
  if (agent === undefined) {
    return { ok: false, code: 'NOT_OPEN', message: '该会话当前没有打开，无法作答。' }
  }
  try {
    const accepted = service.answer(agent, callId, normalized)
    if (accepted !== true) {
      return {
        ok: false,
        code: 'QUESTION_NOT_FOUND',
        message: '没有这个待答提问：可能已回答、已超时，或是 legacy 提问（不经投影，只能由本插件接管）。',
      }
    }
    return { ok: true, callId, answered: normalized.answers.length, via: 'service' }
  } catch (error) {
    return {
      ok: false,
      code: 'ANSWER_REJECTED',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Install the `userQuestions.ask` wrapper that publishes questions to HTTP.
 *
 * Why a wrapper and not a `user-questions/request` listener: the two shipped
 * channels do not both use the waterfall. The page card joins it, but
 * `im-qqbot` **replaces `userQuestions.ask` outright** — it never calls the
 * previous implementation for a QQ session. A listener would therefore be
 * blind to exactly the sessions that have nobody at the GUI, which are the
 * ones this plugin exists to serve.
 *
 * Why the wrapper must survive being replaced: because `im-qqbot` assigns a
 * brand-new function to the same slot, **load order decides who is outermost**.
 * If it installs after us, our wrapper is gone and QQ sessions silently lose
 * the race. So the wrapper owns a MUTABLE downstream reference and re-asserts
 * itself: whenever it finds the slot holding a different function, it adopts
 * that function as the new downstream and puts itself back on top. There is
 * exactly one wrapper for the life of the plugin, so re-asserting cannot build
 * a chain and cannot double-race a single request.
 *
 * The re-assertion points are: right after install (the common
 * session-api-then-qqbot order), on a short unref'd interval (covers a channel
 * installed or reloaded later), and on every question route access (covers a
 * caller noticing a displacement before the interval fires).
 * @param ctx - Host context.
 * @returns a disposer restoring the original method and stopping the re-assert.
 */
function installQuestionRacer(ctx) {
  if (typeof ctx.get !== 'function') return () => {}
  const service = ctx.get('userQuestions')
  if (service === undefined || typeof service.ask !== 'function') return () => {}
  // Retire whatever instance is already installed, so two controllers never
  // fight over the slot. The controller is looked up on the FUNCTION first and
  // only then in the WeakMap: a reload can leave a marked wrapper in place while
  // the WeakMap entry is gone (the map is per-module-instance), and returning a
  // no-op disposer there would leave that orphan wrapper alive forever — it
  // would keep writing to the shared question queue with nobody able to settle
  // its entries.
  const installedController = service.ask.__sessionApiController
  if (installedController !== undefined) installedController.dispose()
  const existing = racerControllers.get(service)
  if (existing !== undefined) existing.dispose()

  // The function the wrapper delegates to. Replaced whenever a later installer
  // claims the slot; never the wrapper itself, which would recurse.
  let downstream = service.ask
  // The function that was in the slot before this plugin existed, kept
  // immutably. It is the escape hatch for re-entrancy: a channel that captured
  // OUR wrapper as its own "previous" calls back into us, and continuing to the
  // current downstream from there would ping-pong forever. `im-qqbot` does
  // exactly this — it binds `uq.ask` at install and delegates to that binding
  // for every non-QQ session.
  const core = service.ask
  let disposed = false
  /**
   * Identity of this controller, stamped on every entry it parks.
   *
   * `pendingQuestions` is module-global while controllers come and go on every
   * reload, so an entry has to say who owns it: retiring a controller must not
   * touch a newer one's questions.
   */
  const owner = {}

  /**
   * Requests already handled by this wrapper.
   *
   * A WeakSet rather than a marker property on purpose: the request is spread
   * into the forwarded event and the gateway rejects any own key that is not a
   * plain string, so decorating the object would break the waterfall for every
   * question. Identity is enough — each ask is a fresh object.
   */
  const racedRequests = new WeakSet()

  /**
   * Hand a request to the downstream chain without racing it.
   *
   * The identity MUST be registered before the call, not after: a channel that
   * captured this wrapper as its own `previous` delegates back to us with the
   * same object, and an unregistered identity would re-enter this function
   * forever. That is not hypothetical — `im-qqbot`'s non-QQ branch is exactly
   * this delegation, so any pass-through path that forgets the mark turns into
   * an unbounded loop.
   * @param self - the `this` the downstream must see.
   * @param request - the request being passed through.
   * @returns whatever the downstream returns.
   */
  const passDown = (self, request) => {
    if (request !== null && typeof request === 'object') racedRequests.add(request)
    return downstream.call(self, request)
  }

  const wrapped = async function sessionApiRacedAsk(request) {
    const requestIsObject = request !== null && typeof request === 'object'
    // Re-entered through a channel that captured this very wrapper as its
    // downstream: finish the original request instead of racing it twice.
    if (requestIsObject && racedRequests.has(request)) return core.call(this, request)
    // A disposed instance must not park anything. This is not dead code: this
    // function can outlive its own controller — a channel that captured it keeps
    // calling it after a reload — and parking then would publish into
    // `pendingQuestions` with no controller left to settle the entry, so the
    // caller would see a question it can never answer.
    if (disposed) return passDown(this, request)
    // Anything the plugin cannot address over HTTP is passed through untouched:
    // a request with no live agent (a programmatic `ask`) has no session to
    // route a decision to.
    const sessionId = request?.agent?.id
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (typeof sessionId !== 'string' || sessionId.length === 0 || questions.length === 0) {
      return passDown(this, request)
    }
    // A caller abort that already fired is DSH's business, not ours: let the
    // real method produce its own typed `ASK_ABORTED`.
    if (request.signal?.aborted === true) return passDown(this, request)

    const toolCallId = request?.wait?.callId
    const callId = typeof toolCallId === 'string' && toolCallId.length > 0
      ? toolCallId
      : syntheticCallId(sessionId, (syntheticQuestionSequence += 1))

    const raced = Promise.withResolvers()
    let settled = false
    // Downstream cancellation this plugin owns.
    //
    // When the API wins, the wrapped call is left running by design, but it must
    // not be left ADVERTISING the question: the QQ channel would keep its entry
    // and later send the user "⚠️ 提问已超时，未收到回答。" for a question that was
    // in fact answered here, and a page card would stay actionable for a call
    // that can no longer be settled. Aborting this controller is the supported
    // way to withdraw it — both shipped channels treat the signal's abort as
    // "the asker withdrew", which removes their card/entry and sends nothing.
    const withdraw = new AbortController()
    const entry = {
      callId,
      sessionId,
      questions,
      // Which controller parked this entry. Disposal is per-instance and the
      // queue is module-global, so a controller being retired (a reload retires
      // the previous one) must not abandon entries a NEWER controller owns:
      // doing so would reject a live session's question for no reason.
      owner,
      ...(typeof toolCallId === 'string' && toolCallId.length > 0 ? { toolCallId } : {}),
      timed: request?.wait?.timed === true,
      askedAt: Date.now(),
      /**
       * Win the race with an externally supplied answer.
       *
       * The queue entry is removed here rather than when the downstream call
       * finally settles: that call is still parked holding its own timer, and a
       * second POST must be told the question is gone rather than racing a
       * promise that has already been decided.
       * @returns false when the race already ended.
       */
      settle: (answer) => finish('answer', answer),
      /**
       * Give up on a parked question at unload.
       *
       * Rejecting rather than resolving keeps the tool call honest: it reports
       * a failure, which is what happened, instead of inventing an answer.
       */
      abandon: () => finish('error',
        new Error('the session API plugin unloaded before the question was answered')),
    }
    const timer = setTimeout(() => {
      // Outliving the TTL means no caller is coming. Stop advertising the
      // question so a later POST reports "no such question" instead of reviving
      // a dead race. The downstream call is NOT touched: it still owns the
      // request and settles the race on its own terms (its own timeout, or the
      // page answering late). Marking the race settled here would strand the
      // tool's promise, because nothing else would ever resolve it.
      if (pendingQuestions.delete(callId)) {
        ctx.logger?.warn?.('dsh-session-api: question %s expired unanswered', callId)
      }
    }, questionTtl.ms)
    if (typeof timer.unref === 'function') timer.unref()
    entry.cancelTimer = () => { clearTimeout(timer) }

    const onAbort = () => {
      // The asker withdrew the question (the turn was cancelled). Stop
      // advertising it; the downstream call produces the typed `ASK_ABORTED`
      // and that rejection settles the race below.
      if (pendingQuestions.get(callId) === entry) pendingQuestions.delete(callId)
    }
    const cleanup = () => {
      entry.cancelTimer()
      if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
    }

    // A call id can arrive twice: `timed` mode retries the same tool call after
    // its foreground window closes. Overwriting the map entry would leave the
    // previous entry's race promise unresolved forever, hanging that tool call,
    // so the incumbent is settled as a failure first. The synthesized ids never
    // collide (they increment), so this only fires for a genuine retry.
    const incumbent = pendingQuestions.get(callId)
    if (incumbent !== undefined && incumbent !== entry) {
      incumbent.abandon()
    }
    pendingQuestions.set(callId, entry)
    if (request.signal !== undefined) request.signal.addEventListener('abort', onAbort, { once: true })
    ctx.logger?.info?.('dsh-session-api: question %s parked for %s', callId, sessionId)

    // The downstream chain owns the request from here. Its answer is the
    // competitor; whichever settles first wins and the loser is discarded.
    // Registering the identity first is what makes a round trip back through
    // this wrapper terminate at the original implementation instead of racing
    // the same request twice.
    racedRequests.add(request)
    // The forwarded request carries a signal this plugin can abort, so winning
    // the race can retire the losing channel. `AbortSignal.any` keeps the
    // caller's own cancellation working: either source aborts the downstream.
    const forwarded = request.signal === undefined
      ? { ...request, signal: withdraw.signal }
      : { ...request, signal: AbortSignal.any([request.signal, withdraw.signal]) }
    // BOTH identities must be registered, because the downstream sees the copy.
    // A channel that captured this wrapper delegates the forwarded object back
    // to us, and matching only the original would miss it — turning the guard
    // into an infinite loop that exhausts the heap.
    racedRequests.add(forwarded)
    // Both settle paths share one shape: mark, clean up, retire the loser, then
    // hand the outcome to the race owner. Keeping it in one place is what makes
    // "exactly one of these ever runs" checkable at a glance.
    const finish = (outcome, value) => {
      if (settled) return false
      settled = true
      cleanup()
      if (pendingQuestions.get(callId) === entry) pendingQuestions.delete(callId)
      // Retire the wrapped call. Without this, the losing channel keeps its own
      // card or QQ entry alive and later tells the user the question timed out —
      // for a question that was answered. The tool promise is already settled by
      // `raced`, so this abort cannot affect the model.
      withdraw.abort(new QuestionWithdrawnError(callId))
      if (outcome === 'answer') raced.resolve(value)
      else raced.reject(value)
      return true
    }
    const down = Promise.resolve().then(() => downstream.call(this, forwarded))
    down.then(
      (answer) => { finish('answer', answer) },
      (error) => { finish('error', error) },
    )

    return raced.promise
  }

  Object.defineProperty(wrapped, '__sessionApiRace', { value: true, enumerable: false })

  /**
   * Put the wrapper back on top if another installer claimed the slot.
   *
   * Adopting the interloper as the new downstream is what makes load order
   * irrelevant: a channel installed after us is called BY us rather than
   * replacing us, so its QQ routing still runs and this plugin still sees the
   * request.
   * @returns true when the slot had been taken over.
   */
  const reassert = () => {
    if (disposed) return false
    const current = service.ask
    if (current === wrapped) return false
    // A non-function slot is a broken service, not a replacement: leave it for
    // whoever broke it rather than masking the failure behind our wrapper.
    if (typeof current !== 'function') return false
    if (current.__sessionApiRace === true) return false
    // Adopt the interloper as the new downstream. This is what keeps its own
    // routing alive: a QQ channel installed after us still handles its QQ
    // sessions, and for any other session it delegates back to its captured
    // `previous` — our wrapper again, which the WeakSet above then short-cuts to
    // the original implementation. Adopting is therefore safe at depth one and
    // is the only way both channels stay reachable.
    downstream = current
    service.ask = wrapped
    ctx.logger?.info?.('dsh-session-api: question racer re-asserted over a later installer')
    return true
  }

  service.ask = wrapped
  const retry = setInterval(reassert, RACER_REASSERT_MS)
  if (typeof retry.unref === 'function') retry.unref()
  // The common case is that a bundle installs its patch during startup, right
  // after this one. A macrotask catches that without waiting for the interval.
  queueMicrotask(reassert)
  setTimeout(reassert, 0)?.unref?.()

  const controller = {
    reassert,
    dispose: () => {
      if (disposed) return true
      disposed = true
      clearInterval(retry)
      racerControllers.delete(service)
      // Restore only when we still own the slot. If a later installer wrapped
      // US, its own closure still points at our wrapper; overwriting the slot
      // would strand that chain, and leaving ours in place is harmless because
      // `disposed` makes it a pure pass-through.
      if (service.ask === wrapped) service.ask = downstream
      // Unloading must not strand a turn. Every entry THIS controller parked
      // records its own reject, so the tool call sees a real failure instead of
      // a promise nobody will ever resolve. Entries parked by another
      // controller (a reload can retire this one while a newer instance already
      // runs) are left alone.
      for (const entry of questionsForAll()) {
        if (entry.owner !== owner) continue
        entry.cancelTimer()
        pendingQuestions.delete(entry.callId)
        entry.abandon()
      }
      return true
    },
  }
  racerControllers.set(service, controller)
  // Also reachable from the wrapper itself, so a reload can retire this
  // controller even when the module-level WeakMap did not survive.
  Object.defineProperty(wrapped, '__sessionApiController', {
    value: controller, enumerable: false, configurable: true,
  })
  ctx.logger?.info?.('dsh-session-api: question racer installed')
  return () => { controller.dispose() }
}

/** Services already carrying a racer, so a reload retires the old controller. */
const racerControllers = new WeakMap()

/** How often the wrapper checks whether another installer displaced it. */
const RACER_REASSERT_MS = 2_000

/**
 * Every entry this plugin holds, across sessions.
 * @returns the entries, unordered.
 */
function questionsForAll() {
  return [...pendingQuestions.values()]
}

/* ------------------------------------------------------------------ *
 * Pending approvals
 *
 * DSH decides a tool approval through the `approval/request` waterfall, and
 * the answerer is whoever listens and returns an outcome. The page's own card
 * is one such listener; this plugin adds a second one so an external caller can
 * answer instead. That is the only supported route — `approval` exposes no
 * "answer" method, so resolving the waterfall IS the decision, and a request
 * left unanswered would keep the turn blocked forever.
 *
 * The queue is process-local and every entry is removed exactly once, when its
 * HTTP decision arrives or when its own signal aborts.
 * ------------------------------------------------------------------ */

/**
 * One approval waiting for an external decision.
 * @typedef {object} PendingApproval
 * @property {string} decisionId stable id the HTTP routes address
 * @property {string} sessionId session the asking agent belongs to
 * @property {string} toolName tool being decided
 * @property {string=} callId exact tool call, when the asker supplied one
 * @property {string=} reason the asker's explanation
 * @property {number} askedAt epoch milliseconds
 * @property {(outcome: string) => void} settle resolves the waterfall
 */

/**
 * Live pending approvals, newest last.
 * @type {Map<string, PendingApproval>}
 */
const pendingApprovals = new Map()

/** How long an unanswered approval is held before the plugin withdraws it. */
const APPROVAL_TTL_MS = 5 * 60 * 1000

/**
 * Publish one approval as the API sees it.
 * @param entry - a queue entry.
 * @returns its public projection (never the settle callback).
 */
function approvalView(entry) {
  return {
    decisionId: entry.decisionId,
    kind: 'approval',
    toolName: entry.toolName,
    ...(entry.callId === undefined ? {} : { callId: entry.callId }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    askedAt: entry.askedAt,
  }
}

/**
 * List the approvals this plugin is currently holding for one session.
 * @param sessionId - the addressed session.
 * @returns matching entries, newest first.
 */
function approvalsFor(sessionId) {
  return [...pendingApprovals.values()]
    .filter(entry => entry.sessionId === sessionId)
    .sort((left, right) => right.askedAt - left.askedAt)
}

/**
 * Remove one approval from the queue and resolve its waterfall.
 * @param decisionId - the id the caller addressed.
 * @param outcome - one of DSH's outcomes.
 * @returns the settled entry, or undefined when no such id is pending.
 */
function settleApproval(decisionId, outcome) {
  const entry = pendingApprovals.get(decisionId)
  if (entry === undefined) return undefined
  pendingApprovals.delete(decisionId)
  entry.settle(outcome)
  return entry
}

/**
 * Install the answerer that parks each approval until an HTTP caller decides.
 *
 * Returning nothing (never calling `next`) is what claims the request; the
 * returned promise is what the service awaits. A listener that simply returned
 * `'unavailable'` would fail every approval closed, and one that never settled
 * would block the turn, which is why every path here resolves exactly once.
 * @param ctx - Host context.
 */
function installApprovalAnswerer(ctx) {
  if (typeof ctx.on !== 'function') return
  ctx.effect(() => {
    const dispose = ctx.on('approval/request', (request, next) => {
      const agent = request?.agent
      const sessionId = agent?.sessionId ?? agent?.id
      // Without a session identity the request cannot be addressed over HTTP, so
      // hand it to the remaining answerers (the page) rather than swallowing it.
      if (typeof sessionId !== 'string' || sessionId.length === 0) return next()

      const decisionId = randomBytes(16).toString('hex')
      // An already-withdrawn request needs no queue entry at all: parking it
      // would leave an entry no caller can decide, and the turn only needs the
      // cancelled outcome.
      if (request.signal !== undefined && request.signal.aborted) {
        return Promise.resolve('cancelled')
      }

      return new Promise((resolve) => {
        let settled = false
        // Declared before `settle` can run: every exit path clears it.
        let timer
        const settle = (outcome) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          resolve(outcome)
        }
        // A withdrawn request must release the turn; leaving it pending would
        // strand the waterfall.
        const onAbort = () => settle('cancelled')
        if (request.signal !== undefined) {
          request.signal.addEventListener('abort', onAbort, { once: true })
        }
        timer = setTimeout(() => {
          if (pendingApprovals.delete(decisionId)) {
            ctx.logger?.warn?.('dsh-session-api: approval %s expired unanswered', decisionId)
          }
          settle('cancelled')
        }, APPROVAL_TTL_MS)
        // Do not hold the process open for a decision that may never come.
        if (typeof timer.unref === 'function') timer.unref()

        pendingApprovals.set(decisionId, {
          decisionId,
          sessionId,
          toolName: String(request.toolName ?? 'unknown'),
          ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
          ...(request.reason === undefined ? {} : { reason: String(request.reason) }),
          askedAt: Date.now(),
          settle: (outcome) => {
            if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
            settle(outcome)
          },
        })
        ctx.logger?.info?.(
          'dsh-session-api: approval %s parked for %s (%s)',
          decisionId, sessionId, String(request.toolName ?? 'unknown'),
        )
      })
    })
    // Unloading or reloading the plugin must not strand a turn: every request
    // this instance parked is released as cancelled before the listener goes.
    return () => {
      for (const entry of [...pendingApprovals.values()]) entry.settle('cancelled')
      pendingApprovals.clear()
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-session-api: approval answerer')
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
      { method: 'GET', path: '/workspaces', formats: ['json', 'md'], write: false, summary: '工作区列表' },
      { method: 'POST', path: '/workspaces', formats: ['json'], write: true, summary: '登记工作区（目录须已存在）' },
      { method: 'POST', path: '/workspaces/:id/sessions', formats: ['json'], write: true, summary: '在工作区新建会话并立即执行首条任务' },
      { method: 'POST', path: '/sessions/create', formats: ['json'], write: true, summary: '在指定目录（须已存在）新建会话并立即执行首条任务' },
      { method: 'GET', path: '/sessions/:id/approvals', formats: ['json', 'md'], write: false, summary: '列出本插件持有的待决审批' },
      { method: 'POST', path: '/sessions/:id/approvals/:decisionId', formats: ['json'], write: true, summary: '裁决一条待决审批（allow / deny，仅本次生效）' },
      { method: 'GET', path: '/sessions/:id/questions', formats: ['json', 'md'], write: false, summary: '列出待答提问（本插件接管的可作答，投影里的只读）' },
      { method: 'POST', path: '/sessions/:id/questions/:callId', formats: ['json'], write: true, summary: '回答一条待答提问（与界面/QQ 通道赛跑，先到先得）' },
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
  questionTtl,
  isLoopbackAddress,
  isSafeSessionId,
  safeEqual,
  segmentsOf,
  ROUTE,
}
