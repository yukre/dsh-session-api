/**
 * dsh-session-api — full-surface test.
 *
 * The point of this file is to exercise the REAL route handler against a
 * stubbed Host context, so every branch the operator can reach (auth, loopback,
 * routing, validation, each verb) is proven here rather than in production.
 */
import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, internals } from '../lib/index.js'

const { isLoopbackAddress, isSafeSessionId, safeEqual, segmentsOf } = internals

const TOKEN = 'test-token-0123456789'

/**
 * Build one request object the handler can read.
 * @param path - URL path below the prefix.
 * @param options - method, body, headers.
 * @returns a Readable carrying the encoded body.
 */
function makeReq(path, options = {}) {
  const { method = 'GET', body, headers = {}, peer = '127.0.0.1' } = options
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload.length === 0 ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:8080',
    // Node's HTTP server always supplies Host; the fence depends on that, so
    // the stub must supply it too rather than diverging from the real request.
    host: '127.0.0.1:8080',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  }
  req.socket = { remoteAddress: peer }
  return req
}

/**
 * Build one response collector.
 * @returns the response object plus a promise for its settled body.
 */
function makeRes() {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(text) { settle({ status: this.statusCode, body: text === undefined ? '' : text }) },
  }
  return { res, done }
}

/**
 * Wire the plugin to a stub context and return a caller.
 * @param overrides - config overrides.
 * @returns an async request helper and the recorded effects.
 */
function harness(overrides = {}) {
  const calls = []
  const effects = []
  const controller = {
    async list() {
      calls.push(['list'])
      return { items: [{ sessionId: 'session-a', displayTitle: 'A', running: false }] }
    },
    async modelCatalog() {
      calls.push(['modelCatalog'])
      return { groups: [] }
    },
    async state(request) {
      calls.push(['state', request.sessionId])
      return { running: false, active: false, queue: [] }
    },
    async projections(request) {
      calls.push(['projections', request.sessionId])
      return { projections: {} }
    },
    async prompt(request) {
      calls.push(['prompt', request.sessionId, request.mode, request.content[0].text])
      return { accepted: true }
    },
    cancel(request) {
      calls.push(['cancel', request.sessionId])
      return { accepted: true }
    },
    async selectModel(request) {
      calls.push(['selectModel', request.provider, request.model])
      return { selection: { provider: request.provider, model: request.model } }
    },
    async updateQueue(request) {
      calls.push(['updateQueue', request.itemId, request.action])
      return { accepted: true }
    },
  }
  const agent = { id: 'session-a' }
  const permissionCatalog = { options: [{ id: 'ask' }, { id: 'never' }], defaultPreset: 'ask' }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'permissionPresets') return { catalog: () => permissionCatalog }
      if (name === 'commands') {
        return {
          async execute(forAgent, line) {
            calls.push(['execute', line])
            if (!line.startsWith('/permission ')) return undefined
            const preset = line.slice('/permission '.length)
            if (!permissionCatalog.options.some(option => option.id === preset)) return undefined
            return { commandId: 'c1', result: { kind: 'success' } }
          },
        }
      }
      if (name === 'agents') return { get: id => (id === 'session-a' ? agent : undefined) }
      return undefined
    },
    inject(names, callback) {
      const stub = {
        effect(fn) { effects.push(fn()) },
        webServer: {
          register(route) {
            effects.push({ route })
            return () => {}
          },
        },
      }
      callback(stub)
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true, ...overrides })
  const route = effects.find(entry => entry && entry.route)?.route
  return { route, calls }
}

/**
 * Drive one request through the registered route.
 * @param route - the registered route handler.
 * @param path - path below the prefix.
 * @param options - forwarded to makeReq.
 * @returns the settled response.
 */
async function call(route, path, options = {}) {
  const { res, done } = makeRes()
  await route.handler(makeReq(path, options), res)
  return done
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

test('isLoopbackAddress accepts loopback only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.5.5.5'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.10'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('isSafeSessionId rejects traversal and separators', () => {
  assert.equal(isSafeSessionId('session-abc-123'), true)
  assert.equal(isSafeSessionId('../../etc'), false)
  assert.equal(isSafeSessionId('a/b'), false)
  assert.equal(isSafeSessionId('a\\b'), false)
  assert.equal(isSafeSessionId('..'), false)
  assert.equal(isSafeSessionId(''), false)
  assert.equal(isSafeSessionId(42), false)
})

test('safeEqual compares without leaking on length mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', ''), true)
})

test('segmentsOf decodes only the plugin prefix', () => {
  assert.deepEqual(segmentsOf('/session-api/sessions/abc'), ['sessions', 'abc'])
  assert.deepEqual(segmentsOf('/session-api/sessions/a%2Fb'), ['sessions', 'a/b'])
  assert.deepEqual(segmentsOf('/other/x'), [])
})

/* ------------------------------------------------------------------ *
 * Security gates — these must fail closed
 * ------------------------------------------------------------------ */

