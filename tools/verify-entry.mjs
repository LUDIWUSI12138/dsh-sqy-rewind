// dsh-rewind — Host half verification.
//
// `entry.js` cannot be verified by refreshing the page: the running DSH holds the
// old module and the profile's live reload does not replace it. Restarting DSH is
// the only other way to load a change, so this script is the cheap gate in front of
// that restart.
//
// It starts no server and binds no port. It builds a stub Host context, runs
// `apply()`, and then:
//
//   1. asserts exactly one route was claimed, and that it is the `/api` prefix
//      (claiming all of `/plugins/dsh-rewind` would hide the shell's own
//      `/plugins/dsh-rewind/client.js` and the button would never register),
//   2. drives the HTTP surface with fake requests — loopback refusal, missing
//      parameters, malformed bodies, unknown paths,
//   3. runs real rewinds against a stub session and asserts the event that lands:
//      its type, its user-message carrier, the replace range, and the
//      `sourceEventSeqs` coverage the surface fold requires,
//   4. asserts the turn range the browser half needs to hide.
//
//   node tools/verify-entry.mjs

import assert from 'node:assert/strict'

const entry = await import(new URL('../entry.js', import.meta.url).href)

/**
 * The marker text. `entry.js` does not export it, so this literal is the contract:
 * if the two ever drift, `state` stops recognising landed markers and the browser
 * half stops hiding their bubbles.
 */
const MARK_TEXT = '（用户已回退这一轮对话）'

let failures = 0

/**
 * Run one named check.
 * @param name - what is being checked.
 * @param fn - the check itself.
 */
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** One fake incoming request that replays a body once `end` is listened for. */
function makeReq({ url, method = 'GET', body, address = '127.0.0.1' }) {
  const listeners = {}
  let started = false
  const start = () => {
    if (started) return
    started = true
    if (body !== undefined) listeners['data']?.(Buffer.from(body, 'utf8'))
    listeners['end']?.()
  }
  return {
    url,
    method,
    socket: { remoteAddress: address },
    on(event, callback) {
      listeners[event] = callback
      if (event === 'end') queueMicrotask(start)
      return this
    },
  }
}

/** One fake response that records what was sent. */
function makeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(text) {
      state.body = text ?? ''
    },
  }
}

/**
 * Send one fake request through a registered route.
 * @param route - the route options captured from `webServer.register`.
 * @param request - `makeReq` options.
 * @returns `{ status, body }`.
 */
async function call(route, request) {
  const res = makeRes()
  const done = new Promise((resolve) => {
    const original = res.end.bind(res)
    res.end = (text) => {
      original(text)
      resolve()
    }
  })
  route.handler(makeReq(request), res)
  await done
  return { status: res.state.status, body: JSON.parse(res.state.body) }
}

/** A stub live session that records what was appended. */
function makeSession(id) {
  const appended = []
  return {
    id,
    appended,
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { type, data, seq: 99 }
    },
  }
}

/**
 * Build a stub Host context.
 * @param options - session, surface events, turn outline and running-agent flag.
 * @returns the context plus captured routes and flush count.
 */
function makeCtx(options) {
  const routes = []
  const state = { flushed: 0, cancelled: 0 }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      register(routeOptions) {
        routes.push(routeOptions)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    sessions: {
      get: (id) => (id === options.session?.id ? options.session : undefined),
      flush: async () => {
        state.flushed += 1
        return true
      },
    },
    agents: {
      get: () => (options.running === true
        ? {
            status: 'running',
            cancel: () => { state.cancelled += 1 },
            whenIdle: async () => {},
          }
        : undefined),
    },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'turnOutline' ? { turns: options.turns } : undefined),
    },
    sessionQuery: {
      readSurface: async () => ({ events: options.events }),
    },
  }
  return { ctx, routes, state }
}

/**
 * The surface used by most checks: two turns.
 *
 * The seqs mirror a real log's shape — `turn/start` is NOT a surface event, so it
 * occupies seq 1 and seq 4 without appearing in the node list, and each turn's
 * prompt sits immediately after its own `turn/start`.
 */
const SURFACE = [
  { seq: 0, type: 'system/message', data: {} },
  { seq: 2, type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' } } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'msg-1' } } },
  { seq: 5, type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' } } },
  { seq: 6, type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'msg-2' } } },
]

const TURNS = [
  { turn: 1, seq: 1 },
  { turn: 2, seq: 4 },
]

