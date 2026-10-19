// dsh-sqy-rewind — browser half: a rewind button injected into the USER's own action
// row, plus the DOM-side hiding that makes a rewind visible.
//
// WHY THIS IS A DOM INJECTION AND NOT A SLOT
// ------------------------------------------
// ui-chat hard-codes the user message's action row. `UserMessageNodeView` renders
// `MessageIconActions` directly:
//
//   actions: (text) => <MessageIconActions text={text} time={data.time}
//                                          clock="start" t={t} />
//
// and that call site has no `renderSlot`, so no plugin can register into it. The
// assistant row does expose `conversation.chat.assistant-actions`, but the user row
// does not — hence the button is found and extended in the DOM instead.
//
// The row's identity is stable across builds: `MessageIconActions` renders
// `div[data-clock="start"]` for the user side ("end" is the assistant side). The
// CSS class names are hash-mangled per build (e.g. `xD_KDq_action`), so nothing
// here keys off a class name: the row is found by `data-clock`, the copy button by
// position, and the button's *appearance* is inherited by copying whatever
// `className` the copy button actually carries at runtime.
//
// WHY THE BROWSER HIDES TURNS ITSELF
// ----------------------------------
// A Host-side `surfaceOp: { op: 'replace' }` only changes what the MODEL sees. The
// transcript is assembled from append-origin events on purpose (see the official
// comment in dsh-session/lib/types/surface.js), so the nodes the user already saw
// stay exactly where they were. Nothing in the journal protocol can remove them
// either: the client's stream requires contiguous seqs, so a Host that filtered
// shadowed events out of the page/follow window would trip gap repair and fail the
// stream outright.
//
// So the rewound turn range is hidden here, in the DOM, by turn number. The range
// comes from the Host API, which reads it back off the landed marker events — that
// makes the hiding survive a page reload without any client-side state.
//
// The Host's carrier is a `user/message` carrying a `surfaceOp` OBJECT, and
// ui-chat's `messageDefinition.match` only accepts append-origin user messages
// (`event.surfaceOp === "append"`). The carrier therefore produces no message node
// at all and needs no client-side hiding. The corollary matters: the client cannot
// tell from the DOM whether a turn was rewound, so the turn range must keep coming
// from `/api/state`.
//
// A consequence worth knowing: rewinding is NOT reversible. The surface fold drops
// the shadowed nodes for good, so there is no "un-rewind" to offer. That is why the
// button asks for a second click before it does anything.

const ROUTE = '/plugins/dsh-sqy-rewind'

/** The user message's action row (MessageIconActions root, clock="start"). */
const ROW_SELECTOR = 'div[data-clock="start"]'

/**
 * The transcript flow item that wraps one node.
 *
 * `data-chat-flow-kind="user"` is the user's own message; `steering` is a different
 * kind that also renders a user-style bubble, so it is excluded explicitly rather
 * than by accident.
 */
const FLOW_KIND_ATTR = 'data-chat-flow-kind'

/**
 * The enclosing conversation region attribute providing the active session id.
 * Rendered by `ConversationRoot` directly onto `div[data-conversation-session]`.
 */
const SESSION_CONTAINER_ATTR = 'data-conversation-session'

/** Flow kind of a message the user wrote. */
const USER_FLOW_KIND = 'user'

/**
 * Flow kind of a turn's process-disclosure row.
 *
 * The agent loop logs `turn/start` BEFORE the turn's opening prompt, so this
 * row sorts immediately before the turn's user message in the flow. It is the
 * fallback source of a turn number when the user message's own flow item
 * carries none.
 */
const TURN_PROCESS_FLOW_KIND = 'turn-process'

/** Turn number of the flow item that wraps a node, as a decimal string. */
const TURN_ATTR = 'data-chat-turn'

/** Marks a button this half injected, so a sweep never doubles one up. */
const INJECT_ATTR = 'data-dsh-sqy-rewind'

/** Static stylesheet holding the button and tip rules. */
const STYLE_ID = 'dsh-sqy-rewind-style'

/** Stylesheet rewritten on every refresh; its rules hide rewound turns. */
const HIDE_STYLE_ID = 'dsh-sqy-rewind-hide'

/** Safety cap: never emit more than this many turn selectors for one marker. */
const MAX_TURNS_PER_MARK = 500

