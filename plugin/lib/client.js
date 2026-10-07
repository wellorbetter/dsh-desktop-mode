/**
 * DSH 桌面模式 —— 插件的 **client 半**（跑在 DSH 页面里，纯浏览器脚本）。
 *
 * 它不再需要任何外部注入：host 半把本文件作为一条路由下发，并在 index.html 里插一行
 * `<script src>`。本文件随后做三件事：
 *
 *  1. 向 host 取 boot 载荷（挂件配置 + 样式 + 配置文件路径）；
 *  2. 把载荷放进 `window.__DSH_DESKTOP_WIDGETS_BOOT__`，再从插件自己的路由加载挂件代码
 *     —— 也就是过去由调试端口注入的那套东西，现在只是普通的网页资源；
 *  3. 若挂件层没能挂上（配置里关掉了、或代码没加载成功），退化成一个自带的小时钟，
 *     保证桌面上总有个时间；同时把真实状态挂在 `window.__dshDesktopMode` 上供诊断。
 *
 * 约定：一切以原生工具与挂件层**回报的事实**为准 —— 这里不缓存"应该已经生效"的假设。
 */
(function () {
  'use strict'
  if (window.__dshDesktopMode) return

  // Client module revision, used only until /boot answers with the package
  // version; `/boot` is the authority so the two can never disagree for long.
  var VERSION = '0.0.2'
  var BASE = '/dsh-desktop-mode'
  var ACTION_URL = BASE + '/action'
  var BLOCK = { left: '14.6%', top: '9.5%' }
  var state = {
    version: VERSION,
    mounted: false,
    boot: null,
    widgetsLoaded: false,
    widgets: null,
    fallbackClock: false,
    host: null,
    lastAction: null,
    palette: 'unknown',
    sample: null,
    lastError: ''
  }
  var clockNodes = null

  // ---------------------------------------------------------------- dom ----
  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function installStyle() {
    if (document.getElementById('dsh-desktop-mode-style')) return
    var style = document.createElement('style')
    style.id = 'dsh-desktop-mode-style'
    style.textContent = [
      '#dsh-desktop-mode{position:fixed;inset:0;z-index:4;pointer-events:none;font-family:inherit}',
      '#dsh-desktop-mode .dshdm-clock{position:fixed;color:#eef3f8;',
      '-webkit-text-stroke:1px rgba(6,12,22,.55);paint-order:stroke fill;',
      'text-shadow:0 2px 18px rgba(0,0,0,.45)}',
      '#dsh-desktop-mode .dshdm-time{font-size:96px;font-weight:300;letter-spacing:.01em;line-height:1}',
      '#dsh-desktop-mode .dshdm-date{font-size:20px;font-weight:500;letter-spacing:.14em;margin-top:10px}',
      '#dsh-desktop-mode .dshdm-weekday{font-size:44px;font-weight:200;letter-spacing:.22em;margin-top:14px}',
      '#dsh-desktop-mode.dshdm-light .dshdm-clock{color:#1b1f24;-webkit-text-stroke:1px rgba(255,255,255,.85);text-shadow:0 2px 16px rgba(255,255,255,.5)}'
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  var DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  function pad(value) { return value < 10 ? '0' + value : String(value) }

  function mountFallbackClock() {
    if (document.getElementById('dsh-desktop-mode') || clockNodes) return
    installStyle()
    var root = el('div')
    root.id = 'dsh-desktop-mode'
    var clock = el('div', 'dshdm-clock')
    clock.style.left = BLOCK.left
    clock.style.top = BLOCK.top
    var time = el('div', 'dshdm-time')
    var date = el('div', 'dshdm-date')
    var weekday = el('div', 'dshdm-weekday')
    clock.appendChild(time)
    clock.appendChild(date)
    clock.appendChild(weekday)
    root.appendChild(clock)
    ;(document.body || document.documentElement).appendChild(root)
    clockNodes = { root: root, clock: clock, time: time, date: date, weekday: weekday }
    state.mounted = true
    state.fallbackClock = true
    tick()
    refreshPalette('fallback-boot')
    window.setInterval(tick, 1000)
    window.setInterval(function () { refreshPalette('fallback-interval') }, 30000)
    window.addEventListener('resize', function () { refreshPalette('fallback-resize') })
  }

  function tick() {
    if (!clockNodes) return
    var now = new Date()
    clockNodes.time.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes())
    clockNodes.date.textContent = now.getDate() + ' ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear()
    clockNodes.weekday.textContent = DAYS[now.getDay()]
  }

  // ------------------------------------------------------------- palette ----
  function mediaElement() {
    var layer = document.querySelector('.we-layer')
    if (!layer) return null
    return layer.querySelector('video, canvas, img')
  }

  function luminanceAt(element, rect) {
    var sourceWidth = element.videoWidth || element.naturalWidth || element.width || element.clientWidth
    var sourceHeight = element.videoHeight || element.naturalHeight || element.height || element.clientHeight
    if (!sourceWidth || !sourceHeight) return null
    var viewportWidth = window.innerWidth || 1
    var viewportHeight = window.innerHeight || 1
    var sx = Math.max(0, Math.round(rect.left / viewportWidth * sourceWidth))
    var sy = Math.max(0, Math.round(rect.top / viewportHeight * sourceHeight))
    var sw = Math.max(1, Math.min(sourceWidth - sx, Math.round(rect.width / viewportWidth * sourceWidth)))
    var sh = Math.max(1, Math.min(sourceHeight - sy, Math.round(rect.height / viewportHeight * sourceHeight)))
    var canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = Math.max(1, Math.round(48 * sh / sw))
    var context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(element, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    var data = context.getImageData(0, 0, canvas.width, canvas.height).data
    var sum = 0
    var count = data.length / 4
    for (var index = 0; index < data.length; index += 4) {
      sum += (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255
    }
    return { mean: sum / count, ok: true }
  }

  /** Only meaningful for the fallback clock; the widget layer does its own. */
  function refreshPalette(reason) {
    if (!clockNodes) return null
    var element = mediaElement()
    if (!element) { state.sample = { ok: false, reason: reason || 'no-wallpaper' }; return null }
    try {
      var rect = clockNodes.clock.getBoundingClientRect()
      var result = luminanceAt(element, rect)
      if (!result) { state.sample = { ok: false, reason: 'no-size' }; return null }
      var palette = result.mean <= 0.45 ? 'dark' : 'light'
      state.sample = { ok: true, mean: Number(result.mean.toFixed(3)), palette: palette, reason: reason || '' }
      if (palette !== state.palette) {
        state.palette = palette
        clockNodes.root.classList.toggle('dshdm-light', palette === 'light')
      }
      return result
    } catch (error) {
      state.sample = { ok: false, reason: String((error && error.message) || error) }
      return null
    }
  }

  // ---------------------------------------------------------------- host ----
  function callAction(action, extra) {
    var body = { action: action }
    if (extra) for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]
    return fetch(ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Desktop-Mode': '1' },
      body: JSON.stringify(body)
    }).then(function (response) { return response.json() }).then(function (payload) {
      state.lastAction = { action: action, payload: payload, at: Date.now() }
      if (payload && payload.error) state.lastError = String(payload.error)
      else if (payload && payload.ok) state.lastError = ''
      return payload
    }, function (error) {
      state.lastAction = { action: action, payload: null, at: Date.now() }
      state.lastError = String((error && error.message) || error)
      return null
    })
  }

  function loadScript(src) {
    return new Promise(function (resolve) {
      var script = document.createElement('script')
      script.src = src
      script.onload = function () { resolve(true) }
      script.onerror = function () { resolve(false) }
      ;(document.head || document.documentElement).appendChild(script)
    })
  }

  function snapshotWidgets() {
    try {
      var api = window.__dshDesktopWidgets
      if (!api || typeof api.state !== 'function') return null
      var snapshot = api.state()
      if (api.contrast) snapshot.contrast = api.contrast()
      return snapshot
    } catch (error) {
      return null
    }
  }

  /**
   * The host side of "the wallpaper changed".
   *
   * The widget layer already watches the wallpaper element in-page, but a scene
   * wallpaper can swap its frames inside the same element, so the host-side id is
   * the reliable signal. Polling one small number is what the old injection
   * daemon did by watching the file; here the page asks the plugin.
   */
  function watchWallpaperId() {
    var last = null
    window.setInterval(function () {
      fetch(BASE + '/wallpaper-id', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.json() })
        .then(function (payload) {
          if (!payload || payload.ok !== true) return
          var id = String(payload.id || '')
          if (last === null) { last = id; return }
          if (id === last) return
          last = id
          try {
            var api = window.__dshDesktopWidgets
            if (api && api.resample) api.resample('plugin-config')
          } catch { /* the widget layer may not be mounted */ }
        })
        .catch(function () { /* host gone: the page keeps its last palette */ })
    }, 3000)
  }

  // --------------------------------------------------------------- boot ----
  function boot() {
    fetch(BASE + '/boot', { headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json() })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error('DSH_DESKTOP_MODE_BOOT_MISSING')
        state.boot = { version: payload.version, configPath: payload.configPath, enabled: payload.config && payload.config.enabled !== false }
        // Exactly the shape the widget code already expects: this is the same
        // payload a debugger used to inject, now simply fetched like any asset.
        window.__DSH_DESKTOP_WIDGETS_BOOT__ = { config: payload.config, css: payload.css }
        return loadScript(BASE + '/widgets.js')
      })
      .then(function (loaded) {
        state.widgetsLoaded = loaded === true
        // The widget layer mounts synchronously; give it one turn before deciding
        // whether the fallback clock is needed.
        window.setTimeout(function () {
          state.widgets = snapshotWidgets()
          if (!state.widgets || state.widgets.mounted !== true) mountFallbackClock()
          else state.mounted = true
        }, 400)
      })
      .catch(function (error) {
        state.lastError = String((error && error.message) || error)
        mountFallbackClock()
      })
    callAction('status').then(function (payload) { state.host = payload })
    watchWallpaperId()
    // The typing trigger is its own asset: load it alongside the widgets so a
    // failure in one never blocks the other.
    loadScript(BASE + '/typing.js').then(function (loaded) {
      state.typingLoaded = loaded === true
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  window.__dshDesktopMode = {
    state: function () {
      state.widgets = snapshotWidgets()
      try { state.typing = window.__dshDesktopTyping ? window.__dshDesktopTyping.state() : null } catch (error) { state.typing = null }
      return state
    },
    /** Diagnostics + next steps: ask the native side directly. */
    action: callAction,
    /**
     * Re-read the configuration and re-render the widget layer in place.
     *
     * The settings page calls this after a save: the widget code applies a whole
     * configuration object (it stops its timers and rebuilds), so re-fetching the
     * boot payload and handing it over is the same path a page load takes.
     */
    reloadWidgets: function (reason) {
      return fetch(BASE + '/boot', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.json() })
        .then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error('DSH_DESKTOP_MODE_BOOT_MISSING')
          state.boot = { version: payload.version, configPath: payload.configPath, enabled: payload.config && payload.config.enabled !== false }
          window.__DSH_DESKTOP_WIDGETS_BOOT__ = { config: payload.config, css: payload.css }
          var api = window.__dshDesktopWidgets
          if (!api || typeof api.apply !== 'function') throw new Error('DSH_DESKTOP_MODE_WIDGETS_MISSING')
          api.apply(payload.config)
          state.widgets = snapshotWidgets()
          state.mounted = state.widgets !== null && state.widgets.mounted === true
          return state.widgets
        })
    },
    resampleWidgets: function (reason) {
      var api = window.__dshDesktopWidgets
      return api && api.resample ? api.resample(reason || 'client-api') : null
    },
    version: (state.boot && state.boot.version) || VERSION
  }
})()