/** POST one rewind for `turn` and return the parsed response. */
async function rewind(route, turn) {
  return await call(route, {
    url: '/plugins/dsh-rewind/api/rewind',
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-test', turn }),
  })
}

console.log('dsh-rewind — Host half verification')

// --- route registration -------------------------------------------------------

{
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: SURFACE, turns: TURNS })
  entry.apply(ctx)

  check('claims exactly one route', () => {
    assert.equal(routes.length, 1)
  })
  check('claims the /api prefix, not the whole plugin prefix', () => {
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/plugins/dsh-rewind/api')
    // The shell serves /plugins/dsh-rewind/client.js; claiming the parent would
    // answer it with our 404 and the button would never register.
    assert.notEqual(routes[0].path, '/plugins/dsh-rewind')
  })
  check('declares the services it needs', () => {
    for (const service of ['webServer', 'sessions', 'agents', 'sessionProjections', 'sessionQuery']) {
      assert.ok(entry.inject.includes(service), `missing inject: ${service}`)
    }
  })
  check('exposes apply()', () => {
    assert.equal(typeof entry.apply, 'function')
    assert.equal(entry.name, 'dsh-rewind')
  })
}

// --- HTTP surface -------------------------------------------------------------

{
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: SURFACE, turns: TURNS })
  entry.apply(ctx)
  const route = routes[0]

  const nonLoopback = await call(route, {
    url: '/plugins/dsh-rewind/api/state?sessionId=session-test',
    address: '10.0.0.7',
  })
  check('non-loopback status is 403', () => assert.equal(nonLoopback.status, 403))

  const noSession = await call(route, { url: '/plugins/dsh-rewind/api/state' })
  check('state without sessionId is 400', () => {
    assert.equal(noSession.status, 400)
    assert.equal(noSession.body.ok, false)
  })

  const unknown = await call(route, { url: '/plugins/dsh-rewind/api/nope' })
  check('unknown path is 404', () => assert.equal(unknown.status, 404))

  const coldSession = await call(route, { url: '/plugins/dsh-rewind/api/state?sessionId=other' })
  check('state for a non-live session is 404', () => assert.equal(coldSession.status, 404))

  const badBody = await call(route, { url: '/plugins/dsh-rewind/api/rewind', method: 'POST', body: 'not json' })
  check('malformed body is 400', () => assert.equal(badBody.status, 400))

  const missing = await call(route, {
    url: '/plugins/dsh-rewind/api/rewind',
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-test' }),
  })
  check('rewind without turn is 400', () => assert.equal(missing.status, 400))

  const notATurn = await call(route, {
    url: '/plugins/dsh-rewind/api/rewind',
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-test', turn: 'two' }),
  })
  check('a non-numeric turn is 400', () => assert.equal(notATurn.status, 400))

  const wrongMethod = await call(route, { url: '/plugins/dsh-rewind/api/rewind', method: 'GET' })
  check('GET on the rewind endpoint is 404', () => assert.equal(wrongMethod.status, 404))
}

// --- the rewind itself --------------------------------------------------------

{
  const session = makeSession('session-test')
  const { ctx, routes, state } = makeCtx({ session, events: SURFACE, turns: TURNS })
  entry.apply(ctx)

  const response = await rewind(routes[0], 2)

  check('rewinding the last turn succeeds', () => {
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
  })
  check('reports the turn range the browser half must hide', () => {
    assert.equal(response.body.fromTurn, 2)
    assert.equal(response.body.toTurn, 2)
  })
  check('appends exactly one carrier event', () => {
    assert.equal(session.appended.length, 1)
    assert.equal(session.appended[0].type, 'user/message')
  })
  check('the carrier is a user message carrying the marker text', () => {
    const { data } = session.appended[0]
    // user/message data IS the message, unlike developer/message's { message }.
    assert.equal(data.role, 'user')
    assert.equal(typeof data.id, 'string')
    assert.ok(data.id.length > 0)
    assert.equal(typeof data.source?.kind, 'string')
    assert.ok(data.source.kind.length > 0)
    assert.ok(Array.isArray(data.content))
    assert.equal(data.content.length, 1)
    assert.equal(data.content[0].type, 'text')
    assert.equal(data.content[0].text, MARK_TEXT)
    assert.ok(!Object.hasOwn(data, 'headerSeq'))
  })
  check('the carrier is NOT a developer message', () => {
    // The first release used developer/message with empty content. dsh-session-format
    // rejects that outside an open turn/step, and rejects source.kind "plugin":
    //   developer/message turn must be a non-negative safe integer
    const { type, data } = session.appended[0]
    assert.notEqual(type, 'developer/message')
    assert.notEqual(data.role, 'developer')
    assert.notEqual(data.source?.kind, 'plugin')
  })
  check('the replace marker has exactly the three allowed keys', () => {
    const { surfaceOp } = session.appended[0].opts
    assert.deepEqual(Object.keys(surfaceOp).sort(), ['endSeq', 'op', 'startSeq'])
    assert.equal(surfaceOp.op, 'replace')
    assert.equal(surfaceOp.startSeq, 5)
    assert.equal(surfaceOp.endSeq, 6)
  })
  check('sourceEventSeqs covers every shadowed surface node', () => {
    assert.deepEqual(session.appended[0].opts.sourceEventSeqs, [5, 6])
  })
  check('flushes for durability', () => assert.equal(state.flushed, 1))
}