/**
 * How many times we will ask the Host for a session's rewind marks after first
 * spotting it in the DOM. The first read can race the Host finishing a session
 * load (returns empty), and the one-shot guard would otherwise never retry — which
 * is exactly how a rewound conversation could reappear after a restart. Bounded so
 * it cannot poll forever.
 */
const MAX_REFRESH_ATTEMPTS = 10

/** Minimum gap between two DOM sweeps. */
const SWEEP_MIN_MS = 150

/** How long a result/error tip stays on screen. */
const TIP_MS = 5000

/** Button labels, one per phase. */
const LABELS = {
  idle: '回退到这一轮之前',
  confirm: '再点一次确认回退',
  busy: '正在回退…',
  done: '已回退',
}

/**
 * Button and tip rules.
 *
 * The base geometry is copied from the host's own action row (ui-chat's `.action`
 * block) rather than imported: a plugin may not load a Harness Client package, so
 * the markup, the CSS and the behaviour are copied and only `--dsw-alias-*` /
 * `--dsh-content-font-delta` tokens are referenced. The injected button also copies
 * the copy button's hashed `className` at runtime, which is what makes it follow
 * the theme exactly; these rules are the fallback for when that class is missing,
 * plus the states the host has no rule for.
 *
 * There is deliberately no `svg` sizing rule here: the copied host class already
 * sizes the glyph (15px on the user side) and a rule of our own would race it on
 * equal specificity. The inline `width`/`height` attributes on the SVG cover the
 * fallback case instead.
 */
const CSS = [
  '.dshrw-action{width:calc(28px + var(--dsh-content-font-delta,0px));',
  'height:calc(28px + var(--dsh-content-font-delta,0px));',
  'border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);',
  'cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;',
  'padding:6px;display:inline-flex}',
  'button.dshrw-action[data-confirm]{color:var(--dsw-alias-label-primary);',
  'background:var(--dsw-alias-interactive-bg-hover)}',
  'button.dshrw-action[data-unavailable]{cursor:default;opacity:.4}',
  'button.dshrw-action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}',
  '.dshrw-tip{position:fixed;z-index:2147483000;transform:translateX(-50%);max-width:280px;',
  'padding:6px 10px;border-radius:8px;font-size:12.5px;line-height:1.5;pointer-events:none;',
  'white-space:pre-wrap;background:var(--dsw-alias-bg-layer-3,#2b2b2b);',
  'color:var(--dsw-alias-label-primary,#eee);',
  'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.28));',
  'box-shadow:0 6px 20px rgba(0,0,0,.28)}',
  '.dshrw-tip-error{color:var(--dsw-alias-label-error,#d24a43);',
  'border-color:var(--dsw-alias-label-error,#d24a43)}',
  '.dshrw-tip-confirm{color:var(--dsw-alias-label-secondary,#ccc)}',
].join('')

/** Tip element per button, so a second message replaces the first. */
const tips = new WeakMap()

/** Tip dismissal timer per button. */
const tipTimers = new WeakMap()

/** Throttle for the state read. */
const lastRefresh = { sessionId: null, at: 0 }

/** Last sweep summary logged, so a steady transcript does not spam the console. */
let lastSweepLog = ''

/**
 * Insert one `<style>` element, once.
 * @param id - element id.
 * @param text - stylesheet text.
 * @returns the element.
 */
function ensureStyle(id, text) {
  let style = document.getElementById(id)
  if (style === null) {
    style = document.createElement('style')
    style.id = id
    document.head.appendChild(style)
  }
  if (text !== undefined) style.textContent = text
  return style
}

/**
 * Read one awaited service from an injected owner context.
 *
 * `ctx.get(name)` reads the global store once and races activation, answering
 * `undefined` without saying so — every working client plugin uses the injected
 * owner instead.
 * @param owner - injected owner context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function serviceAt(owner, name) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    // A global-store miss is expected here.
  }
  try {
    return owner === null || owner === undefined ? undefined : owner[name]
  } catch {
    return undefined
  }
}

/**
 * Inline artwork: a counter-clockwise rewind arrow.
 *
 * The harness ships no rewind glyph and a plugin may not import its icon package,
 * so this is our own SVG. The `viewBox` is 24x24 while the rendered box is 15px on
 * the user side: the copied host class sizes the element, and the `width`/`height`
 * attributes only matter when that class is missing.
 * @returns the SVG element.
 */
