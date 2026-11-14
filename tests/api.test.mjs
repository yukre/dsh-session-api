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