{
  // Rewinding an OLDER turn must take every later turn with it, and must start at
  // that turn's own prompt rather than at its first assistant node.
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: SURFACE, turns: TURNS })
  entry.apply(ctx)

  const response = await rewind(routes[0], 1)

  check('rewinding turn 1 shadows turns 1 through 2', () => {
    assert.equal(response.body.fromTurn, 1)
    assert.equal(response.body.toTurn, 2)
  })
  check('the shadowed range starts at the turn prompt, not the system prompt', () => {
    const { surfaceOp } = session.appended[0].opts
    assert.equal(surfaceOp.startSeq, 2)
    assert.equal(surfaceOp.endSeq, 6)
  })
  check('every shadowed node is cited', () => {
    assert.deepEqual(session.appended[0].opts.sourceEventSeqs, [2, 3, 5, 6])
  })
}

{
  // A running turn must be stopped first, or its later appends land after the
  // marker and the rewind does not stick.
  const session = makeSession('session-test')
  const { ctx, routes, state } = makeCtx({ session, events: SURFACE, turns: TURNS, running: true })
  entry.apply(ctx)

  await rewind(routes[0], 2)

  check('cancels a running turn before rewriting history', () => {
    assert.equal(state.cancelled, 1)
    assert.equal(session.appended.length, 1)
  })
}

// --- refusals -----------------------------------------------------------------

{
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: SURFACE, turns: TURNS })
  entry.apply(ctx)

  const response = await rewind(routes[0], 99)

  check('refuses a turn that is not in the outline', () => {
    assert.equal(response.status, 500)
    assert.equal(session.appended.length, 0)
  })
}

{
  // When the turn's prompt IS the first surface node, there is no system prompt
  // above it to keep, and index 0 is the one node the fold will not let a rewind
  // rewrite. This is also what a subagent session looks like.
  const noSystem = [
    { seq: 2, type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'msg-1' } } },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: noSystem, turns: [{ turn: 1, seq: 1 }] })
  entry.apply(ctx)

  const response = await rewind(routes[0], 1)

  check('refuses a rewind that would start at the first surface node', () => {
    assert.equal(response.status, 500)
    assert.equal(session.appended.length, 0)
  })
}

{
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: SURFACE, turns: [] })
  entry.apply(ctx)

  const response = await rewind(routes[0], 2)

  check('refuses to guess when the turn outline is unavailable', () => {
    assert.equal(response.status, 500)
    assert.equal(session.appended.length, 0)
  })
}

// --- compaction on the surface -------------------------------------------------

{
  // A real log folds replacements into the node list, so a marker written at seq
  // 550 can sit BEFORE nodes with smaller seqs (verified against a real session:
  // nodes read [0, 550, 470, 473, ...]). Boundaries must therefore be found in
  // surface order, never by comparing seqs.
  const compacted = [
    { seq: 0, type: 'system/message', data: {} },
    {
      seq: 550,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 467 },
      data: { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compaction' } },
    },
    { seq: 470, type: 'assistant/message', data: { turn: 3, step: 1, message: { id: 'msg-a' } } },
    { seq: 717, type: 'assistant/message', data: { turn: 3, step: 2, message: { id: 'msg-b' } } },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: compacted, turns: [{ turn: 3, seq: 76 }] })
  entry.apply(ctx)

  const response = await rewind(routes[0], 3)

  check('refuses a turn whose opening a replacement already absorbed', () => {
    assert.equal(response.status, 500)
    assert.equal(session.appended.length, 0)
  })
}

