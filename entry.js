// dsh-rewind — Host half: roll the model history back to before a turn.
//
// WHAT "REWIND" MEANS HERE
// ------------------------
// The session log is append-only, so nothing is deleted. This half appends one
// `user/message` event carrying a `surfaceOp: { op: 'replace', ... }` marker.
// The surface fold then drops every model-visible node in the closed range
// [startSeq, endSeq] and keeps the marker in their place.
//
// WHY THE CARRIER IS A `user/message`
// -----------------------------------
// The obvious carrier was a `developer/message` with empty content:
// `deriveEventMessage` maps an empty developer message to null, so the marker would
// never reach the provider transcript. That is illegal here, and it is what broke
// the first release:
//
//   * dsh-session-format's V4 acceptance requires a developer message to carry
//     positive `turn`/`step` coordinates, and the relationship checks require those
//     to name an OPEN turn and step. A rewind happens after the turn has closed, so
//     there is nothing to name — the append dies with
//     `developer/message turn must be a non-negative safe integer`.
//   * The same acceptance rejects a developer message whose `source.kind` is
//     `"plugin"`, which is what the first release sent.
//
// `user/message` is the only surface type that carries a replacement without being
// tied to turn state, so that is what we append now.
//
// The cost: a user message must carry content, so the marker is one short line
// telling the model the turn was rolled back. That line is the only trace a rewind
// leaves in the model's context. The browser half hides the bubble it renders.
//
// The human transcript is a separate story. The browser half deliberately renders
// append-origin events, so a landed replacement does NOT erase what the user
// already saw — that is by design, and the official comment in dsh-session says so.
// The browser half of this plugin therefore hides the rewound turns in the DOM,
// using the turn range this API reports.
//
// WHAT THIS HALF OWNS
// -------------------
//   GET  /plugins/dsh-rewind/api/state?sessionId=...   every landed rewind marker
//   POST /plugins/dsh-rewind/api/rewind                perform one rewind
//
// Nothing else under /plugins/dsh-rewind is claimed. `/plugins/dsh-rewind/client.js`
// belongs to the shell's client-modules service, and claiming the whole prefix here
// would answer that request with this plugin's 404 — the button would never register.

import { randomUUID } from 'node:crypto'

export const name = 'dsh-rewind'

/** Services this half consumes. */
export const inject = ['webServer', 'sessions', 'agents', 'sessionProjections', 'sessionQuery']

/** Route prefix this package owns. */
const ROUTE = '/plugins/dsh-rewind'

/**
 * The marker's message text.
 *
 * This is the only content a rewind leaves in the model's context, and it is also
 * how this half recognises its own markers among the `user/message` replacements a
 * compaction writes. The browser half keys its hiding off the exact same string, so
 * change it in both halves or the bubble stops being hidden.
 */
const MARK_TEXT = '（用户已回退这一轮对话）'

/**
 * A logger that cannot itself throw.
 *
 * The Host logger runs inside a fibre; a bad call there would be reported as a
 * plugin fault rather than as whatever we were trying to report.
 * @param ctx - Host plugin context.
 * @returns `(level, message)`.
 */
function makeLog(ctx) {
  return (level, message) => {
    try {
      const sink = ctx.logger?.[level] ?? ctx.logger?.info
      sink?.(`dsh-rewind: ${message}`)
    } catch {
      // Nothing left to do about it.
    }
  }
}

/**
 * Whether a request arrived over loopback.
 *
 * This API edits the conversation the user is looking at, so it is reachable from
 * this machine only. DSH binds loopback by default; this is the belt to that pair
 * of braces.
 * @param req - incoming request.
 * @returns true when the peer is this machine.
 */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a JSON object body.
 *
 * Anything that is not a JSON object resolves to `undefined`: every caller answers
 * 400 for that case, and there is no repair a caller could make.
 * @param req - incoming request.
 * @returns the parsed object, or undefined.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => { resolve(undefined) })
  })
}

/**
 * Whether one surface event is a rewind marker this plugin wrote.
 *
 * Compaction markers are also `user/message` events carrying a replacement, so the
 * text is what separates ours from the summary the compactor leaves behind.
 * @param event - one surface event.
 * @returns true for our markers.
 */
function isRewindMark(event) {
  if (event?.type !== 'user/message') return false
  const op = event?.surfaceOp
  if (op === null || typeof op !== 'object' || op.op !== 'replace') return false
  const content = event?.data?.content
  return Array.isArray(content)
    && content.some((block) => block?.type === 'text' && block.text === MARK_TEXT)
}

/**
 * The replacement range of one surface event.
 * @param event - one surface event.
 * @returns `{ start, end }`, or undefined when the event carries no usable range.
 */