function rewindIcon() {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '15')
  svg.setAttribute('height', '15')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const arc = document.createElementNS(NS, 'path')
  arc.setAttribute('d', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8')
  const head = document.createElementNS(NS, 'path')
  head.setAttribute('d', 'M3 3v5h5')
  svg.appendChild(arc)
  svg.appendChild(head)
  return svg
}

/**
 * Drop a button's tip, if it has one.
 * @param anchor - the button.
 */
function hideTip(anchor) {
  const timer = tipTimers.get(anchor)
  if (timer !== undefined) {
    clearTimeout(timer)
    tipTimers.delete(anchor)
  }
  const tip = tips.get(anchor)
  if (tip !== undefined) {
    tips.delete(anchor)
    tip.remove()
  }
}

/**
 * Show one short message under a button.
 *
 * Used for the confirm prompt, the success note and — most importantly — the Host's
 * error text: a failed rewind must say why, and a `title` alone is invisible until
 * the pointer happens to rest on the button.
 *
 * The confirm prompt is the only tip that never expires on its own: pressing
 * anywhere else closes it, so the question stays on screen until it is answered.
 * The informational tips still fade after {@link TIP_MS}.
 * @param anchor - the button to sit under.
 * @param text - the message.
 * @param kind - `confirm`, `ok` or `error`.
 */
function showTip(anchor, text, kind) {
  hideTip(anchor)
  const tip = document.createElement('div')
  tip.className = `dshrw-tip dshrw-tip-${kind}`
  tip.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  tip.textContent = text
  document.body.appendChild(tip)
  const rect = anchor.getBoundingClientRect()
  const left = Math.max(150, Math.min(rect.left + rect.width / 2, window.innerWidth - 150))
  tip.style.left = `${String(left)}px`
  tip.style.top = `${String(Math.max(8, rect.bottom + 8))}px`
  tips.set(anchor, tip)
  if (kind !== 'confirm') {
    tipTimers.set(anchor, setTimeout(() => {
      tips.delete(anchor)
      tipTimers.delete(anchor)
      tip.remove()
    }, TIP_MS))
  }
}

/**
 * Hide every turn in the given session's markers.
 *
 * Scoped strictly to `[data-conversation-session="<id>"] [data-chat-turn="<turn>"]`
 * so that hiding turns in one conversation NEVER bleeds into or hides turns in other
 * conversations sharing the DOM or across session switches.
 * @param marks - `{ fromTurn, toTurn }` entries from the Host.
 * @param sessionId - target session id.
 * @param runtime - shared runtime state; stores `marksBySession`.
 */
function applyHidden(marks, sessionId, runtime) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (runtime !== undefined && runtime !== null) {
    if (!runtime.marksBySession) runtime.marksBySession = new Map()
    runtime.marksBySession.set(sessionId, marks)
  }
  const selectors = []
  if (runtime && runtime.marksBySession) {
    for (const [sId, sMarks] of runtime.marksBySession.entries()) {
      for (const mark of sMarks) {
        const from = mark?.fromTurn
        const to = mark?.toTurn
        if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) continue
        const last = Math.min(to, from + MAX_TURNS_PER_MARK - 1)
        for (let turn = from; turn <= last; turn++) {
          selectors.push(`[${SESSION_CONTAINER_ATTR}="${sId}"] [${TURN_ATTR}="${String(turn)}"]`)
        }
      }
    }
  }
  const style = ensureStyle(HIDE_STYLE_ID)
  style.textContent = selectors.length === 0
    ? ''
    : `${selectors.join(',')}{display:none !important}`
}

/**
 * Re-read the landed markers and re-apply the hiding rules for a session.
 * @param runtime - shared runtime state.
 * @param sessionId - session to refresh.
 * @param force - skip the one-second throttle.
 */
