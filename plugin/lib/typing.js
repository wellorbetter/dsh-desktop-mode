/**
 * DSH 桌面模式 —— **打字触发**（client 半的一部分，纯浏览器脚本）。
 *
 * Windows 只把键盘送给前台窗口所在线程的输入队列，而贴在 Explorer 桌面里的子窗口
 * 永远不可能成为前台窗口 —— 所以"在桌面上打字"这件事必须**离开桌面层**才能拿到键盘。
 * 那段切换（SetParent / 抢键盘 / 冻屏遮罩 / 贴回）由原生工具完成，本文件只负责判断
 * 用户什么时候想打字、什么时候打完了：
 *
 *   输入框上的 pointerdown / focusin  → 请求提升（promote）
 *   窗口失焦 / Esc / 点到非输入区 / 鼠标移到底边 → 请求退回（demote）
 *
 * 与旧版的区别：不再经过调试端口与 CDP binding，而是直接 POST 插件自己的路由；
 * 状态一律以原生工具回报的事实为准 —— 提升后若键盘没到手，会先请求一次 focus 重试，
 * 仍失败就把窗口退回桌面层，而不是留一个"看着能打字其实打不了"的窗口。
 */
;(function () {
  'use strict'
  if (window.__dshDesktopTyping) return

  var VERSION = '2026-10-08.2'
  var ACTION_URL = '/dsh-desktop-mode/action'
  var PROMOTE_DEDUPE_MS = 900
  var BLUR_SETTLE_MS = 240
  var RESULT_GRACE_MS = 1500
  var FOCUS_NEEDS_POINTER_MS = 1200
  var BOTTOM_BAND_PX = 14
  var LOG_LIMIT = 40

  var lastPointerAt = 0
  var blurTimer = null

  var state = {
    mode: 'desktop',
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
      if (isEditable(path[index])) return path[index]
    }
    return null
  }

  /**
   * Only the desktop shell has a desktop layer to leave. A browser tab loading the
   * same plugin must never try to leave anything — and this is a plain property
   * read, so it does not depend on the app's IPC trust list.
   */
  function shouldHandle() {
    try {
      if (window.__DSH_DESKTOP_MODE__ === true) return true
      return Boolean(window.desktopWindow && window.desktopWindow.isDesktop === true)
    } catch (error) {
      return false
    }
  }

  function action(name, extra) {
    var body = { action: name }
    if (extra) for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]
    state.lastAction = name
    state.lastActionAt = Date.now()
    note('sent', name)
    return fetch(ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) { return response.json() }).then(function (payload) {
      state.lastResult = payload
      state.lastError = payload && payload.error ? String(payload.error) : ''
      return payload
    }, function (error) {
      state.lastError = String((error && error.message) || error)
      note('send-failed', state.lastError)
      return null
    })
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

  function afterPromote(payload) {
    state.mode = 'promoted'
    if (payload && payload.foreground === true) {
      note('focus-applied', 'active=' + refocusTarget())
      return verify()
    }
    note('focus-retry', 'the helper did not hold the keyboard yet')
    return action('focus').then(function (focusResult) {
      if (focusResult && focusResult.foreground === true) {
        state.keyboard = true
        note('verified', 'keyboard=true (retry)')
        note('focus-applied', 'active=' + refocusTarget())
        return verify()
      }
      // Promoted without the keyboard is worse than the desktop: go back rather
      // than leave a window that swallows nothing.
      note('focus-failed', 'going back to the desktop layer')
      return demote('focus-failed', 0)
    })
  }

  function verify() {
    return action('status').then(function (payload) {
      if (!payload) return state.mode
      state.keyboard = payload.keyboard === true
      state.onDesktopLayer = payload.onDesktopLayer === true
      if (state.onDesktopLayer && state.mode === 'promoted') {
        state.mode = 'desktop'
        note('state-corrected', 'the window is back on the desktop layer')
      } else {
        note('verified', 'keyboard=' + state.keyboard)
      }
      return state.mode
    })
  }

  function promote(reason, target) {
    if (!shouldHandle()) return Promise.resolve(false)
    if (target) state.focusTarget = target
    var now = Date.now()
    if (state.mode === 'promoted' && document.hasFocus()) {
      note('promote-skipped', reason + ':already-focused')
      return Promise.resolve(false)
    }
    if (state.pendingPromote && now - state.lastActionAt < PROMOTE_DEDUPE_MS) {
      note('promote-skipped', reason + ':in-flight')
      return Promise.resolve(false)
    }
    state.pendingPromote = true
    return action('promote', { reason: reason }).then(function (payload) {
      state.pendingPromote = false
      if (payload && payload.mode === 'promoted') return afterPromote(payload)
      state.mode = 'desktop'
      note('promote-refused', (payload && payload.error) || 'unknown')
      return false
    })
  }

  function demote(reason, unlessRecentMs) {
    if (state.mode !== 'promoted') return Promise.resolve(false)
    if (unlessRecentMs && Date.now() - state.lastActionAt < unlessRecentMs) {
      note('demote-deferred', reason)
      return new Promise(function (resolve) {
        window.setTimeout(function () { resolve(demote(reason, unlessRecentMs)) }, BLUR_SETTLE_MS)
      })
    }
    state.mode = 'demoting'
    return action('demote', { reason: reason }).then(function (payload) {
      state.mode = 'desktop'
      state.keyboard = false
      state.onDesktopLayer = true
      note('demoted', (payload && payload.error) || 'ok')
      return true
    })
  }

  // ------------------------------------------------------------- listeners --
  function onPointerDown(event) {
    lastPointerAt = Date.now()
    if (!shouldHandle()) return
    var target = editableFromEvent(event)
    if (!target) {
      if (state.mode === 'promoted') demote('click-not-editable', 0)
      return
    }
    promote('pointerdown', target)
  }

  function onFocusIn(event) {
    if (!shouldHandle()) return
    var target = editableFromEvent(event)
    if (!target) return
    // Autofocus is not an intent to type (the first-run dialog focuses its key
    // field on every load): only a focus that follows a real click counts.
    if (Date.now() - lastPointerAt > FOCUS_NEEDS_POINTER_MS) {
      note('focusin-ignored', describe(target) + ':no-click')
      return
    }
    promote('focusin', target)
  }

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
    if (!shouldHandle()) return
    if (isTypingKey(event) && isEditable(document.activeElement)) promote('keydown', document.activeElement)
  }

  function onPointerMove(event) {
    if (state.mode !== 'promoted') return
    if (event.clientY < window.innerHeight - BOTTOM_BAND_PX) return
    // The taskbar is auto-hidden on this machine and only its 2px peek is above
    // our window, so a pointermove this low means the user is reaching for it.
    if (isEditable(event.target) || isEditable(document.activeElement)) return
    demote('reached-bottom-edge', 0)
  }

  function onWindowBlur() {
    if (state.mode !== 'promoted') return
    if (state.pendingPromote && Date.now() - state.lastActionAt < RESULT_GRACE_MS) {
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

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  // Learn the real state once, instead of assuming the layer is where we left it.
  window.setTimeout(function () { if (shouldHandle()) verify() }, 1500)

  window.__dshDesktopTyping = {
    version: VERSION,
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
        events: state.events.slice(-12)
      }
    },
    // Manual hooks: used by the tools and by tests, not by the UI.
    promote: function (reason) { return promote(reason || 'manual', document.activeElement) },
    demote: function (reason) { return demote(reason || 'manual', 0) },
    verify: verify
  }
})()