function replaceRangeOf(event) {
  const op = event?.surfaceOp
  if (op !== null && typeof op === 'object' && op.op === 'replace'
    && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)) {
    return { start: op.startSeq, end: op.endSeq }
  }
  return undefined
}

/**
 * Turn boundaries from the `turnOutline` projection.
 *
 * Each entry's `seq` is that turn's `turn/start` event, which the agent loop logs
 * BEFORE the turn's prompt — so "the first surface node after this seq" is that
 * turn's opening message. The projection is registered by dsh-session-turn-outline;
 * a composition without it yields an empty list, and this plugin then refuses to
 * guess rather than cutting the history in the wrong place.
 * @param ctx - Host plugin context.
 * @param session - live session.
 * @returns the projection's turn list, possibly empty.
 */
function turnOutlineOf(ctx, session) {
  try {
    const state = ctx.sessionProjections?.stateOf(session, 'turnOutline')
    const turns = state?.turns
    return Array.isArray(turns) ? turns : []
  } catch {
    return []
  }
}

/**
 * The turn whose `turn/start` seq is the last one at or before `seq`.
 * @param turns - `turnOutline` entries, ascending by seq.
 * @param seq - target event seq.
 * @returns the turn number, or null when the seq predates every entry.
 */
function turnAt(turns, seq) {
  let found = null
  for (const entry of turns) {
    if (typeof entry?.seq !== 'number' || typeof entry?.turn !== 'number') continue
    if (entry.seq > seq) break
    found = entry.turn
  }
  return found
}

/**
 * Every rewind marker still present on the model surface.
 *
 * Markers that a later rewind shadowed are gone from the surface and are not
 * reported: their range is already covered by the newer one.
 * @param ctx - Host plugin context.
 * @param sessionId - target session.
 * @returns the markers, or undefined when the session is not live.
 */
async function readMarks(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return undefined
  const { events } = await ctx.sessionQuery.readSurface(sessionId)
  if (!Array.isArray(events)) return []
  const turns = turnOutlineOf(ctx, session)
  const marks = []
  for (const event of events) {
    if (!isRewindMark(event)) continue
    const range = replaceRangeOf(event)
    if (range === undefined) continue
    marks.push({
      startSeq: range.start,
      endSeq: range.end,
      fromTurn: turnAt(turns, range.start),
      toTurn: turnAt(turns, range.end),
    })
  }
  return marks
}

/**
 * Roll the model history back to just before one turn.
 *
 * The button lives under a user message, so the turn number is the whole address:
 * that turn's opening prompt and every turn after it are shadowed together, which
 * is exactly what "back to before this turn" means.
 *
 * @param ctx - Host plugin context.
 * @param sessionId - target session.
 * @param turn - the turn number to roll back to (exclusive).
 * @returns the landed range plus the turn numbers the browser half must hide.
 * @throws when the session, the turn, or its boundary cannot be resolved.
 */