function refreshHidden(runtime, sessionId, force) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const now = Date.now()
  if (force !== true && lastRefresh.sessionId === sessionId && now - lastRefresh.at < 1000) return
  lastRefresh.sessionId = sessionId
  lastRefresh.at = now
  fetch(`${ROUTE}/api/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data === null || data === undefined || typeof data !== 'object') return
      applyHidden(Array.isArray(data.marks) ? data.marks : [], sessionId, runtime)
    })
    .catch(() => {
      // The Host route is gone; leave the transcript as it is.
    })
}

/**
 * The turn number of the flow item wrapping an element.
 *
 * `turnOf$1(node)` only answers on nodes whose location is a turn or a step, so a
 * node without a numbered turn is not rewound — there is no turn to rewind TO, and
 * guessing one would cut the history in the wrong place.
 * @param element - any node inside the transcript.
 * @returns the turn, or null when this node is outside a numbered turn.
 */
function turnOf(element) {
  const holder = element.closest(`[${TURN_ATTR}]`)
  if (holder === null) return null
  const raw = holder.getAttribute(TURN_ATTR)
  if (raw === null || raw === '') return null
  const turn = Number(raw)
  return Number.isSafeInteger(turn) ? turn : null
}

/**
 * The turn number of the turn-process row that precedes a user message.
 *
 * A user message's own flow item carries `data-chat-turn` only when the engine
 * resolves the node inside a numbered turn. When it does not (React omits the
 * attribute entirely), the turn-process disclosure row directly before it
 * still carries the right number: `turn/start` is logged before the turn's
 * prompt, so that neighbour belongs to the same turn.
 *
 * Only the NEAREST preceding row that carries a turn number is consulted, and
 * only when it is a turn-process row. Anything else means this message does
 * not open a turn, and guessing would cut the history in the wrong place.
 * @param row - the `div[data-clock="start"]`.
 * @returns the turn, or null when no such neighbour carries one.
 */
function turnFromSiblings(row) {
  const flow = row.closest(`[${FLOW_KIND_ATTR}]`)
  let sibling = flow === null ? null : flow.previousElementSibling
  while (sibling !== null) {
    const raw = sibling.getAttribute(TURN_ATTR)
    if (raw !== null && raw !== '') {
      if (sibling.getAttribute(FLOW_KIND_ATTR) !== TURN_PROCESS_FLOW_KIND) return null
      const turn = Number(raw)
      return Number.isSafeInteger(turn) ? turn : null
    }
    sibling = sibling.previousElementSibling
  }
  return null
}

/**
 * The turn a row belongs to: the row's own attribute first, its turn-process
 * neighbour second, the number captured when the button was built last.
 * @param row - the `div[data-clock="start"]`.
 * @param fallback - the turn the button was created with, if any.
 * @returns the turn, or null when no source has one.
 */
function resolveTurn(row, fallback) {
  return turnOf(row) ?? turnFromSiblings(row) ?? fallback ?? null
}

/**
 * The ancestor of `node` that is a direct child of `root`.
 *
 * The copy button is wrapped in a Tooltip, and whether that wrapper is an element
 * or a fragment is an implementation detail of a package this plugin cannot read.
 * Walking up to the row's own child level means the new button lands as a sibling
 * of the copy control — not inside its tooltip.
 * @param root - the action row.
 * @param node - a descendant of the row.
 * @returns the direct child, or null when `node` is not inside `root`.
 */
function directChildOf(root, node) {
  let current = node
  while (current !== null && current.parentElement !== root) current = current.parentElement
  return current
}

/**
 * Turn the client's session list into a plain array of rows.
 * @param byId - the list snapshot's `byId`, as a Map or a plain object.
 * @returns the rows.
 */
function listRows(byId) {
  if (byId === null || byId === undefined) return []
  try {
    if (typeof byId.get === 'function' && typeof byId.values === 'function') {
      return Array.from(byId.values())
    }
  } catch {
    // Not a Map; fall through to the object form.
  }
  if (typeof byId !== 'object') return []
  return Object.values(byId)
}

/**
 * The session the message element belongs to.
 *
 * First checks the DOM ancestor `[data-conversation-session]`, which DSH renders
 * on ConversationRoot. If absent, falls back to the client `sessions` service.
 * @param element - any element inside the message or transcript.
 * @param runtime - shared runtime state.
 * @returns the session id, or null.
 */
function resolveSessionId(element, runtime) {
  if (element && typeof element.closest === 'function') {
    const container = element.closest(`[${SESSION_CONTAINER_ATTR}]`)
    const fromDom = container?.getAttribute(SESSION_CONTAINER_ATTR)
    if (typeof fromDom === 'string' && fromDom.length > 0) {
      return fromDom
    }
  }

  const sessions = runtime?.sessions
  if (sessions === null || sessions === undefined) return null
  let snapshot = null
  try {
    const list = sessions.list
    if (list !== null && list !== undefined && typeof list.getSnapshot === 'function') {
      snapshot = list.getSnapshot()
    }
  } catch {
    return null
  }
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return null
  const rows = listRows(snapshot.byId)
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.id !== 'string' || row.id === '') continue
    const retained = row.retainedBy
    const main = retained === null || retained === undefined ? 0 : retained.mainView
    if (typeof main === 'number' && main > 0) return row.id
  }
  if (rows.length === 1) {
    const only = rows[0]
    if (only !== null && typeof only === 'object' && typeof only.id === 'string' && only.id !== '') {
      return only.id
    }
  }
  return null
}

/**
 * Build one rewind button for one action row.
 *
 * The phase lives in this closure: the button is a plain element, not a React
 * component, so the state machine is three variables and a timer.
 * @param row - the `div[data-clock="start"]` this button belongs to.
 * @param copy - the row's copy button, whose class the new button inherits.
 * @param turn - the numbered turn this row belongs to.
 * @param runtime - shared runtime state.
 * @returns the button element.
 */
function createRewindButton(row, copy, turn, runtime) {
  const button = document.createElement('button')
  button.type = 'button'
  const inherited = typeof copy.className === 'string' ? copy.className.trim() : ''
  button.className = inherited === '' ? 'dshrw-action' : `${inherited} dshrw-action`
  button.setAttribute(INJECT_ATTR, '1')
  button.appendChild(rewindIcon())

  let phase = 'idle'
  let outsideHandler = null

  const stopOutside = () => {
    if (outsideHandler !== null) {
      document.removeEventListener('pointerdown', outsideHandler, true)
      outsideHandler = null
    }
  }

  /**
   * Dismiss the prompt on the next press anywhere else.
   *
   * A capture-phase `pointerdown` runs before the click that would otherwise land
   * on whatever was pressed, so the prompt is gone before that element reacts.
   */
  const startOutside = () => {
    stopOutside()
    outsideHandler = (event) => {
      // The row can be re-rendered away while the prompt is open; drop the
      // listener instead of answering for a detached button.
      if (!button.isConnected) {
        stopOutside()
        return
      }
      // The button itself is exempt: pressing it again is the confirm gesture.
      if (button.contains(event.target)) return
      setPhase('idle')
    }
    document.addEventListener('pointerdown', outsideHandler, true)
  }

  const setPhase = (next) => {
    phase = next
    const label = LABELS[next]
    button.title = label
    button.setAttribute('aria-label', label)
    if (next === 'confirm') button.setAttribute('data-confirm', '')
    else button.removeAttribute('data-confirm')
    const unavailable = next === 'busy' || next === 'done'
    if (unavailable) button.setAttribute('data-unavailable', '')
    else button.removeAttribute('data-unavailable')
    button.disabled = unavailable
    hideTip(button)
    if (next === 'confirm') {
      // The prompt never expires on its own: pressing anywhere else closes it.
      showTip(button, label, 'confirm')
      startOutside()
    } else {
      stopOutside()
    }
  }

  const fail = (message) => {
    console.warn('dsh-sqy-rewind: rewind failed:', message)
    setPhase('idle')
    showTip(button, message, 'error')
  }

  const run = () => {
    const sessionId = resolveSessionId(row, runtime)
    if (sessionId === null) {
      fail('读不到当前会话，无法回退')
      return
    }
    // Re-read the turn: the row is a live DOM node and the attribute is the only
    // authority on which turn this button belongs to.
    const target = resolveTurn(row, turn)
    runtime.sessionId = sessionId
    setPhase('busy')
    fetch(`${ROUTE}/api/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, turn: target }),
    })
      .then((response) => response.json()
        .catch(() => null)
        .then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || data === null || data.ok === false) {
          const message = data !== null && typeof data.error === 'string' ? data.error : '回退失败'
          throw new Error(message)
        }
        // Accumulate rather than replace: an earlier rewind's range must stay
        // hidden until the next `/api/state` read confirms the full set.
        const from = data.fromTurn
        const to = data.toTurn
        if (Number.isInteger(from) && Number.isInteger(to) && to >= from) {
          const prev = runtime.marksBySession?.get(sessionId) || []
          applyHidden(prev.concat([{ fromTurn: from, toTurn: to }]), sessionId, runtime)
        }
        setPhase('done')
        showTip(button, '已回退这一轮对话', 'ok')
        refreshHidden(runtime, sessionId, true)
      })
      .catch((error) => {
        fail(error instanceof Error ? error.message : String(error))
      })
  }

  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (phase === 'busy' || phase === 'done') return
    if (phase === 'confirm') {
      run()
      return
    }
    setPhase('confirm')
  })

  setPhase('idle')
  return button
}