{
  // Same shape, but the replacement covers earlier turns only. The marker must
  // survive the rewind: it is the model's entire memory of turns 1 and 2, and
  // shadowing it would leave the conversation with nothing but its system prompt.
  const compacted = [
    { seq: 0, type: 'system/message', data: {} },
    {
      seq: 550,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 60 },
      data: { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compaction' } },
    },
    { seq: 470, type: 'assistant/message', data: { turn: 3, step: 1, message: { id: 'msg-a' } } },
    { seq: 717, type: 'assistant/message', data: { turn: 3, step: 2, message: { id: 'msg-b' } } },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: compacted, turns: [{ turn: 3, seq: 76 }] })
  entry.apply(ctx)

  const response = await rewind(routes[0], 3)

  check('keeps the earlier summary and starts at the turn opener', () => {
    assert.equal(response.status, 200)
    const { surfaceOp, sourceEventSeqs } = session.appended[0].opts
    assert.equal(surfaceOp.startSeq, 470)
    assert.deepEqual(sourceEventSeqs, [470, 717])
  })
  check('the summary marker is not mistaken for the turn prompt', () => {
    // The marker is a user/message with a seq newer than the turn's turn/start,
    // so a naive back-walk would have started the range at 550.
    assert.notEqual(session.appended[0].opts.surfaceOp.startSeq, 550)
  })
}

// --- reading landed markers back ----------------------------------------------

{
  const marked = [
    ...SURFACE,
    {
      seq: 7,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 6 },
      data: { id: 'mark-1', role: 'user', content: [{ type: 'text', text: MARK_TEXT }], source: { kind: 'user' } },
    },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: marked, turns: TURNS })
  entry.apply(ctx)

  const response = await call(routes[0], { url: '/plugins/dsh-rewind/api/state?sessionId=session-test' })

  check('state reports the landed marker with its turn range', () => {
    assert.equal(response.status, 200)
    assert.equal(response.body.marks.length, 1)
    assert.equal(response.body.marks[0].fromTurn, 1)
    assert.equal(response.body.marks[0].toTurn, 2)
    assert.equal(response.body.marks[0].startSeq, 2)
    assert.equal(response.body.marks[0].endSeq, 6)
  })
}

{
  // A compaction marker is ALSO a user/message carrying a replacement. Only the
  // text tells them apart, so this is the check that keeps a summary from being
  // reported as a rewind range the browser half would then hide.
  const mixed = [
    { seq: 0, type: 'system/message', data: {} },
    {
      seq: 550,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 467 },
      data: { id: 'compact-1', role: 'user', content: [{ type: 'text', text: 'a long summary' }], source: { kind: 'compaction' } },
    },
    { seq: 470, type: 'assistant/message', data: { turn: 3, step: 1, message: { id: 'msg-a' } } },
    {
      seq: 717,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 470, endSeq: 470 },
      data: { id: 'mark-1', role: 'user', content: [{ type: 'text', text: MARK_TEXT }], source: { kind: 'user' } },
    },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: mixed, turns: [{ turn: 3, seq: 76 }] })
  entry.apply(ctx)

  const response = await call(routes[0], { url: '/plugins/dsh-rewind/api/state?sessionId=session-test' })

  check('state reports our marker and ignores the compaction summary', () => {
    assert.equal(response.body.marks.length, 1)
    assert.equal(response.body.marks[0].startSeq, 470)
  })
}

{
  // A user/message carrying a replacement but no surfaceOp is not a marker: the
  // range lives in surfaceOp, and a clone without it must not be guessed at.
  const noOp = [
    ...SURFACE,
    {
      seq: 7,
      type: 'user/message',
      data: { id: 'mark-1', role: 'user', content: [{ type: 'text', text: MARK_TEXT }], source: { kind: 'user' } },
    },
  ]
  const session = makeSession('session-test')
  const { ctx, routes } = makeCtx({ session, events: noOp, turns: TURNS })
  entry.apply(ctx)

  const response = await call(routes[0], { url: '/plugins/dsh-rewind/api/state?sessionId=session-test' })

  check('state ignores a marker-shaped event with no replacement', () => {
    assert.equal(response.body.marks.length, 0)
  })
}

console.log(failures === 0
  ? 'dsh-rewind — all Host checks passed'
  : `dsh-rewind — ${String(failures)} Host check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
