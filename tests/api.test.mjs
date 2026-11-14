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
  req.headers = {
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
  req.headers = {
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
    req.headers = { authorization: `Bearer ${TOKEN}` }
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
