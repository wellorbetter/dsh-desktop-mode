/**
 * DSH desktop typing bridge — the in-page half of "click the desktop and type".
 *
 * Windows only delivers keyboard input to the foreground window's input queue,
 * and a WS_CHILD of Explorer's desktop view can never be the foreground window.
 * So while the shell is welded to the desktop it can never receive typing, no
 * matter how it draws a caret. The way out is to leave the desktop layer, take
 * the keyboard for real, and drop back the moment the user is done.
 *
 * tools/bin/dsh-desktop-input.exe performs that transition (~30 ms); this module
 * is what notices that the user wants to type and that they are finished:
 *
 *   pointerdown / focusin on an editable  -> { action: "promote" }
 *   window blur / Escape                  -> { action: "demote" }
 *
 * The daemon answers through window.__dshDesktopTyping.result(...) with what the
 * native helper actually achieved, so "promoted" here means the keyboard really
 * landed on the shell window rather than that a message was sent.
 *
 * Yielding is inherent: this only ever answers a click that landed on the
 * desktop itself, and a demote puts the shell back under the desktop. A stray
 * promotion cannot take the keyboard away from another foreground application —
 * the helper refuses unless the desktop already owns the foreground.
 */
(function () {
  'use strict'
  if (window.__dshDesktopTyping) return

  var BINDING = 'dshDesktopTyping'
  // Bumped whenever this file changes so a probe can tell which build the live
  // document is actually running (a document-start payload is easy to get stale).
  var VERSION = '2026-10-08.1'
  var PROMOTE_DEDUPE_MS = 900
  var BLUR_SETTLE_MS = 240
  var RESULT_GRACE_MS = 1500
  var FOCUS_NEEDS_POINTER_MS = 1200
  var BOTTOM_BAND_PX = 14
  var LOG_LIMIT = 40

  // Autofocus is not an intent to type: the first-run API-key dialog focuses its
  // password field on every page load, and promoting for that would pop the
  // layer out of the desktop with nobody touching the machine. Only a focus that
  // follows a real click counts, so clicks are timestamped here.
  var lastPointerAt = 0

  var state = {
    mode: 'desktop', // 'desktop' | 'promoted'
    pendingPromote: false,
    keyboard: false,
    onDesktopLayer: null,
    lastAction: '',
    lastActionAt: 0,
    lastResult: null,
    lastError: '',
    focusTarget: null,
    events: []
  }

  function note(kind, detail) {
    state.events.push({ at: Date.now(), kind: kind, detail: detail === undefined ? '' : String(detail) })
    if (state.events.length > LOG_LIMIT) state.events.splice(0, state.events.length - LOG_LIMIT)
  }

  function describe(node) {
    if (!node || !node.tagName) return ''
    var text = node.tagName.toLowerCase()
    if (node.type) text += '[' + node.type + ']'
    var placeholder = node.getAttribute && node.getAttribute('placeholder')
    if (placeholder) text += ':' + String(placeholder).slice(0, 24)
    return text
  }

  function isEditable(node) {
    if (!node || node.nodeType !== 1) return false
    var tag = node.tagName
    if (tag === 'TEXTAREA') return node.disabled !== true && node.readOnly !== true
    if (tag === 'INPUT') {
      var type = String(node.type || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'file' || type === 'range' || type === 'color') return false
      return node.disabled !== true && node.readOnly !== true
    }
    if (node.isContentEditable) return true
    var role = node.getAttribute && node.getAttribute('role')
    return role === 'textbox' || role === 'combobox'
  }

  function editableFromEvent(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
    for (var index = 0; index < path.length; index += 1) {
      var node = path[index]
      if (isEditable(node)) return node
    }
    return null
  }

  /**
   * Only act when the launcher really pinned this window into the desktop view.
   *
   * The injected boot flag answers that. Reading the shell's own bridge used to
   * answer it, but every bridge call is gated by an IPC trust list that only
   * accepts origin :3080 — which is why this layer needed a patched copy of the
   * app. The launcher owns the desktop layer now, so nothing here talks to the
   * app at all.
   */
  function shouldHandle() {
    return window.__DSH_DESKTOP_MODE__ === true
  }

  function send(action, detail) {
    var channel = window[BINDING]
    if (typeof channel !== 'function') {
      state.lastError = 'channel-missing'
      note('channel-missing', action)
      return false
    }
    var payload = { action: action }
    if (detail) for (var key in detail) if (Object.prototype.hasOwnProperty.call(detail, key)) payload[key] = detail[key]
    try {
      channel(JSON.stringify(payload))
      state.lastAction = action
      state.lastActionAt = Date.now()
      note('sent', action)
      return true
    } catch (error) {
      state.lastError = String((error && error.message) || error)
      note('send-failed', state.lastError)
      return false
    }
  }

  function refocusTarget() {
    var target = state.focusTarget
    if (!target || target.isConnected === false) return false
    if (document.activeElement === target) return true
    try {
      target.focus({ preventScroll: true })
    } catch (error) {
      try { target.focus() } catch (inner) { return false }
    }
    note('refocus', describe(target) + '=' + (document.activeElement === target))
    return document.activeElement === target
  }

  /**
   * Ask the native side for the keyboard again.
   *
   * The helper grabs the keyboard as part of the promotion; this is the retry for
   * the case where the desktop did not own the foreground at that exact instant.
   * It reports back with kind "focus" so the page can tell a retry from a
   * transition.
   */
  function requestFocusRetry() {
    var channel = window[BINDING]
    if (typeof channel !== 'function') return false
    try {
      channel(JSON.stringify({ action: 'focus', reason: 'after-promote' }))
      note('focus-retry', 'requested')
      return true
    } catch (error) {
      note('focus-retry-failed', String((error && error.message) || error))
      return false
    }
  }

  /** Ask the native side what is actually true now (foreground, focus, parent). */
  function verifyWithNative(reason) {
    var channel = window[BINDING]
    if (typeof channel !== 'function') return false
    try {
      channel(JSON.stringify({ action: 'verify', reason: reason }))
      return true
    } catch (error) {
      return false
    }
  }

  function promote(reason, target) {
    if (!shouldHandle()) return false
    if (target) state.focusTarget = target
    var now = Date.now()
    // A single click produces pointerdown *and* focusin; only one of them may
    // drive a transition, and a window that already left the layer must not ask
    // to leave it twice (each ask is a real native round trip).
    if (state.mode === 'promoted' && document.hasFocus()) {
      note('promote-skipped', reason + ':already-focused')
      return false
    }
    if (state.pendingPromote && now - state.lastActionAt < PROMOTE_DEDUPE_MS) {
      note('promote-skipped', reason + ':in-flight')
      return false
    }
    state.pendingPromote = true
    if (!send('promote', { reason: reason })) {
      state.pendingPromote = false
      return false
    }
    return true
  }

  function demote(reason, unlessRecentMs) {
    if (state.mode !== 'promoted') return false
    if (unlessRecentMs && Date.now() - state.lastActionAt < unlessRecentMs) {
      note('demote-deferred', reason)
      var deferred = reason
      window.setTimeout(function () { demote(deferred, unlessRecentMs) }, BLUR_SETTLE_MS)
      return false
    }
    state.mode = 'demoting'
    return send('demote', { reason: reason })
  }

  function onPointerDown(event) {
    lastPointerAt = Date.now()
    if (!shouldHandle()) return
    var target = editableFromEvent(event)
    if (!target) {
      // Promoted means "a fullscreen window owns the foreground", which is what
      // suppresses an auto-hidden taskbar (the same mechanism games use). So the
      // promotion must not outlive the intent to type: clicking anything that is
      // not a text box puts the layer straight back on the desktop.
      if (state.mode === 'promoted') demote('click-not-editable', 0)
      return
    }
    promote('pointerdown', target)
  }

  function onPointerMove(event) {
    if (state.mode !== 'promoted') return
    if (event.clientY < window.innerHeight - BOTTOM_BAND_PX) return
    // The taskbar is auto-hidden on this machine and only its 2px peek is above
    // our window, so a pointermove this low means the user is reaching for it.
    if (isEditable(event.target) || isEditable(document.activeElement)) return
    demote('reached-bottom-edge', 0)
  }

  function onFocusIn(event) {
    if (!shouldHandle()) return
    var target = editableFromEvent(event)
    if (!target) return
    if (Date.now() - lastPointerAt > FOCUS_NEEDS_POINTER_MS) {
      note('focusin-ignored', describe(target) + ':no-click')
      return
    }
    promote('focusin', target)
  }

  /** A key that means "I am typing", as opposed to a shortcut or a modifier. */
  function isTypingKey(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return false
    if (event.key === 'Backspace' || event.key === 'Delete') return true
    return typeof event.key === 'string' && event.key.length === 1
  }

  function onKeyDown(event) {
    // The IME owns composition keys — including Escape, which cancels a
    // candidate window. keyCode 229 is the legacy composition marker.
    if (event.isComposing === true || event.keyCode === 229) return
    if (state.mode === 'promoted') {
      if (event.key !== 'Escape') return
      var active = document.activeElement
      if (active && typeof active.blur === 'function') {
        try { active.blur() } catch (error) { /* element may already be gone */ }
      }
      demote('escape', 0)
      return
    }
    // Keyboard route into the composer (Tab, or focus kept from before): the
    // first real key is the intent to type. That first key is lost, which is why
    // a click on the composer remains the fast path.
    if (!shouldHandle()) return
    if (isTypingKey(event) && isEditable(document.activeElement)) promote('keydown', document.activeElement)
  }

  var blurTimer = null
  function onWindowBlur() {
    if (state.mode !== 'promoted') return
    if (state.pendingPromote && Date.now() - state.lastActionAt < RESULT_GRACE_MS) {
      // Leaving the desktop layer itself can surface as a blur before the
      // native side confirms the promotion; do not treat that as "user left".
      note('blur-ignored', 'promote-in-flight')
      return
    }
    if (blurTimer) window.clearTimeout(blurTimer)
    blurTimer = window.setTimeout(function () {
      blurTimer = null
      if (document.hasFocus()) { note('blur-ignored', 'focus-returned'); return }
      demote('window-blur', 0)
    }, BLUR_SETTLE_MS)
  }

  function onWindowFocus() {
    if (blurTimer) { window.clearTimeout(blurTimer); blurTimer = null }
  }

  // ---------------------------------------------------------------- results --
  // Called by the daemon once the native helper reported what it achieved.
  function result(payload) {
    if (!payload || typeof payload !== 'object') return null
    state.lastResult = payload
    state.lastError = payload.error ? String(payload.error) : ''
    state.pendingPromote = false
    // A verification is not a transition: it reports what is really true, so a
    // transition that silently failed can never be reported as done.
    if (payload.kind === 'status' || payload.reason === 'status') {
      state.keyboard = payload.keyboard === true
      state.onDesktopLayer = payload.onDesktopLayer === true
      if (state.onDesktopLayer && state.mode === 'promoted') {
        state.mode = 'desktop'
        note('state-corrected', 'the window is back on the desktop layer')
      } else {
        note('verified', 'keyboard=' + state.keyboard)
      }
      return state.mode
    }
    if (payload.kind === 'focus') {
      state.keyboard = payload.foreground === true
      if (state.keyboard) {
        note('verified', 'keyboard=true (retry)')
        note('focus-applied', 'active=' + refocusTarget())
      } else {
        // Promoted without the keyboard is a worse state than the desktop: put
        // the layer back rather than leaving a window that swallows nothing.
        note('focus-failed', 'going back to the desktop layer')
        state.mode = 'promoted'
        demote('focus-failed', 0)
      }
      return state.mode
    }
    if (payload.mode === 'promoted') {
      state.mode = 'promoted'
      note('promoted', 'detached')
      // The native side grabs the keyboard itself; when that did not take, ask it
      // to try again, put the caret back where the user clicked, then ask what is
      // really true.
      if (payload.foreground !== true) requestFocusRetry()
      else note('focus-applied', 'active=' + refocusTarget())
      verifyWithNative('after-promote')
    } else if (payload.mode === 'desktop') {
      state.mode = 'desktop'
      state.keyboard = false
      state.onDesktopLayer = true
      note('demoted', payload.error || 'ok')
    } else {
      state.mode = 'desktop'
      note('promote-refused', payload.error || 'unknown')
    }
    return state.mode
  }

  /**
   * Ask the native side for the real state once the channel is up: whether the
   * window really sits in the desktop view and whether the keyboard is ours. The
   * document-start script can run before the daemon finished installing the
   * binding, hence the short retry.
   */
  function requestInitialState(attempt) {
    if (typeof window[BINDING] !== 'function') {
      // The daemon may attach several seconds after this document started, so
      // keep trying for a while; it also pushes the state on its own once the
      // binding is installed.
      if ((attempt || 0) < 30) window.setTimeout(function () { requestInitialState((attempt || 0) + 1) }, 1000)
      return
    }
    try {
      window[BINDING](JSON.stringify({ action: 'verify', reason: 'module-install' }))
      note('state-requested', 'module-install')
    } catch (error) { /* reported on the next action */ }
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  requestInitialState(0)

  window.__dshDesktopTyping = {
    state: function () {
      return {
        version: VERSION,
        desktopMode: shouldHandle(),
        mode: state.mode,
        keyboard: state.keyboard === true,
        onDesktopLayer: state.onDesktopLayer,
        pendingPromote: state.pendingPromote,
        lastAction: state.lastAction,
        lastResult: state.lastResult,
        lastError: state.lastError,
        focusTarget: describe(state.focusTarget),
        hasFocus: document.hasFocus(),
        channel: typeof window[BINDING] === 'function',
        events: state.events.slice(-12)
      }
    },
    result: result,
    // Manual hooks: used by the tools and by tests, not by the UI.
    promote: function (reason) { return promote(reason || 'manual', document.activeElement) },
    demote: function (reason) { return demote(reason || 'manual', 0) }
  }
})()
// hot-reload probe (fingerprint fix check)