/**
 * Put one button into every user action row that lacks one.
 *
 * The turn number comes from the row's own `data-chat-turn` when the engine
 * put one there; otherwise from the turn-process row before it. The number is
 * written back onto the row's flow item either way, so the rewind-hiding rules
 * can reach a user message whose flow item carried no turn of its own.
 *
 * Rows that are not the user's own message are skipped outright: a steering
 * row renders the same chrome but is not a turn the user can rewind to.
 * @param runtime - shared runtime state.
 */
function injectButtons(runtime) {
  const rows = document.querySelectorAll(ROW_SELECTOR)
  const skipped = {}
  let present = 0
  const note = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  for (const row of rows) {
    if (row.querySelector(`[${INJECT_ATTR}]`) !== null) {
      present += 1
      continue
    }
    const flow = row.closest(`[${FLOW_KIND_ATTR}]`)
    const kind = flow === null ? null : flow.getAttribute(FLOW_KIND_ATTR)
    if (kind !== USER_FLOW_KIND) {
      note(`kind:${String(kind)}`)
      continue
    }
    let turn = turnOf(row)
    if (turn === null) {
      turn = turnFromSiblings(row)
      if (turn !== null && flow !== null && flow.getAttribute(TURN_ATTR) === null) {
        flow.setAttribute(TURN_ATTR, String(turn))
      }
    }
    if (turn === null) {
      note('noTurn')
      continue
    }
    // The row's first button is the copy control: on the user side the clock is a
    // span and `onBranch` / `extraActions` are not passed at all.
    const copy = row.querySelector('button')
    if (copy === null) {
      note('noButton')
      continue
    }
    const anchor = directChildOf(row, copy)
    if (anchor === null) continue
    anchor.insertAdjacentElement('afterend', createRewindButton(row, copy, turn, runtime))
    present += 1
  }
  reportSweep(rows.length, present, skipped)
}