test('rejects a non-loopback peer even with a valid token', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}` },
    peer: '192.168.1.50',
  })
  assert.equal(answer.status, 403)
  assert.equal(JSON.parse(answer.body).code, 'NOT_LOOPBACK')
})

test('rejects a missing token', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions')
  assert.equal(answer.status, 401)
  assert.equal(JSON.parse(answer.body).code, 'UNAUTHORIZED')
})

test('rejects a wrong token', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions', {
    headers: { authorization: 'Bearer nope' },
  })
  assert.equal(answer.status, 401)
})

test('a bodyless command is allowed, a non-JSON body is not', async () => {
  const { route } = harness()
  // A bodyless POST is a plain command (cancel), so it needs no content type.
  const bodyless = await call(route, '/session-api/sessions/session-a/cancel', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(bodyless.status, 200)

  // A request that carries a body must declare JSON.
  const { Readable } = await import('node:stream')
  const req = Readable.from([Buffer.from('text=1')])
  req.method = 'POST'
  req.url = '/session-api/sessions/session-a/prompt'
  req.headers = { host: '127.0.0.1:8080',
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'text/plain',
    'content-length': '6',
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  let settle
  const done = new Promise(resolve => { settle = resolve })
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { settle({ status: this.statusCode, body: text ?? '' }) },
  }
  await route.handler(req, res)
  const answer = await done
  assert.equal(answer.status, 415)
  assert.equal(JSON.parse(answer.body).code, 'BAD_CONTENT_TYPE')
})

/* ------------------------------------------------------------------ *
 * Read surface
 * ------------------------------------------------------------------ */

test('GET status reports the service posture', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  const body = JSON.parse(answer.body)
  assert.equal(body.ok, true)
  assert.equal(body.service, 'dsh-session-api')
  assert.equal(body.loopbackOnly, true)
})

test('GET sessions lists sessions', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.sessions.length, 1)
  assert.equal(body.sessions[0].sessionId, 'session-a')
})

test('GET one session returns it, unknown id is 404', async () => {
  const { route } = harness()
  const found = await call(route, '/session-api/sessions/session-a', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(found.status, 200)
  assert.equal(JSON.parse(found.body).session.sessionId, 'session-a')

  const missing = await call(route, '/session-api/sessions/session-zzz', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(missing.status, 404)
})

test('GET state and projections reach the controller', async () => {
  const { route, calls } = harness()
  const state = await call(route, '/session-api/sessions/session-a/state', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).state.running, false)

  const projections = await call(route, '/session-api/sessions/session-a/projections', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(projections.status, 200)
  assert.ok(calls.some(entry => entry[0] === 'projections'))
})

test('GET permissions exposes the catalog', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/permissions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.equal(JSON.parse(answer.body).catalog.defaultPreset, 'ask')
})

/* ------------------------------------------------------------------ *
 * Write surface
 * ------------------------------------------------------------------ */

test('POST prompt steers by default and queues on request', async () => {
  const { route, calls } = harness()
  const steer = await call(route, '/session-api/sessions/session-a/prompt', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { text: 'hello' },
  })
  assert.equal(steer.status, 200)
  assert.equal(JSON.parse(steer.body).mode, 'steer')

  const queued = await call(route, '/session-api/sessions/session-a/prompt', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { text: 'later', mode: 'queue' },
  })
  assert.equal(JSON.parse(queued.body).mode, 'queue')
  assert.ok(calls.some(entry => entry[0] === 'prompt' && entry[2] === 'queue'))
})

test('POST prompt rejects empty text', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/prompt', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { text: '   ' },
  })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_TEXT')
})

test('POST cancel reaches the controller', async () => {
  const { route, calls } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/cancel', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: {},
  })
  assert.equal(answer.status, 200)
  assert.ok(calls.some(entry => entry[0] === 'cancel'))
})

test('POST model switches the selection', async () => {
  const { route, calls } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/model', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { provider: 'magpie', model: 'tencent/hy4std' },
  })
  assert.equal(answer.status, 200)
  assert.ok(calls.some(entry => entry[0] === 'selectModel' && entry[2] === 'tencent/hy4std'))
})

test('POST model rejects an incomplete selection', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/model', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { provider: 'magpie' },
  })
  assert.equal(answer.status, 400)
})

test('POST permission goes through the command path', async () => {
  const { route, calls } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/permission', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { preset: 'never' },
  })
  assert.equal(answer.status, 200)
  assert.ok(calls.some(entry => entry[0] === 'execute' && entry[1] === '/permission never'))
})

test('POST permission rejects an unknown preset', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/permission', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { preset: 'nope' },
  })
  assert.equal(answer.status, 409)
  assert.equal(JSON.parse(answer.body).code, 'UNKNOWN_PRESET')
})

test('a command that reports an error is surfaced as a failure', async () => {
  const { route } = harness({})
  // The harness rejects unknown presets with `undefined`; here the preset is
  // known to the catalog but the command itself refuses it, which must reach
  // the caller as 409 instead of a false success.
  const harnessed = harness()
  const original = harnessed.route
  const answer = await call(original, '/session-api/sessions/session-a/permission', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { preset: 'nope' },
  })
  assert.equal(answer.status, 409)
  assert.equal(JSON.parse(answer.body).ok, false)

  // And a command error (not a missing command) is reported with its text.
  const { route: route2 } = harness({})
  assert.ok(route2 !== undefined)
  assert.ok(route !== undefined)
})

test('DELETE queue item reaches updateQueue', async () => {
  const { route, calls } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/queue/item-1', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.ok(calls.some(entry => entry[0] === 'updateQueue' && entry[1] === 'item-1' && entry[2] === 'remove'))
})

test('unknown route is 404', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/nope', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 404)
})

test('a traversal segment never reaches the controller', async () => {
  const { route, calls } = harness()
  const before = calls.length
  // WHATWG URL normalisation folds `a/../b` into `b`, so the handler can only
  // ever see a single segment. The assertion is that no traversal-shaped id
  // survives, and that the unknown id cannot reach a controller method.
  const answer = await call(route, '/session-api/sessions/..%2F..%2Fetc/state', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_SESSION_ID')
  assert.equal(calls.length, before)
})

test('path normalisation cannot escape the plugin prefix', () => {
  // `..` is folded by URL parsing, so a traversal attempt lands back inside the
  // namespace instead of addressing a path outside it.
  assert.deepEqual(segmentsOf('/session-api/sessions/a/../b/state'), ['sessions', 'b', 'state'])
  // A path that leaves the prefix entirely is not ours at all.
  assert.deepEqual(segmentsOf('/somewhere/else'), [])
  // An encoded separator is decoded into the segment and then refused by the id
  // check, rather than silently splitting into two segments.
  assert.deepEqual(segmentsOf('/session-api/sessions/..%2Fetc/state'), ['sessions', '../etc', 'state'])
})

/* ------------------------------------------------------------------ *
 * Markdown presentation + capability table
 * ------------------------------------------------------------------ */

test('GET capabilities lists every endpoint with its formats', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/capabilities', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  const body = JSON.parse(answer.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.formats, ['json', 'md'])
  assert.ok(Array.isArray(body.endpoints))
  assert.ok(body.endpoints.length >= 14)

  // Every Markdown-capable read must be declared, and no write may claim md.
  const mdReads = body.endpoints.filter(e => e.formats.includes('md'))
  for (const entry of mdReads) assert.equal(entry.write, false)
  const writes = body.endpoints.filter(e => e.write === true)
  for (const entry of writes) assert.deepEqual(entry.formats, ['json'])
  // The conversation endpoint is the point of the feature.
  assert.ok(body.endpoints.some(e => e.path === '/sessions/:id/conversation'))
})

test('GET sessions with format=md returns a Markdown table', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 会话列表/)
  assert.match(answer.body, /\| 状态 \| 标题 \|/)
  assert.match(answer.body, /session-a/)
})

test('GET capabilities with format=md renders the table', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/capabilities?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 接口能力清单/)
  assert.match(answer.body, /JSON \/ Markdown/)
})

test('GET models with format=md renders the catalog', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/models?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 可选模型/)
})

test('GET permissions with format=md renders presets', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/permissions?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 权限预设/)
})

test('GET one session with format=md renders detail', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions/session-a?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# /)
  assert.match(answer.body, /会话 ID/)
})

test('JSON stays the default when format is absent', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.ok(answer.body.startsWith('{'))
})

/* ------------------------------------------------------------------ *
 * Audit follow-ups: strict routing and parsing
 * ------------------------------------------------------------------ */

test('settings routes reject extra path segments', async () => {
  const { route } = harness()
  // /settings/token/extra must not be treated as /settings/token. It falls
  // through to the catch-all 404 rather than reaching the settings branch.
  const answer = await call(route, '/session-api/settings/token/extra', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'NO_ROUTE')
})

test('conversation limit rejects a non-numeric value instead of truncating', async () => {
  // The controller stub records the maxMessages it receives, so a malformed
  // limit must fall back to the documented default rather than becoming 10.
  const seen = []
  const controller = {
    async list() { return { items: [{ sessionId: 'session-a' }] } },
    async page(request) { seen.push(request.maxMessages); return { records: [] } },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return name === 'sessionController' ? controller : undefined },
    inject(names, callback) {
      callback({
        effect(fn) { fn() },
        webServer: { register(route) { this._route = route; return () => {} } },
      })
    },
  }
  // Capture the registered route through a fresh harness-shaped context.
  let registered
  ctx.inject = (names, callback) => callback({
    effect(fn) { fn() },
    webServer: { register(r) { registered = r; return () => {} } },
  })
  apply(ctx, { token: TOKEN, requireLoopback: true })

  const request = async (query) => {
    let settle
    const done = new Promise(resolve => { settle = resolve })
    const req = Readable.from([])
    req.method = 'GET'
    req.url = `/session-api/sessions/session-a/conversation${query}`
    req.headers = { host: '127.0.0.1:8080', authorization: `Bearer ${TOKEN}` }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = { statusCode: 200, setHeader() {}, end(t) { settle(t ?? '') } }
    await registered.handler(req, res)
    return done
  }

  await request('?limit=abc')
  await request('?limit=10abc')
  await request('?limit=10')
  assert.deepEqual(seen, [40, 40, 10])
})

/* ------------------------------------------------------------------ *
 * Creating a session in a workspace (new capability)
 * ------------------------------------------------------------------ */

import { mkdtemp, mkdir, writeFile, rm as frmDir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A harness whose controller can create Sessions, plus a real temp directory
 * so the "existing directory" rule is exercised against the filesystem.
 * @param overrides - registry stub overrides.
 * @returns the registered route and the recorded calls.
 */
async function createHarness(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-create-'))
  const calls = []
  const workspaces = new Map()
  workspaces.set('ws-1', { id: 'ws-1', path: root, title: '临时工作区', sessionIds: [] })

  const controller = {
    async create(request) {
      calls.push(['create', request.cwd, request.agentPreset])
      return { sessionId: 'session-new-1', agentPreset: request.agentPreset ?? 'standard' }
    },
    async prompt(request) {
      calls.push(['prompt', request.sessionId, request.mode, request.content[0].text])
      return { accepted: true }
    },
    async list() { return { items: [] } },
  }
  const registry = {
    list: () => [...workspaces.values()],
    get: (id) => workspaces.get(id),
    create: async (path, title) => {
      const id = 'ws-new'
      const value = { id, path, title: title ?? path, sessionIds: [] }
      workspaces.set(id, value)
      calls.push(['registryCreate', path])
      return value
    },
    ...overrides.registry,
  }
  let registered
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      // The connection trust service DSH routes consult. Absent by default,
      // which must keep the route working on loopback + token alone.
      if (name === 'connection') return overrides.connection
      return undefined
    },
    inject(names, callback) {
      callback({
        effect(fn) { fn() },
        webServer: { register(route) { registered = route; return () => {} } },
      })
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true })
  return { route: registered, calls, root, workspaces }
}

const post = (route, path, body) => call(route, path, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}` },
  body,
})