async function rewindAt(ctx, sessionId, turn) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('这个会话当前不在活动状态，无法回退')

  // 1. Stop a running turn first. Appending a replacement while the loop is still
  //    producing events would let it push new surface nodes after the marker, and
  //    the rewind would not stick. This is the same path as the UI stop button.
  const agent = ctx.agents?.get(sessionId)
  if (agent !== undefined && agent !== null && agent.status === 'running') {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
  }

  // 2. Locate the target turn on the CURRENT surface.
  const { events } = await ctx.sessionQuery.readSurface(sessionId)
  if (!Array.isArray(events) || events.length === 0) throw new Error('这个会话还没有可回退的内容')

  const turns = turnOutlineOf(ctx, session)
  const entry = turns.find((candidate) => candidate?.turn === turn)
  if (entry === undefined || !Number.isSafeInteger(entry.seq)) {
    throw new Error('读不到轮次边界（turnOutline 投影不可用），无法安全回退')
  }

  // 3a. Refuse when the turn's opening has already been absorbed by a replacement.
  //
  //     A compaction marker cites the seq range it shadowed. If this turn's
  //     `turn/start` sits inside one of those ranges, the fold has already removed
  //     this turn's opening nodes for good — "before this turn" is not representable
  //     on this surface any more, and hiding the marker to get there would throw
  //     away every summary the model has.
  const absorbed = events.some((event) => {
    const op = event?.surfaceOp
    return op !== null && typeof op === 'object' && op.op === 'replace'
      && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)
      && op.startSeq <= entry.seq && entry.seq <= op.endSeq
  })
  if (absorbed) throw new Error('这一轮的起点已经被压缩（compaction）吸收，无法精确回退')

  // 3b. Find where this turn starts, in MODEL-VISIBLE ORDER.
  //
  //     Comparing seqs is wrong: a marker carries the seq it was written at, but it
  //     sits where the history it replaced used to be, so a node with a LARGER seq
  //     can precede one with a smaller seq. The order that matters is `events`
  //     order, which is the folded surface order.
  //
  //     A turn opens at its first node carrying this turn number, walked back to the
  //     `user/message` that prompted it.
  const firstTurnNode = events.findIndex((event) => event?.data?.turn === turn)
  if (firstTurnNode === -1) throw new Error('这一轮在当前模型历史里已经没有可见内容了')

  let startIdx = firstTurnNode
  for (let index = firstTurnNode - 1; index >= 0; index--) {
    const event = events[index]
    const nodeTurn = event?.data?.turn
    if (Number.isSafeInteger(nodeTurn) && nodeTurn < turn) break
    // A landed replacement is not a prompt: a compaction marker is a `user/message`
    // carrying the summary, and its seq is newer than this turn's `turn/start`.
    if (event?.surfaceOp?.op === 'replace') continue
    if (event?.type === 'user/message' && event.seq > entry.seq) {
      startIdx = index
      break
    }
  }

  // Index 0 is the system prompt: the surface fold lets it be rewritten only by a
  // system/message over exactly that node, so a rewind starting there is refused.
  if (startIdx <= 0) throw new Error('这一轮没有可回退的模型历史')

  const startSeq = events[startIdx].seq
  const endSeq = events[events.length - 1].seq
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) {
    throw new Error('会话序列号异常，已放弃回退')
  }
  const shadowedSeqs = events.slice(startIdx).map((event) => event.seq)

  // 4. Append the carrier. Every shadowed surface node must be cited in
  //    `sourceEventSeqs`, or the surface fold rejects the replacement outright.
  //
  //    `source.kind` is the native `user` value: the format acceptance rejects
  //    plugin-authored developer sources, and inventing a kind buys nothing. The id
  //    is a plain uuid — the range lives in `surfaceOp`, which survives the clone
  //    `readSurface()` hands back.
  session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: MARK_TEXT }],
    source: { kind: 'user' },
  }, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedSeqs,
  })

  // 5. Appends only enter a 200ms persistence buffer; flush is the durability barrier.
  await ctx.sessions.flush(session)

  return {
    startSeq,
    endSeq,
    turn,
    fromTurn: turnAt(turns, startSeq),
    toTurn: turnAt(turns, endSeq),
  }
}

/**
 * Serve the control API.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param ctx - Host plugin context.
 * @param log - `(level, message)`.
 */
async function serveApi(req, res, ctx, log) {
  const send = (status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      // The socket is already gone.
    }
  }

  if (!isLoopback(req)) {
    send(403, { ok: false, error: 'loopback only' })
    return
  }

  const url = String(req.url ?? '')
  const pathname = decodeURIComponent(url.split('?')[0])
  const query = new URLSearchParams(url.split('?')[1] ?? '')

  try {
    if (pathname === `${ROUTE}/api/state` && req.method === 'GET') {
      const sessionId = query.get('sessionId') ?? ''
      if (sessionId === '') {
        send(400, { ok: false, error: 'sessionId is required' })
        return
      }
      const marks = await readMarks(ctx, sessionId)
      if (marks === undefined) {
        send(404, { ok: false, error: '会话不在活动状态' })
        return
      }
      send(200, { ok: true, marks })
      return
    }

    if (pathname === `${ROUTE}/api/rewind` && req.method === 'POST') {
      const body = await readBody(req)
      if (body === undefined) {
        send(400, { ok: false, error: '请求体必须是 JSON 对象' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const turn = body.turn
      if (sessionId === '' || !Number.isSafeInteger(turn) || turn < 0) {
        send(400, { ok: false, error: 'sessionId 与 turn 都是必需的' })
        return
      }
      const result = await rewindAt(ctx, sessionId, turn)
      log('info', `rewound ${sessionId} to before turn ${String(result.turn)} (seq ${String(result.startSeq)}..${String(result.endSeq)})`)
      send(200, { ok: true, ...result })
      return
    }

    send(404, { ok: false, error: 'not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('warn', `api failed: ${message}`)
    send(500, { ok: false, error: message })
  }
}

/**
 * Mount the control API.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const log = makeLog(ctx)
  const server = ctx.webServer
  if (server === undefined || server === null || typeof server.register !== 'function') {
    log('warn', 'the web server service is unavailable; rewind is not mounted.')
    return
  }

  ctx.effect(() => server.register({
    kind: 'prefix',
    path: `${ROUTE}/api`,
    handler: (req, res) => {
      // A throw here would reach the webserver's request handler, not ours.
      serveApi(req, res, ctx, log).catch((error) => {
        log('warn', `api failed: ${String(error)}`)
      })
    },
  }), 'dsh-rewind: control API')

  log('info', `mounted ${ROUTE}/api`)
}