/**
 * Log one line per sweep, but only when the picture changed.
 *
 * The sweep runs on every transcript mutation, so without the change guard the
 * console would be unusable. When a rewind button never appears, this line is
 * the whole diagnosis: how many rows were seen, how many carry a button, and
 * why the rest were skipped.
 * @param rows - rows found this sweep.
 * @param present - rows carrying a rewind button after this sweep.
 * @param skipped - skip reasons and their counts.
 */
function reportSweep(rows, present, skipped) {
  const parts = Object.keys(skipped).sort().map((key) => `${key}=${String(skipped[key])}`)
  const line = `dsh-sqy-rewind: sweep rows=${String(rows)} with=${String(present)}` +
    (parts.length === 0 ? '' : ` skipped ${parts.join(' ')}`)
  if (line !== lastSweepLog) {
    lastSweepLog = line
    console.log(line)
  }
}

/**
 * Follow visible sessions and refresh the hiding rules.
 * @param runtime - shared runtime state.
 */
function syncSession(runtime) {
  // Find all active/rendered session containers in the DOM
  const rendered = document.querySelectorAll(`[${SESSION_CONTAINER_ATTR}]`)
  const seenSessions = new Set()
  for (const el of rendered) {
    const sId = el.getAttribute(SESSION_CONTAINER_ATTR)
    if (typeof sId === 'string' && sId.length > 0) {
      seenSessions.add(sId)
    }
  }

  // Also check the main view session from client service as fallback
  const mainId = resolveSessionId(null, runtime)
  if (mainId !== null) seenSessions.add(mainId)

  // A freshly reopened session may not be "live" in the Host the first time we
  // sweep it, so the first /api/state read can come back empty and leave the
  // rewound turns visible. Re-attempt (cheap, throttled, bounded) until every
  // seen session has had enough chances for the Host to answer.
  let pending = false
  for (const sId of seenSessions) {
    const attempts = runtime.refreshAttempts.get(sId) || 0
    if (attempts >= MAX_REFRESH_ATTEMPTS) continue
    runtime.refreshAttempts.set(sId, attempts + 1)
    refreshHidden(runtime, sId, true)
    pending = true
  }

  if (pending && runtime.refreshTimer === null) {
    runtime.refreshTimer = setTimeout(() => {
      runtime.refreshTimer = null
      syncSession(runtime)
    }, 1200)
  }
}