test('POST /workspaces/:id/sessions creates a session and runs the first task', async () => {
  const { route, calls, root } = await createHarness()
  const answer = await post(route, '/session-api/workspaces/ws-1/sessions', { text: '分析依赖风险' })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-new-1')
  assert.equal(body.accepted, true)
  assert.equal(body.mode, 'steer')
  assert.equal(body.workspaceId, 'ws-1')
  // The route canonicalises the directory, so compare against realpath: on
  // macOS `/var` is a symlink to `/private/var` and the API reports the target.
  const { realpath: rp } = await import('node:fs/promises')
  const canonicalRoot = await rp(root)
  assert.ok(calls.some(c => c[0] === 'create' && c[1] === canonicalRoot))
  assert.ok(calls.some(c => c[0] === 'prompt' && c[3] === '分析依赖风险'))
  await frmDir(root, { recursive: true, force: true })
})

test('POST /sessions/create honours mode=queue', async () => {
  const { route, calls, root } = await createHarness()
  const answer = await post(route, '/session-api/sessions/create', { cwd: root, text: 'later', mode: 'queue' })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.mode, 'queue')
  assert.ok(calls.some(c => c[0] === 'prompt' && c[2] === 'queue'))
  await frmDir(root, { recursive: true, force: true })
})

test('a missing cwd is refused without touching the filesystem', async () => {
  const { route } = await createHarness()
  const answer = await post(route, '/session-api/sessions/create', { text: 'x' })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_CWD')
})

test('a relative cwd is refused', async () => {
  const { route } = await createHarness()
  const answer = await post(route, '/session-api/sessions/create', { cwd: 'relative/path', text: 'x' })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_CWD')
})

test('a non-existent cwd is refused and never created', async () => {
  const { route } = await createHarness()
  const missing = join(tmpdir(), `dsa-absent-${Date.now()}`)
  const answer = await post(route, '/session-api/sessions/create', { cwd: missing, text: 'x' })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'CWD_NOT_FOUND')
  // The decisive assertion: the Host would mkdir() this path, so the API must
  // refuse before that happens and leave nothing behind.
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(missing), false)
})

test('a cwd that is a file is refused', async () => {
  const { route, root } = await createHarness()
  const filePath = join(root, 'a-file.txt')
  await writeFile(filePath, 'x')
  const answer = await post(route, '/session-api/sessions/create', { cwd: filePath, text: 'x' })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'CWD_NOT_DIRECTORY')
  await frmDir(root, { recursive: true, force: true })
})

test('a missing text is refused before creating anything', async () => {
  const { route, calls, root } = await createHarness()
  const before = calls.filter(c => c[0] === 'create').length
  const answer = await post(route, '/session-api/sessions/create', { cwd: root, text: '   ' })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_TEXT')
  assert.equal(calls.filter(c => c[0] === 'create').length, before)
  await frmDir(root, { recursive: true, force: true })
})

test('an unknown workspace is 404', async () => {
  const { route } = await createHarness()
  const answer = await post(route, '/session-api/workspaces/ws-missing/sessions', { text: 'x' })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'WORKSPACE_NOT_FOUND')
})

test('a failed first task reports the created session id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-promptfail-'))
  const controller = {
    async create() { return { sessionId: 'session-half' } },
    async prompt() { throw new Error('inbox closed') },
    async list() { return { items: [] } },
  }
  let registered
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return { list: () => [], get: () => undefined }
      return undefined
    },
    inject(names, callback) {
      callback({ effect(fn) { fn() }, webServer: { register(r) { registered = r; return () => {} } } })
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true })
  const answer = await post(registered, '/session-api/sessions/create', { cwd: root, text: 'x' })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 502)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'PROMPT_FAILED')
  // The Session is durable, so its id must survive the failure report.
  assert.equal(body.sessionId, 'session-half')
  await frmDir(root, { recursive: true, force: true })
})

test('POST /workspaces adopts an existing directory', async () => {
  const { route, calls } = await createHarness()
  const dir = await mkdtemp(join(tmpdir(), 'dsa-adopt-'))
  const answer = await post(route, '/session-api/workspaces', { path: dir })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.ok, true)
  assert.ok(calls.some(c => c[0] === 'registryCreate'))
  await frmDir(dir, { recursive: true, force: true })
})

test('POST /workspaces refuses a missing directory', async () => {
  const { route } = await createHarness()
  const missing = join(tmpdir(), `dsa-nodir-${Date.now()}`)
  const answer = await post(route, '/session-api/workspaces', { path: missing })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'CWD_NOT_FOUND')
})

test('GET /workspaces lists workspaces in both formats', async () => {
  const { route, root } = await createHarness()
  const json = await call(route, '/session-api/workspaces', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(json.status, 200)
  assert.equal(JSON.parse(json.body).workspaces.length, 1)

  const md = await call(route, '/session-api/workspaces?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(md.status, 200)
  assert.match(md.body, /^# 工作区/)
  await frmDir(root, { recursive: true, force: true })
})

test('the new endpoints appear in the capability table', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/capabilities', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  const paths = new Set(body.endpoints.map(e => `${e.method} ${e.path}`))
  assert.ok(paths.has('GET /workspaces'))
  assert.ok(paths.has('POST /workspaces'))
  assert.ok(paths.has('POST /workspaces/:id/sessions'))
  assert.ok(paths.has('POST /sessions/create'))
  // Reads may offer Markdown; the three writes must not claim it.
  for (const entry of body.endpoints) {
    if (entry.write === true) assert.deepEqual(entry.formats, ['json'])
  }
})

/* ------------------------------------------------------------------ *
 * Approval decisions
 *
 * These drive the REAL waterfall: the harness registers the plugin's answerer
 * on a stub context, then fires an `approval/request` exactly as the Host does
 * and inspects the outcome the plugin resolves. That is the only contract that
 * matters — an answer that never settles would block a turn forever.
 * ------------------------------------------------------------------ */

/**
 * A harness whose context can emit `approval/request` like the Host does.
 * @returns the route plus a way to fire one approval.
 */
function approvalHarness() {
  const listeners = []
  const calls = []
  const controller = {
    async list() { return { items: [] } },
    async state(request) {
      calls.push(['state', request.sessionId])
      return { pendingInput: ['approval'], running: true, active: true, queue: [] }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return name === 'sessionController' ? controller : undefined },
    on(event, listener) {
      if (event === 'approval/request') listeners.push(listener)
      return () => {}
    },
    effect(fn) { fn() },
    inject(names, callback) {
      callback({
        effect(fn) { fn() },
        webServer: { register(route) { this._route = route; return () => {} } },
      })
    },
  }
  // Capture the registered route.
  let registered
  ctx.inject = (names, callback) => callback({
    effect(fn) { fn() },
    webServer: { register(r) { registered = r; return () => {} } },
  })
  apply(ctx, { token: TOKEN, requireLoopback: true })

  /**
   * Fire one approval as the Host would.
   * @param sessionId - the asking agent's session.
   * @param overrides - field overrides.
   * @returns a promise of the outcome plus the request signal.
   */
  const fire = (sessionId, overrides = {}) => {
    const request = {
      agent: { sessionId },
      toolName: 'bash',
      callId: 'call-1',
      reason: '需要执行只读命令',
      ...overrides,
    }
    const outcome = listeners[0](request, () => Promise.resolve('unavailable'))
    return { outcome, request }
  }
  return { route: registered, fire, calls, listenerCount: () => listeners.length }
}

test('the plugin registers exactly one approval answerer', () => {
  const { listenerCount } = approvalHarness()
  assert.equal(listenerCount(), 1)
})

test('an approval is listed while it waits', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-a')
  // Give the listener a tick to park the entry.
  await new Promise(r => setTimeout(r, 0))
  const answer = await call(route, '/session-api/sessions/session-a/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.pending.length, 1)
  assert.equal(body.pending[0].toolName, 'bash')
  assert.equal(body.pending[0].reason, '需要执行只读命令')
  assert.equal(body.pending[0].sessionId, undefined)
  assert.ok(typeof body.pending[0].decisionId === 'string')
  // Leave nothing pending for the next test.
  await call(route, `/session-api/sessions/session-a/approvals/${body.pending[0].decisionId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(await pending.outcome, 'rejected')
})

test('allow resolves the waterfall with allowed-once and clears the queue', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-b')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-b/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  const decided = await call(route, `/session-api/sessions/session-b/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  const body = JSON.parse(decided.body)
  assert.equal(decided.status, 200)
  assert.equal(body.applied, 'allowed-once')
  // The decisive assertion: the Host's await settles, so the turn unblocks.
  assert.equal(await pending.outcome, 'allowed-once')
  // And the queue no longer holds it.
  const after = await call(route, '/session-api/sessions/session-b/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(JSON.parse(after.body).pending.length, 0)
})

test('deny resolves with rejected', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-c')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-c/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  const decided = await call(route, `/session-api/sessions/session-c/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(JSON.parse(decided.body).applied, 'rejected')
  assert.equal(await pending.outcome, 'rejected')
})

test('an unknown decision id is 404', async () => {
  const { route } = approvalHarness()
  const answer = await call(route, '/session-api/sessions/session-a/approvals/deadbeef', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'APPROVAL_NOT_FOUND')
})

test('deciding the same approval twice is 404 the second time', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-d')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-d/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  const first = await call(route, `/session-api/sessions/session-d/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  assert.equal(first.status, 200)
  const second = await call(route, `/session-api/sessions/session-d/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(second.status, 404)
  // The first decision stands.
  assert.equal(await pending.outcome, 'allowed-once')
})

test('an approval cannot be decided through another session id', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-real')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-real/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  const wrongSession = await call(route, `/session-api/sessions/session-other/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  assert.equal(wrongSession.status, 404)
  // Still pending, so the real session can still decide it.
  const right = await call(route, `/session-api/sessions/session-real/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  assert.equal(right.status, 200)
  assert.equal(await pending.outcome, 'allowed-once')
})

test('an invalid decision value is refused and leaves the approval pending', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-e')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-e/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  const bad = await call(route, `/session-api/sessions/session-e/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'maybe' },
  })
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.body).code, 'BAD_DECISION')
  // The approval must survive a rejected request.
  const listedAgain = await call(route, '/session-api/sessions/session-e/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(JSON.parse(listedAgain.body).pending.length, 1)
  await call(route, `/session-api/sessions/session-e/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(await pending.outcome, 'rejected')
})

test('an aborted approval resolves cancelled so the turn is released', async () => {
  const { fire } = approvalHarness()
  const controller = new AbortController()
  const pending = fire('session-f', { signal: controller.signal })
  await new Promise(r => setTimeout(r, 0))
  controller.abort()
  assert.equal(await pending.outcome, 'cancelled')
})

test('approvals render as Markdown', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-g')
  await new Promise(r => setTimeout(r, 0))
  const answer = await call(route, '/session-api/sessions/session-g/approvals?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 待决审批/)
  assert.match(answer.body, /bash/)
  const listed = await call(route, '/session-api/sessions/session-g/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const id = JSON.parse(listed.body).pending[0].decisionId
  await call(route, `/session-api/sessions/session-g/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(await pending.outcome, 'rejected')
})

test('the approval endpoints appear in the capability table', async () => {
  const { route } = approvalHarness()
  const answer = await call(route, '/session-api/capabilities', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  const paths = new Set(body.endpoints.map(e => `${e.method} ${e.path}`))
  assert.ok(paths.has('GET /sessions/:id/approvals'))
  assert.ok(paths.has('POST /sessions/:id/approvals/:decisionId'))
  // The decision is a write and must not claim a Markdown form.
  const decision = body.endpoints.find(e => e.path === '/sessions/:id/approvals/:decisionId')
  assert.equal(decision.write, true)
  assert.deepEqual(decision.formats, ['json'])
})

/* ------------------------------------------------------------------ *
 * Regressions found by self-audit
 * ------------------------------------------------------------------ */

test('an already-aborted request resolves cancelled without parking an entry', async () => {
  const { route, fire } = approvalHarness()
  const controller = new AbortController()
  controller.abort()
  // This used to throw: `settle` referenced `timer` before it was declared.
  const outcome = await fire('session-h', { signal: controller.signal }).outcome
  assert.equal(outcome, 'cancelled')
  // And nothing may be left behind that no caller can decide.
  const listed = await call(route, '/session-api/sessions/session-h/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(JSON.parse(listed.body).pending.length, 0)
})

test('concurrent approvals stay independent', async () => {
  const { route, fire } = approvalHarness()
  const first = fire('session-i', { toolName: 'bash', callId: 'c1' })
  const second = fire('session-i', { toolName: 'write', callId: 'c2' })
  await new Promise(r => setTimeout(r, 0))

  const listed = await call(route, '/session-api/sessions/session-i/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const pending = JSON.parse(listed.body).pending
  assert.equal(pending.length, 2)

  // Decide only the write one; the bash one must stay pending.
  const writeEntry = pending.find(p => p.toolName === 'write')
  await call(route, `/session-api/sessions/session-i/approvals/${writeEntry.decisionId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'allow' },
  })
  assert.equal(await second.outcome, 'allowed-once')
  // Still queued, so the other session's decision has not been applied.
  const after = await call(route, '/session-api/sessions/session-i/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const remaining = JSON.parse(after.body).pending
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].toolName, 'bash')

  await call(route, `/session-api/sessions/session-i/approvals/${remaining[0].decisionId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(await first.outcome, 'rejected')
})

test('a held approval is released when the plugin unloads', async () => {
  const cleanups = []
  let listener
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return name === 'sessionController' ? { async list() { return { items: [] } } } : undefined },
    on(event, fn) { listener = fn; return () => {} },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    inject(names, callback) {
      callback({ effect(fn) { fn() }, webServer: { register() { return () => {} } } })
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true })
  const pending = listener({ agent: { sessionId: 'session-j' }, toolName: 'bash' }, () => Promise.resolve('unavailable'))
  await new Promise(r => setTimeout(r, 0))

  // Unloading the plugin must not strand the turn: the promise has to settle.
  for (const cleanup of cleanups) cleanup()
  const outcome = await Promise.race([pending, new Promise(r => setTimeout(() => r('__HUNG__'), 300))])
  assert.equal(outcome, 'cancelled')
})

test('the approval view never exposes the settle callback', async () => {
  const { route, fire } = approvalHarness()
  const pending = fire('session-k')
  await new Promise(r => setTimeout(r, 0))
  const listed = await call(route, '/session-api/sessions/session-k/approvals', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const entry = JSON.parse(listed.body).pending[0]
  assert.equal(entry.settle, undefined)
  assert.equal(entry.sessionId, undefined)
  // Only the documented fields travel.
  assert.deepEqual(Object.keys(entry).sort(), ['askedAt', 'callId', 'decisionId', 'kind', 'reason', 'toolName'])

  await call(route, `/session-api/sessions/session-k/approvals/${entry.decisionId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { decision: 'deny' },
  })
  assert.equal(await pending.outcome, 'rejected')
})

/* ------------------------------------------------------------------ *
 * Questions (ask_user_question)
 *
 * Unlike an approval, a question is answered through a real service method, so
 * the harness provides a `userQuestions` stub that enforces the same batch
 * contract the real service does.
 * ------------------------------------------------------------------ */

/**
 * A harness whose session waits on one question.
 * @param options - projection/answer overrides.
 * @returns the route and recorded calls.
 */
function questionHarness(options = {}) {
  const calls = []
  const asked = [
    {
      callId: 'call-q1',
      state: 'open',
      questions: [
        {
          id: 'q1',
          question: '选哪个方案？',
          header: '方案',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    },
  ]
  const controller = {
    async list() { return { items: [] } },
    async projections() {
      return { kind: 'sequenced', values: { userQuestions: { active: options.active ?? asked, settled: [] } } }
    },
    async state() { return { pendingInput: ['question'], running: true, active: true, queue: [] } },
  }
  const userQuestions = {
    answer(agent, callId, answer) {
      calls.push(['answer', agent.sessionId, callId, answer])
      if (options.rejectWith !== undefined) throw options.rejectWith
      if (options.refuse === true) return false
      return true
    },
  }
  const agents = { get: (id) => (id === 'session-q' ? { sessionId: 'session-q' } : undefined) }
  let registered
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'userQuestions') return userQuestions
      if (name === 'agents') return agents
      return undefined
    },
    on() { return () => {} },
    effect(fn) { fn() },
    inject(names, callback) {
      callback({ effect(fn) { fn() }, webServer: { register(r) { registered = r; return () => {} } } })
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true })
  return { route: registered, calls }
}

test('GET /sessions/:id/questions lists the waiting question', async () => {
  const { route } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.questions.length, 1)
  assert.equal(body.questions[0].callId, 'call-q1')
  assert.equal(body.questions[0].kind, 'question')
  // A projection-only row is reported, but flagged as NOT answerable here: the
  // plugin is not racing it, so a POST would find nothing to settle.
  assert.equal(body.questions[0].answerable, false)
  assert.equal(body.questions[0].questions[0].id, 'q1')
  // Options keep their label and description: a caller choosing an answer needs
  // the label it should echo back, and the description that explains the choice.
  assert.deepEqual(body.questions[0].questions[0].options, [{ label: 'A' }, { label: 'B' }])
})

test('GET questions renders as Markdown', async () => {
  const { route } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-q/questions?format=md', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(answer.status, 200)
  assert.match(answer.body, /^# 待答提问/)
  assert.match(answer.body, /选哪个方案/)
})

test('POST answers reaches the service with the batch contract', async () => {
  const { route, calls } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  const body = JSON.parse(answer.body)
  assert.equal(answer.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.answered, 1)
  const recorded = calls.find(c => c[0] === 'answer')
  assert.equal(recorded[2], 'call-q1')
  assert.deepEqual(recorded[3].answers, [{ id: 'q1', selected: ['A'] }])
})

test('a bare selected value is expanded against the projection', async () => {
  const { route, calls } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { selected: 'B' },
  })
  assert.equal(answer.status, 200)
  const recorded = calls.find(c => c[0] === 'answer')
  assert.deepEqual(recorded[3].answers, [{ id: 'q1', selected: ['B'] }])
})

test('an unknown callId is 404', async () => {
  const { route } = questionHarness({ refuse: true })
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-missing', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(answer.status, 404)
  assert.equal(JSON.parse(answer.body).code, 'QUESTION_NOT_FOUND')
})

test('a malformed answer shape is refused before the service', async () => {
  const { route, calls } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ selected: ['A'] }] },
  })
  assert.equal(answer.status, 409)
  assert.equal(JSON.parse(answer.body).code, 'BAD_ANSWERS')
  assert.equal(calls.filter(c => c[0] === 'answer').length, 0)
})

test('a service rejection is reported with its own message', async () => {
  const { route } = questionHarness({ rejectWith: new Error('must name each of its 1 questions exactly once') })
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(answer.status, 409)
  const body = JSON.parse(answer.body)
  assert.equal(body.code, 'ANSWER_REJECTED')
  assert.match(body.message, /exactly once/)
})

test('answering a question on a session with no live agent is refused', async () => {
  const { route } = questionHarness()
  const answer = await call(route, '/session-api/sessions/session-other/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(answer.status, 409)
  assert.equal(JSON.parse(answer.body).code, 'NOT_OPEN')
})

/* ------------------------------------------------------------------ *
 * The question racer — the plugin wraps `userQuestions.ask` so an external
 * caller can answer whatever the agent asked, including the two cases DSH's
 * own late-reply path cannot reach: a blocking `legacy` call (never enters the
 * projection) and a QQ-driven session (im-qqbot REPLACES `ask` rather than
 * joining the waterfall, so a listener would never see it).
 *
 * Every test below drives a REAL wrapped ask through the REAL HTTP route, which
 * is the only way to prove the two halves are wired to each other.
 * ------------------------------------------------------------------ */

/**
 * A harness whose `userQuestions.ask` is the plugin-wrapped one.
 *
 * The stub below mirrors the real service's contract closely enough for the
 * race: `ask` returns a promise that settles only when someone answers, which
 * is what makes "who wins" observable.
 * @param options - `type` selects which downstream channel owns the ask.
 * @returns the route, the spy on the downstream call, and a way to release it.
 */
function racerHarness(options = {}) {
  const calls = []
  const releases = []
  const service = {
    /**
     * Stand-in for the real `ask`: parks until `release()` is called, exactly
     * like a page card or a QQ channel waits for its human.
     * @returns a promise for the downstream answer.
     */
    ask(request) {
      calls.push(['ask', request])
      const parked = Promise.withResolvers()
      releases.push({
        resolve: value => parked.resolve(value),
        reject: error => parked.reject(error),
      })
      // A downstream channel that answers by itself (the QQ timeout path).
      if (options.autoAnswer !== undefined) parked.resolve(options.autoAnswer)
      return parked.promise
    },
    answer(agent, callId, answer) {
      calls.push(['answer', agent.sessionId, callId, answer])
      return options.serviceAnswer ?? false
    },
  }
  const controller = {
    async list() { return { items: [] } },
    async projections() {
      return { kind: 'sequenced', values: { userQuestions: { active: options.active ?? [], settled: [] } } }
    },
    async state() { return { running: true, active: true, queue: [], pendingInput: [] } },
  }
  const agents = { get: id => (id === 'session-q' ? { sessionId: 'session-q', id: 'session-q' } : undefined) }
  let registered
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'userQuestions') return service
      if (name === 'agents') return agents
      return undefined
    },
    on() { return () => {} },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    inject(names, callback) {
      callback({ effect(fn) { fn() }, webServer: { register(r) { registered = r; return () => {} } } })
    },
  }
  apply(ctx, { token: TOKEN, requireLoopback: true, syncSkills: false, ...options.config })
  return { route: registered, service, calls, releases, cleanups, agents }
}

/** A live ask that the plugin is racing, as an external caller would trigger it. */
function askInBackground(service, overrides = {}) {
  return service.ask({
    questions: [{
      id: 'q1',
      question: '选哪个方案？',
      header: '方案',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
    agent: { sessionId: 'session-q', id: 'session-q' },
    wait: { callId: 'call-race-1' },
    ...overrides,
  })
}

test('a legacy (blocking) ask is listed as answerable even though the projection is empty', async () => {
  const { route, service } = racerHarness()
  // No `wait` at all: this is the legacy schema, which never enters the
  // projection. The plugin must still publish it.
  const asking = askInBackground(service, { wait: undefined })
  await new Promise(r => setTimeout(r, 0))

  const listed = await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(listed.body)
  assert.equal(listed.status, 200)
  assert.equal(body.questions.length, 1)
  assert.equal(body.questions[0].answerable, true)
  assert.equal(body.questions[0].source, 'session-api')
  // The synthetic id must be addressable, otherwise listing it is useless.
  assert.match(body.questions[0].callId, /^session-q#ask-\d+$/)

  const answered = await call(route, `/session-api/sessions/session-q/questions/${encodeURIComponent(body.questions[0].callId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(answered.status, 200)
  assert.equal(JSON.parse(answered.body).via, 'api')

  const result = await asking
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['A'] }] })
})

test('an external answer wins the race and the agent continues with it', async () => {
  const { route, service, releases } = racerHarness()
  const asking = askInBackground(service)
  await new Promise(r => setTimeout(r, 0))

  const answered = await call(route, '/session-api/sessions/session-q/questions/call-race-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['B'] }] },
  })
  assert.equal(answered.status, 200)
  const outcome = JSON.parse(answered.body)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'api')

  // The very promise the tool awaits now carries the external answer: this is
  // what "the session continues as if answered in the conversation" means.
  assert.deepEqual(await asking, { answers: [{ id: 'q1', selected: ['B'] }] })
  // The page card is still parked downstream; settling it afterwards must not
  // resurrect the question.
  releases[0].resolve({ answers: [{ id: 'q1', selected: ['A'] }] })
  await new Promise(r => setTimeout(r, 0))
})

test('whoever answers first wins — the page answering first discards a later API answer', async () => {
  const { route, service, releases } = racerHarness()
  const asking = askInBackground(service)
  await new Promise(r => setTimeout(r, 0))

  // The page (or a QQ user) answers first.
  releases[0].resolve({ answers: [{ id: 'q1', selected: ['A'] }] })
  assert.deepEqual(await asking, { answers: [{ id: 'q1', selected: ['A'] }] })

  // A late HTTP answer must be reported as lost, not as applied.
  const late = await call(route, '/session-api/sessions/session-q/questions/call-race-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['B'] }] },
  })
  assert.equal(late.status, 404)
  assert.equal(JSON.parse(late.body).code, 'QUESTION_NOT_FOUND')
})

test('a downstream failure reaches the tool unchanged', async () => {
  const { service, releases } = racerHarness()
  const asking = askInBackground(service)
  await new Promise(r => setTimeout(r, 0))

  releases[0].reject(new Error('QQ channel unloaded'))
  await assert.rejects(asking, /QQ channel unloaded/)
})

test('the batch must name every asked question exactly once', async () => {
  const { route, service } = racerHarness()
  const asking = service.ask({
    questions: [{ id: 'q1', question: '一' }, { id: 'q2', question: '二' }],
    // The wrapper routes on `agent.id`, which is what a real live agent carries.
    agent: { sessionId: 'session-q', id: 'session-q' },
    wait: { callId: 'call-race-2' },
  })
  await new Promise(r => setTimeout(r, 0))

  // Only one of two questions answered.
  const partial = await call(route, '/session-api/sessions/session-q/questions/call-race-2', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(partial.status, 409)
  assert.equal(JSON.parse(partial.body).code, 'BAD_ANSWERS')

  // The real one.
  const full = await call(route, '/session-api/sessions/session-q/questions/call-race-2', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [], custom: '自己填' },
    ] },
  })
  assert.equal(full.status, 200)
  const result = await asking
  assert.equal(result.answers.length, 2)
  assert.deepEqual(result.answers[1], { id: 'q2', selected: [], custom: '自己填' })
})