/**
 * Watch the document and keep the injected buttons and hidden nodes in place.
 *
 * A MutationObserver is the only mechanism that survives what React does to this
 * subtree: the transcript re-renders on every streamed event, pages older turns in,
 * and swaps sessions. The observer's callback is coalesced and then throttled, so a
 * busy transcript still costs at most a handful of sweeps per second.
 *
 * Sweeps are idempotent by construction: a row that already contains an injected
 * button is skipped. If React ever discards an injected button while keeping the
 * row, the marker attribute goes with the button, so the next sweep puts it back.
 * That is why the marker lives on the button rather than on the row: a marker on
 * the row would make a discarded button permanently unrecoverable.
 * @param runtime - shared runtime state.
 * @returns `{ kick, stop }`; `kick` schedules a sweep, `stop` tears the observer down.
 */
function startInjection(runtime) {
  let timer = null
  let lastAt = 0

  const sweep = () => {
    injectButtons(runtime)
    syncSession(runtime)
  }

  const kick = () => {
    if (timer !== null) return
    const delay = Math.max(16, SWEEP_MIN_MS - (Date.now() - lastAt))
    timer = setTimeout(() => {
      timer = null
      lastAt = Date.now()
      try {
        sweep()
      } catch (error) {
        console.warn('dsh-sqy-rewind: DOM sweep failed', error)
      }
    }, delay)
  }

  let observer = null
  const root = document.body === null ? document.documentElement : document.body
  if (root !== null && typeof MutationObserver === 'function') {
    observer = new MutationObserver(kick)
    // `data-chat-turn` is watched on its own because a row can be re-rendered with
    // its turn number attached after the fact; nothing else about an existing row
    // can change whether it deserves a button.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [TURN_ATTR, FLOW_KIND_ATTR],
    })
  }
  sweep()

  return {
    kick,
    stop: () => {
      if (observer !== null) {
        try {
          observer.disconnect()
        } catch {
          // Already disconnected.
        }
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/**
 * Wire the browser half.
 *
 * No static `inject` on this plugin object: a profile missing the service would
 * leave the fiber PENDING and `apply` would never run. The DOM injection itself
 * needs no service at all, so it starts unconditionally; the `sessions` service is
 * only needed to turn a clicked row into a session id, and is fetched with the
 * dynamic `ctx.inject(deps, callback)` form every working client plugin uses.
 * @param ctx - client plugin context.
 */
exports.apply = function apply(ctx) {
  try {
    if (typeof document === 'undefined' || document.body === null) return

    ensureStyle(STYLE_ID, CSS)
    ensureStyle(HIDE_STYLE_ID, '')

    const runtime = {
      sessions: null,
      sessionId: null,
      marksBySession: new Map(),
      loadedSessions: new Set(),
      refreshAttempts: new Map(),
      refreshTimer: null
    }
    const injection = startInjection(runtime)

    if (ctx !== null && ctx !== undefined && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['sessions'], (owner) => {
          try {
            const sessions = serviceAt(owner, 'sessions')
            if (sessions === null || sessions === undefined) return
            runtime.sessions = sessions
            // The service may arrive with no DOM change to follow it, so the sweep
            // that resolves the session id has to be asked for explicitly.
            injection.kick()
          } catch (error) {
            console.warn('dsh-sqy-rewind: sessions service unavailable', error)
          }
        })
      } catch (error) {
        console.warn('dsh-sqy-rewind: sessions injection failed', error)
      }
    }

    if (runtime.sessions === null) {
      const direct = serviceAt(ctx, 'sessions')
      if (direct !== null && direct !== undefined) runtime.sessions = direct
    }

    if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
      try {
        // The effect body runs NOW and must RETURN the teardown. Running the
        // teardown here instead would stop the injection in the same tick that
        // started it: on a fresh page load the transcript has not rendered yet,
        // the first sweep finds no rows, and the observer is gone before any row
        // ever appears — the button would never come back.
        ctx.effect(() => () => {
          if (runtime.refreshTimer !== null) {
            clearTimeout(runtime.refreshTimer)
            runtime.refreshTimer = null
          }
          injection.stop()
        }, 'dsh-sqy-rewind: injected user-action button')
      } catch (error) {
        console.warn('dsh-sqy-rewind: teardown not registered', error)
      }
    }
  } catch (error) {
    console.warn('dsh-sqy-rewind: wiring failed', error)
  }
}