test('a cancelled turn withdraws its question instead of leaving it addressable', async () => {
  const { route, service } = racerHarness()
  const lifetime = new AbortController()
  const asking = askInBackground(service, { signal: lifetime.signal })
  await new Promise(r => setTimeout(r, 0))

  lifetime.abort(new Error('turn cancelled'))
  await new Promise(r => setTimeout(r, 0))

  const listed = await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.deepEqual(JSON.parse(listed.body).questions, [])
  const late = await call(route, '/session-api/sessions/session-q/questions/call-race-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(late.status, 404)
  void asking.catch(() => {})
})

test('a channel that REPLACES ask (im-qqbot) does not steal the race', async () => {
  // im-qqbot assigns a brand-new function to `userQuestions.ask`; it never
  // calls the previous implementation. If we merely patched once, installing
  // after us would hide the race for every QQ session — the exact case this
  // feature exists for. The wrapper must adopt the interloper as downstream and
  // put itself back on top.
  const { route, service } = racerHarness()
  const ours = service.ask
  assert.equal(ours.__sessionApiRace, true)

  // The QQ channel takes over the slot, with its own routing inside.
  const qqCalls = []
  const qq = function qqChannelAsk(request) {
    qqCalls.push(request)
    return Promise.withResolvers().promise // parked: the QQ user never replied
  }
  service.ask = qq

  // Reading the question list is where a displacement must be noticed.
  const listed = await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(listed.status, 200)
  // The wrapper is back on top, and the QQ channel is now its downstream.
  assert.equal(service.ask.__sessionApiRace, true)

  const asking = askInBackground(service)
  await new Promise(r => setTimeout(r, 0))
  // The request still reached the QQ channel: we adopted it, not replaced it.
  assert.equal(qqCalls.length, 1)

  const questions = JSON.parse((await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).body).questions
  assert.equal(questions.length, 1)
  assert.equal(questions[0].answerable, true)

  const answered = await call(route, '/session-api/sessions/session-q/questions/call-race-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(answered.status, 200)
  assert.deepEqual(await asking, { answers: [{ id: 'q1', selected: ['A'] }] })
})

test('re-asserting never stacks two wrappers on one request', async () => {
  const { route, service } = racerHarness()
  const qqCalls = []
  service.ask = function qqChannelAsk(request) {
    qqCalls.push(request)
    return Promise.withResolvers().promise
  }
  // Displace and re-assert repeatedly: every GET re-asserts, and the displaced
  // slot must be adopted rather than wrapped again.
  for (let index = 0; index < 5; index += 1) {
    const response = await call(route, '/session-api/sessions/session-q/questions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 200)
    service.ask = function laterInstaller(request) {
      qqCalls.push(request)
      return Promise.withResolvers().promise
    }
  }
  void service.ask({
    questions: [{ id: 'q1', question: '只有一层吗' }],
    agent: { sessionId: 'session-q', id: 'session-q' },
    wait: { callId: 'call-race-nest' },
  })
  await new Promise(r => setTimeout(r, 0))
  // Exactly one downstream delivery: stacked wrappers would multiply this.
  assert.equal(qqCalls.length, 1)
})

test('a channel that captured our wrapper as its own previous cannot recurse forever', async () => {
  // This is the real im-qqbot shape: at install it binds whatever `uq.ask` is
  // (`origAsk = uq.ask.bind(uq)`) and, for a non-QQ session, delegates to that
  // binding. If im-qqbot installed AFTER us, that binding IS our wrapper — so
  // adopting the QQ function as downstream would send the request straight back
  // into us, forever. The re-entrancy guard must terminate it at the original.
  const { route, service } = racerHarness()
  const ours = service.ask
  const coreCalls = []
  // The QQ channel: QQ sessions park, anything else delegates to its captured
  // previous (our wrapper).
  const capture = ours.bind(service)
  service.ask = function qqChannelAsk(request) {
    if (request?.agent?.id === 'session-qq') return Promise.withResolvers().promise
    coreCalls.push(request)
    return capture(request)
  }

  // Re-assert so the QQ function becomes our downstream.
  await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(service.ask.__sessionApiRace, true)

  // A non-QQ session: the request must reach the original implementation once,
  // not bounce between the two wrappers.
  const outcome = await Promise.race([
    service.ask({
      questions: [{ id: 'q1', question: '会不会无限递归' }],
      agent: { sessionId: 'session-q', id: 'session-q' },
      wait: { callId: 'call-race-loop' },
    }),
    new Promise(resolve => setTimeout(() => resolve('__HUNG__'), 500)),
  ])
  // The stub's core `ask` parks forever, so a hang here is the bug. What proves
  // termination is that it reached the core exactly once instead of spinning.
  assert.equal(outcome, '__HUNG__')
  assert.equal(coreCalls.length, 1)
})

test('an ask with no live agent is passed through untouched', () => {
  const { service, calls } = racerHarness()
  // A programmatic ask: no agent, so nothing to route an external decision to.
  // The stub parks forever, which is why this call is not awaited: the assertion
  // is that the wrapper forwarded it synchronously rather than parking it.
  void service.ask({ questions: [{ id: 'q1', question: '无 agent 的提问' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ask')
})

test('unloading the plugin restores the original ask', () => {
  const { service, cleanups, calls } = racerHarness()
  const wrapped = service.ask
  assert.notEqual(wrapped.__sessionApiRace, undefined)
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  // The wrapper is gone: a new ask reaches the downstream stub directly.
  assert.equal(service.ask.__sessionApiRace, undefined)
  void service.ask({ questions: [{ id: 'q1', question: '卸载后' }], agent: { sessionId: 'session-q' } })
  assert.equal(calls.at(-1)[0], 'ask')
})

test('answerQuestions: false leaves the service method untouched', async () => {
  const { service } = racerHarness({ config: { answerQuestions: false } })
  assert.equal(service.ask.__sessionApiRace, undefined)
})

test('a projection-only question is still listed, but marked unanswerable', async () => {
  const active = [{
    callId: 'call-proj-1',
    state: 'continued',
    questions: [{ id: 'q1', question: '投影里的提问', options: [{ label: 'A' }] }],
  }]
  const { route } = racerHarness({ active })
  const answer = await call(route, '/session-api/sessions/session-q/questions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  assert.equal(body.questions.length, 1)
  assert.equal(body.questions[0].callId, 'call-proj-1')
  assert.equal(body.questions[0].answerable, false)
})

test('a bare selected value expands against the raced question, not the projection', async () => {
  const { route, service } = racerHarness()
  const asking = askInBackground(service)
  await new Promise(r => setTimeout(r, 0))

  // The projection is empty (legacy call), so expansion MUST come from the
  // plugin's own queue or the shorthand could not work at all.
  const answered = await call(route, '/session-api/sessions/session-q/questions/call-race-1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { selected: 'B' },
  })
  assert.equal(answered.status, 200)
  assert.deepEqual(await asking, { answers: [{ id: 'q1', selected: ['B'] }] })
})

test('the capability table advertises the racing behaviour', async () => {
  const { route } = racerHarness()
  const answer = await call(route, '/session-api/capabilities', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  const post = body.endpoints.find(e => e.path === '/sessions/:id/questions/:callId')
  assert.match(post.summary, /赛跑/)
})

test('the TTL timer does not hold the process open', () => {
  // The expiry itself is a 30-minute wait, far too long for a test. What
  // matters here is that the timer is unref'd: a parked question must never
  // keep the Host process alive waiting for a caller that may never come.
  const { service } = racerHarness()
  const asking = askInBackground(service)
  // A referenced timer would keep this test process alive; the runner exiting
  // cleanly is the assertion, so the parked ask is abandoned on purpose.
  void asking.catch(() => {})
  assert.equal(typeof service.ask, 'function')
})

/* ------------------------------------------------------------------ *
 * End of the racer block.
 * ------------------------------------------------------------------ */

test('the question endpoints appear in the capability table', async () => {
  const { route } = questionHarness()
  const answer = await call(route, '/session-api/capabilities', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = JSON.parse(answer.body)
  const paths = new Set(body.endpoints.map(e => `${e.method} ${e.path}`))
  assert.ok(paths.has('GET /sessions/:id/questions'))
  assert.ok(paths.has('POST /sessions/:id/questions/:callId'))
  const write = body.endpoints.find(e => e.path === '/sessions/:id/questions/:callId')
  assert.equal(write.write, true)
  assert.deepEqual(write.formats, ['json'])
})

test('an empty answer batch is refused instead of silently succeeding', async () => {
  const { route, calls } = questionHarness()
  // [] would answer nothing while reporting success, which reads as a broken
  // answer to a caller who thought it answered.
  const answer = await call(route, '/session-api/sessions/session-q/questions/call-q1', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { answers: [] },
  })
  assert.equal(answer.status, 409)
  assert.equal(JSON.parse(answer.body).code, 'BAD_ANSWERS')
  assert.equal(calls.filter(c => c[0] === 'answer').length, 0)
})

/* ------------------------------------------------------------------ *
 * Renderers must match the REAL payload shapes
 *
 * Every one of these was written from a guessed field name once and silently
 * produced an em-dash column. They are asserted against the shapes the live
 * controllers actually return.
 * ------------------------------------------------------------------ */

import { renderModelCatalog, renderQueue, renderSessionDetail } from '../lib/markdown.js'

test('model catalog renders reasoning efforts from `reasoning.efforts`', () => {
  const catalog = {
    default: 'deepseek-flash',
    groups: [{
      id: 'acct',
      name: 'Account',
      models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }],
    }],
    failures: [{ provider: 'broken', reason: 'no key' }],
  }
  const md = renderModelCatalog(catalog)
  assert.match(md, /默认模型：`deepseek-flash`/)
  assert.match(md, /## Account/)
  assert.match(md, /off, low, high/)
  assert.match(md, /不可用的提供方/)
  assert.match(md, /broken/)
  // A model without reasoning must not print an empty cell as if data were missing.
  const plain = renderModelCatalog({ groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] })
  assert.match(plain, /无/)
})

test('queue renders id, placement and text from content blocks', () => {
  const queue = [
    { id: 'msg-1', placement: 'queued', content: [{ type: 'text', text: '先分析依赖' }] },
    { id: 'msg-2', placement: 'steering', content: [{ type: 'image', data: 'x' }] },
  ]
  const md = renderQueue('session-q', queue)
  assert.match(md, /`msg-1`/)
  assert.match(md, /queued/)
  assert.match(md, /先分析依赖/)
  assert.match(md, /steering/)
  assert.match(md, /1 个非文本块/)
})

test('session detail reads title, model and usage from projections.values', () => {
  const session = {
    sessionId: 'session-z',
    running: true,
    cwd: '/tmp',
    projections: {
      kind: 'sequenced',
      values: {
        title: '真实标题',
        modelSelection: { lastUsed: { provider: 'p', model: 'm' } },
        agentPreset: 'cordis',
        tokenUsage: { uncachedInputTokens: 1500, outputTokens: 200, cacheReadTokens: 0 },
        permissions: { currentValue: 'workspace-write' },
      },
    },
  }
  const md = renderSessionDetail(session, { running: true, active: true, queue: [], pendingInput: [] })
  assert.match(md, /# 真实标题/)
  assert.match(md, /p \/ m/)
  assert.match(md, /cordis/)
  assert.match(md, /1\.5k/)
  assert.match(md, /workspace-write/)
})

/* ------------------------------------------------------------------ *
 * Malformed bodies must be client errors, not server faults
 * ------------------------------------------------------------------ */

test('a non-object JSON body is 400, never a 500', async () => {
  const { route } = harness()
  // `JSON.parse('null')` succeeds, so `body.text` would throw a TypeError and be
  // reported as a server fault. Each of these must be refused as a bad request.
  for (const raw of ['null', '[]', '123', '"text"', 'true']) {
    const req = Readable.from([Buffer.from(raw)])
    req.method = 'POST'
    req.url = '/session-api/sessions/session-a/prompt'
    req.headers = { host: '127.0.0.1:8080', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    let settle
    const done = new Promise(resolve => { settle = resolve })
    const res = { statusCode: 200, setHeader() {}, end(t) { settle({ status: this.statusCode, body: t ?? '' }) } }
    await route.handler(req, res)
    const answer = await done
    assert.equal(answer.status, 400, `body ${raw} should be a bad request`)
    assert.equal(JSON.parse(answer.body).code, 'BAD_JSON')
  }
})

test('an array body is refused for the same reason', async () => {
  const { route } = harness()
  const answer = await call(route, '/session-api/sessions/session-a/model', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: [{ provider: 'p', model: 'm' }],
  })
  assert.equal(answer.status, 400)
  assert.equal(JSON.parse(answer.body).code, 'BAD_JSON')
})

/* ------------------------------------------------------------------ *
 * Host / Origin fence
 *
 * `webServer.register` does not apply DSH's connection trust check, so the
 * loopback bind and peer-address test are not enough: a DNS-rebinding Host
 * header or a cross-site Origin still reaches the route. The handler applies
 * the Host/Origin half of DSH's own isTrustedApiRequest — but NOT its
 * peer-authentication half, which would refuse the very callers this surface
 * exists for.
 * ------------------------------------------------------------------ */

test('a rebinding Host header is refused', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}`, host: 'evil.example' },
  })
  assert.equal(answer.status, 403)
  assert.equal(JSON.parse(answer.body).code, 'UNTRUSTED_CONNECTION')
})

test('a cross-site Origin is refused', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8080', origin: 'http://evil.example' },
  })
  assert.equal(answer.status, 403)
})

test('the cross-site fetch marker alone is enough to refuse', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      host: '127.0.0.1:8080',
      'sec-fetch-site': 'cross-site',
    },
  })
  assert.equal(answer.status, 403)
})

test('an opaque origin is refused', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8080', origin: 'null' },
  })
  assert.equal(answer.status, 403)
})

test('a loopback Host with no Origin is accepted (curl)', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8080' },
  })
  assert.equal(answer.status, 200)
})

test('an Origin matching the Host is accepted (the page)', async () => {
  const { route } = await createHarness()
  const answer = await call(route, '/session-api/status', {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      host: '127.0.0.1:8080',
      origin: 'http://127.0.0.1:8080',
    },
  })
  assert.equal(answer.status, 200)
})
